/**
 * The only writer of knowledge rows (ADR-0023).
 *
 * `vault/*.md` is the truth, `memories` is an index of it, and this is the one
 * function that moves one to the other. Keeping it single means the two directions
 * cannot disagree: "the index says a section the file does not have" cannot happen
 * after a sync.
 *
 * Four properties the implementation is built around:
 *
 *  - **Idempotent.** An unchanged section is not re-embedded: the sync compares the
 *    rendered text with the stored text and does nothing when they match. A second
 *    run over an untouched vault costs zero embedding calls.
 *  - **In place.** A changed section is updated by id (`updateEmbedding`), not
 *    deleted and re-inserted. That keeps the row's age and strength stable, so an
 *    edit to one section does not refresh the whole page in the ranking.
 *  - **Adoption instead of duplication.** v0.6 `wiki-ingest` wrote one row per
 *    section with `wiki:<page>` + `section:<n>` tags. A new sync on such a vault
 *    would otherwise double every section; the adopt step claims those rows and
 *    relabels them.
 *  - **Deletes are soft.** A bad save must be recoverable; `db compact --purge` is
 *    the explicit way to make a removal final.
 */
import path from "node:path";
import type { KnowledgeEdge, Memory, MemoryInput } from "../types.js";
import type { VectorStore } from "../store/interface.js";
import type { EmbeddingProvider } from "../embedding/provider.js";
import { loadPages, vaultDir, type Page } from "../graph.js";
import { resolveProject } from "../project.js";
import { resolveScopeKeys } from "../scope.js";
import {
  DEFAULT_MIN_SECTION_CHARS,
  renderSectionText,
  splitKnowledgeSections
} from "./sections.js";

export interface SyncKnowledgeDeps {
  store: VectorStore;
  embedder: EmbeddingProvider;
}

export interface SyncKnowledgeOptions {
  /** Vault root; defaults to `vaultDir()`. */
  dir?: string;
  /** Partition to index into; defaults to this user's shared layer. */
  namespace?: string;
  /** Project label for new rows; defaults to the resolved current project. */
  project?: string | null;
  /** Report what would change without writing or embedding anything. */
  dryRun?: boolean;
  maxSections?: number;
  minChars?: number;
}

export interface SyncKnowledgeReport {
  dir: string;
  namespace: string;
  project: string | null;
  dryRun: boolean;
  pages: number;
  sections: number;
  inserted: number;
  updated: number;
  unchanged: number;
  removed: number;
  adopted: number;
  pagesRemoved: number;
  dangling: number;
  edges: number;
  /** Embedding *calls*, not embedded sections: the sync batches. */
  embedCalls: number;
}

interface PlannedSection {
  key: string;
  text: string;
  row: Memory | null;
  /** Text is new or changed, so this section needs a vector. */
  needsEmbed: boolean;
  /** Text is the same but the row's identity columns are stale. */
  relabelOnly: boolean;
  adopted: boolean;
}

interface PlannedPage {
  id: string;
  title: string;
  sections: PlannedSection[];
  links: KnowledgeEdge[];
  /** Rows this page owned whose section is gone from the file. */
  orphaned: Memory[];
}

/** `slug:` wins over the path, so renaming a file does not orphan its sections. */
function pageIdOf(page: Page): string {
  const slug = page.slug.trim();
  return slug.length > 0 ? slug : page.id;
}

const baseName = (id: string): string => id.slice(id.lastIndexOf("/") + 1);

/** The v0.6 marker: `wiki:<page>` in a row's tags. */
function legacyTag(tags: string[] | undefined, pageId: string): boolean {
  return (tags ?? []).includes(`wiki:${pageId}`);
}

