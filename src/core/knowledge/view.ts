/**
 * Read-side of the knowledge index (ADR-0023): pages, links, neighbours.
 *
 * Everything here is assembled from `memories` rows plus `knowledge_links`; the
 * markdown files are read only by `syncKnowledge`. That keeps `memory_knowledge`,
 * the HTTP routes and the CLI on one code path, and means a search result can show
 * "this page links to these two pages" without touching the filesystem.
 */
import type { KnowledgeEdge, Memory } from "../types.js";
import type { VectorStore } from "../store/interface.js";
import { titleOfSectionText } from "./sections.js";

export interface KnowledgeSectionView {
  /** `knowledge_section` key: stable across syncs while the heading is unchanged. */
  key: string;
  heading: string;
  chars: number;
}

export interface KnowledgePageView {
  id: string;
  title: string;
  project: string | null;
  sections: KnowledgeSectionView[];
  /** Edges written from this page, resolved or not. */
  links: KnowledgeEdge[];
  /** Edges written *to* this page by other pages. */
  backlinks: KnowledgeEdge[];
  /** Outgoing edges whose target does not resolve — the file's maintenance debt. */
  dangling: KnowledgeEdge[];
}

export interface KnowledgeNodeView {
  id: string;
  title: string;
  project: string | null;
  sections: number;
  links: number;
  backlinks: number;
}

export interface KnowledgeIndexView {
  pages: KnowledgeNodeView[];
  dangling: KnowledgeEdge[];
  /** Resolved edges, both directions; an unresolved link is a dangling edge, not this. */
  edges: number;
}

/** Heading back out of a rendered row: `[page] heading: prose` → `heading`. */
function headingOfText(text: string, title: string): string {
  const prefix = titleOfSectionText(text);
  if (prefix === null) return "";
  const rest = text.slice(text.indexOf("]") + 1).trimStart();
  const colon = rest.indexOf(": ");
  return colon > 0 && colon <= 120 ? rest.slice(0, colon) : "";
}

function groupByPage(rows: Memory[]): Map<string, Memory[]> {
  const pages = new Map<string, Memory[]>();
  for (const row of rows) {
    if (row.knowledgeId === null) continue;
    const held = pages.get(row.knowledgeId) ?? [];
    held.push(row);
    pages.set(row.knowledgeId, held);
  }
  return pages;
}

function pageTitle(rows: Memory[]): string {
  for (const row of rows) {
    const title = titleOfSectionText(row.text);
    if (title) return title;
  }
  return rows[0]?.knowledgeId ?? "(untitled)";
}

/**
 * Every page in the given partitions.
 *
 * ADR-0030: this used to list each partition whole (`limit: 100_000`) and group in
 * memory, on the reasoning that a vault is pages-times-sections rows and the
 * alternative is a query per page. Both halves of that were wrong. The rows a page
 * tree needs are exactly the rows with a `knowledge_id`, which the store can filter
 * on and has an index for; on a partition of 21,000 rows where 20,000 were ordinary
 * chat memories, listing it took 388 ms and all but 1,000 rows were thrown away
 * immediately after being decoded. Filtering first is 12x faster and the cost now
 * follows the size of the *vault* rather than the size of the partition it lives in.
 *
 * Edges are indexed by endpoint once instead of being filtered per page: the old
 * loop did three full scans of the edge list per page, which is quadratic in pages.
 */
export async function knowledgePages(
  store: VectorStore,
  opts: { namespaces: string[] }
): Promise<KnowledgePageView[]> {
  const rows = await knowledgeRows(store, opts.namespaces);
  const edges = store.knowledge ? await store.knowledge.links() : [];
  const byFrom = new Map<string, KnowledgeEdge[]>();
  const byTo = new Map<string, KnowledgeEdge[]>();
  for (const edge of edges) {
    append(byFrom, edge.from, edge);
    if (edge.to !== null) append(byTo, edge.to, edge);
  }
  const pages = groupByPage(rows);
  const out: KnowledgePageView[] = [];
  for (const [id, pageRows] of pages) {
    const title = pageTitle(pageRows);
    const outgoing = byFrom.get(id) ?? [];
    out.push({
      id,
      title,
      project: pageRows[0]?.project ?? null,
      sections: pageRows
        .slice()
        .sort((a, b) => (a.knowledgeSection ?? "").localeCompare(b.knowledgeSection ?? ""))
        .map((row) => ({
          key: row.knowledgeSection ?? "",
          heading: headingOfText(row.text, title),
          chars: row.text.length
        })),
      links: outgoing,
      backlinks: byTo.get(id) ?? [],
      dangling: outgoing.filter((e) => e.to === null)
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function append(map: Map<string, KnowledgeEdge[]>, key: string, edge: KnowledgeEdge): void {
  const held = map.get(key);
  if (held) held.push(edge);
  else map.set(key, [edge]);
}

/**
 * The live knowledge rows of these partitions.
 *
 * Uses the store's page-tree query when it has one. The fallback lists the
 * partitions whole — correct, but it decodes every ordinary memory in them, which
 * is the cost this function exists to avoid.
 */
async function knowledgeRows(store: VectorStore, namespaces: string[]): Promise<Memory[]> {
  if (store.knowledge?.listKnowledge) return store.knowledge.listKnowledge(namespaces);
  const rows: Memory[] = [];
  for (const namespace of namespaces) {
    // `knowledge: null` asks for ordinary memories — the opposite of what this
    // wants — so the fallback takes the partition whole and filters here.
    const listed = await store.list({ namespace, withVectors: false });
    rows.push(...listed.memories.filter((m) => m.knowledgeId !== null));
  }
  return rows;
}

/** The page index: just enough per page to render a list or a graph. */
export async function knowledgeIndex(
  store: VectorStore,
  opts: { namespaces: string[] }
): Promise<KnowledgeIndexView> {
  const pages = await knowledgePages(store, opts);
  const dangling = pages.flatMap((p) => p.dangling);
  const resolved = pages.reduce((n, p) => n + p.links.filter((e) => e.to !== null).length, 0);
  return {
    pages: pages.map((p) => ({
      id: p.id,
      title: p.title,
      project: p.project,
      sections: p.sections.length,
      links: p.links.length,
      backlinks: p.backlinks.length
    })),
    dangling,
    edges: resolved
  };
}

/**
 * Neighbours as an *explicit* read (ADR-0023): the retriever never expands through
 * links on its own, because that is how a search turns two relevant rows into
 * eight. Links are treated as undirected — Obsidian-style vaults rely on that, and
 * an incoming-only page would otherwise look isolated.
 */
export function neighborsOf(edges: KnowledgeEdge[], id: string, depth = 1, max = 8): string[] {
  const hops = Math.max(1, Math.min(3, Math.floor(depth)));
  const seen = new Set<string>([id]);
  const out: string[] = [];
  let frontier = [id];
  for (let d = 0; d < hops && out.length < max; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const edge of edges) {
        if (edge.to === null) continue;
        const other = edge.from === node ? edge.to : edge.to === node ? edge.from : null;
        if (other === null || seen.has(other)) continue;
        seen.add(other);
        out.push(other);
        next.push(other);
        if (out.length >= max) return out;
      }
    }
    frontier = next;
  }
  return out;
}