/** `section:<n>` tag → zero-based position, or null when absent/malformed. */
function sectionOrder(tags: string[] | undefined): number | null {
  for (const tag of tags ?? []) {
    const m = tag.match(/^section:(\d+)$/);
    if (m) {
      const n = Number(m[1]) - 1;
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
  }
  return null;
}

/** Exact id, then a unique basename; ambiguous targets stay unresolved on purpose. */
function resolveLink(target: string, byId: Map<string, string>, byBase: Map<string, string[]>): string | null {
  if (byId.has(target)) return target;
  const hits = byBase.get(baseName(target)) ?? [];
  return hits.length === 1 ? hits[0]! : null;
}

export async function syncKnowledge(
  deps: SyncKnowledgeDeps,
  opts: SyncKnowledgeOptions = {}
): Promise<SyncKnowledgeReport> {
  const { store, embedder } = deps;
  const dir = path.resolve(opts.dir ?? vaultDir());
  const namespace = opts.namespace ?? resolveScopeKeys({ scope: "shared" })[0]!;
  const project = opts.project !== undefined ? opts.project : resolveProject().project;
  const dryRun = opts.dryRun === true;

  const pages = await loadPages(dir);
  const byId = new Map(pages.map((p) => [pageIdOf(p), pageIdOf(p)]));
  const byBase = new Map<string, string[]>();
  for (const id of byId.keys()) {
    byBase.set(baseName(id), [...(byBase.get(baseName(id)) ?? []), id]);
  }

  // One read of the partition, grouped by page: the sync needs every existing
  // knowledge row anyway, and per-page queries would make it O(pages) round trips.
  // Vectors are skipped — this pass only reads ids, section keys and tags, and
  // attaching embeddings here was pure copying (ADR-0030).
  const listed = await store.list({ namespace, limit: 100_000, withVectors: false });
  const existingByPage = new Map<string, Memory[]>();
  const ordinary: Memory[] = [];
  for (const row of listed.memories) {
    if (row.knowledgeId === null) {
      ordinary.push(row);
      continue;
    }
    existingByPage.set(row.knowledgeId, [...(existingByPage.get(row.knowledgeId) ?? []), row]);
  }

  // ----- plan phase ------------------------------------------------------------
  const planned: PlannedPage[] = [];
  const claimedLegacy = new Set<string>();
  let unchanged = 0;
  let adopted = 0;

  for (const page of pages) {
    const id = pageIdOf(page);
    const split = splitKnowledgeSections(page.text, {
      maxSections: opts.maxSections,
      minChars: opts.minChars ?? DEFAULT_MIN_SECTION_CHARS
    });
    const existing = existingByPage.get(id) ?? [];
    const byKey = new Map(existing.filter((r) => r.knowledgeSection !== null).map((r) => [r.knowledgeSection as string, r]));

    // Rows from the old ingest have no section key; match them by the order their
    // `section:<n>` tag recorded, then fall back to raw row order.
    const legacyByOrder = new Map<number, Memory>();
    const legacyUnordered: Memory[] = [];
    for (const row of existing) {
      if (row.knowledgeSection !== null) continue;
      const order = sectionOrder(row.tags);
      if (order !== null && !legacyByOrder.has(order)) legacyByOrder.set(order, row);
      else legacyUnordered.push(row);
    }
    // Ordinary rows the old ingest wrote without the knowledge columns: claimed by
    // tag so their text and embeddings are reused instead of duplicated.
    const adoptableRows = ordinary.filter((r) => !claimedLegacy.has(r.id) && legacyTag(r.tags, id));

    const sections: PlannedSection[] = split.map((section, index) => {
      const text = renderSectionText(page.title, section.heading, section.prose);
      let row = byKey.get(section.key) ?? legacyByOrder.get(index) ?? null;
      let wasAdopted = false;
      if (row === null) {
        const claim = adoptableRows.shift() ?? legacyUnordered.shift() ?? null;
        if (claim !== null) {
          row = claim;
          wasAdopted = true;
          claimedLegacy.add(claim.id);
        }
      }
      const needsEmbed = row === null || row.text !== text;
      const relabelOnly = !needsEmbed && (row!.knowledgeId !== id || row!.knowledgeSection !== section.key);
      if (!needsEmbed && !relabelOnly) unchanged++;
      if (wasAdopted) adopted++;
      return { key: section.key, text, row, needsEmbed, relabelOnly, adopted: wasAdopted };
    });

    const desired = new Set(split.map((s) => s.key));
    const orphaned = existing.filter(
      (r) => r.knowledgeSection !== null && !desired.has(r.knowledgeSection) && r.knowledgeId === id
    );

    const links: KnowledgeEdge[] = page.links.map((target) => ({
      from: id,
      to: resolveLink(target, byId, byBase),
      target
    }));
    planned.push({ id, title: page.title, sections, links, orphaned });
  }

  const removedPages = [...existingByPage.keys()].filter((id) => !byId.has(id));
  const removed = planned.reduce((n, p) => n + p.orphaned.length, 0) +
    removedPages.reduce((n, id) => n + (existingByPage.get(id)?.length ?? 0), 0);
  const dangling = planned.reduce((n, p) => n + p.links.filter((e) => e.to === null).length, 0);
  const edges = planned.reduce((n, p) => n + p.links.length, 0);
  const needsEmbed = planned.flatMap((p) => p.sections.filter((s) => s.needsEmbed));

  const report: SyncKnowledgeReport = {
    dir,
    namespace,
    project,
    dryRun,
    pages: pages.length,
    sections: planned.reduce((n, p) => n + p.sections.length, 0),
    inserted: needsEmbed.filter((s) => s.row === null).length,
    updated: needsEmbed.filter((s) => s.row !== null).length,
    unchanged,
    removed,
    adopted,
    pagesRemoved: removedPages.length,
    dangling,
    edges,
    embedCalls: 0
  };
  if (dryRun) return report;

  // ----- write phase -----------------------------------------------------------
  // One batch call for everything that needs a vector: a 300-section vault should
  // cost one round trip, not 300.
  const vectors: number[][] = [];
  if (needsEmbed.length > 0) {
    vectors.push(...(await embedder.embedBatch(needsEmbed.map((s) => s.text), { inputType: "passage" })));
    report.embedCalls = 1;
  }

  let vi = 0;
  for (const page of planned) {
    for (const section of page.sections) {
      if (section.needsEmbed) {
        const embedding = vectors[vi++] ?? [];
        const input: MemoryInput = {
          namespace,
          project,
          type: "semantic",
          text: section.text,
          importance: 0.6,
          source: "knowledge:sync",
          tags: ["knowledge", `wiki:${page.id}`],
          knowledgeId: page.id,
          knowledgeSection: section.key
        };
        if (section.row === null) {
          await store.insert(input, embedding);
        } else {
          // In place: the row keeps its id, age and strength; only text+vector move.
          await store.updateEmbedding(section.row.id, embedding, section.text);
          await store.updateMeta(section.row.id, {
            knowledgeId: page.id,
            knowledgeSection: section.key,
            tags: ["knowledge", `wiki:${page.id}`]
          });
        }
      } else if (section.relabelOnly && section.row !== null) {
        await store.updateMeta(section.row.id, {
          knowledgeId: page.id,
          knowledgeSection: section.key,
          tags: ["knowledge", `wiki:${page.id}`]
        });
      }
    }
    if (store.knowledge) await store.knowledge.replaceLinks(page.id, page.links);
  }

  for (const page of planned) {
    for (const row of page.orphaned) await store.deleteSoft(row.id);
  }
  for (const id of removedPages) {
    for (const row of existingByPage.get(id) ?? []) await store.deleteSoft(row.id);
    if (store.knowledge) await store.knowledge.replaceLinks(id, []);
  }

  return report;
}
