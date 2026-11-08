import type { VectorStore } from "../store/interface.js";
import type { Memory, MemoryKind } from "../types.js";
import { curateExtracted, DEMOTE_IMPORTANCE, ADVICE, type JunkClass } from "../write/curation.js";
import { normalizeText } from "../write/text.js";
import { isDurableKind } from "../write/kind.js";

/**
 * Retroactive curation, diff-first (P3 of `docs/research/memory-systems-notes-2026-11-07.md`,
 * ADR-0040 amendment 2026-11-08). ADR-0040 shipped with "No retroactive curation":
 * curation was a write contract and the stock decayed only through the archive
 * policy. That left the stock itself untouched — 89% of the audited 515 rows had
 * never been retrieved, and every junk row the write gate now refuses was already
 * sitting in the store, admitted by the paths the gate did not cover. The user
 * reversed the decision (2026-11-08): the stock gets the same verdict new writes
 * get, through an explicit operator command, never silently.
 *
 * The shape follows the P1/P2 discipline of this branch:
 *
 * - **Diff first.** The default run writes nothing — it reports what it *would*
 *   do, with ids and reasons. `--apply` is the only mode that touches the store,
 *   the same bargain `reembed --dry-run` and `knowledge sync --dry-run` make.
 * - **Never a hard delete.** Junk leaves the candidate pools by a status flip
 *   (`updateMeta({status:"archived"})`), exactly like decay's default pass
 *   (ADR-0016): the row, its vector and its audit trail stay, and an operator can
 *   put it back. Nothing in this file reaches `deleteSoft` or `purgeDeleted`.
 * - **Same two-store contract.** Every action goes through `updateMeta`, so the
 *   SQLite store's trailing `noteChange` expires the partition snapshots the row
 *   sits in (ADR-0034) — an archived row must not survive in a decoded partition —
 *   and the in-memory store needs nothing extra because it has no snapshots.
 *
 * What this pass deliberately is NOT:
 * - It does not call the model (ADR-0040's verdict is pure, zero-network — the
 *   point of a stock sweep is that it is affordable on every row). `low-value`,
 *   the one class only the write gate (ADR-0041) can produce, is therefore out of
 *   reach here; rows that look under-priced but carry no `judged:*` tag are only
 *   *counted* (`unjudged`) — whether that becomes a persisted tag is ADR-0041's
 *   pending amendment (P5), not this file's business.
 * - It does not merge anything. Two live rows that share an `entity:*` facet and
 *   the same `normalizeText` are *listed* as merge candidates; merging rewrites
 *   identity, and ADR-0015 keeps that decision with reconcile and its guards.
 */

/** `list()` defaults to 100 rows; the real store's default partition alone holds 320. */
const PAGE_SIZE = 500;

/** How many example rows the human summary prints. The JSON report carries every one. */
export const SAMPLE_LIMIT = 5;

const WEAK_CLASSES: ReadonlySet<JunkClass> = new Set(["progress", "self-narration"]);

/** One row the pass would change, with the reason a human can judge. */
export interface TriageCandidate {
  id: string;
  namespace: string;
  kind: MemoryKind;
  /** `archive` = junk class → status flip. `demote` = weak class → importance sinks. */
  action: "archive" | "demote";
  /** The junk class the write-time verdict assigned (`table-row`, `progress`, …). */
  reason: JunkClass;
  /** Present on `demote`: the importance the row carries now. */
  importanceFrom?: number;
  /** Present on `demote`: always `DEMOTE_IMPORTANCE`, the write-time ladder's floor. */
  importanceTo?: number;
}

/** Two or more live rows sharing an `entity:*` facet and the same normalized text. Listed, never merged. */
export interface TriageMergeGroup {
  /** The shared facet value, without the `entity:` prefix. */
  entity: string;
  /** The shared comparison form (`normalizeText`), which is the claim both rows state. */
  text: string;
  /** Row ids, oldest first — the survivor would be the first of these, but nothing picks one here. */
  ids: string[];
}

export interface TriageReport {
  /** Every row the scan read, whatever became of it — including tombstones and drafts. */
  scanned: number;
  partitions: number;
  /** Would archive / did archive. */
  archives: TriageCandidate[];
  /** Would demote / did demote. */
  demotions: TriageCandidate[];
  /** Merge candidates. Always listed only, in both modes. */
  merges: TriageMergeGroup[];
  /**
   * Live rows with no `judged:*` tag — "the judge never priced this row" and
   * "the judge ran and failed" are indistinguishable after the fact (ADR-0041
   * stores unjudged rows untagged, fail-open). Counted in-process only; whether
   * this becomes a tag is P5's pending amendment.
   */
  unjudged: number;
  /** `--apply` was passed and the writes below actually ran. */
  applied: boolean;
}

export interface TriageOptions {
  /** Write the archives and demotions. Default false — the diff is the product. */
  apply?: boolean;
}

/**
 * One verdict per stock row, then the two reversible actions.
 *
 * The scan pages past `list()`'s 100-row default the same way `archiveStale` does,
 * widened to the whole store — `includeDeleted`/`includeArchived`/`includeDraft`
 * — because a sweep that quietly skipped tombstoned partitions would misstate
 * what the store holds. Neither column an action writes (`status`, `importance`)
 * is part of `list()`'s ORDER BY (`pin DESC, created_at DESC, id ASC`), so the
 * offset window does not shift underneath an apply pass — the same argument the
 * decay scan makes (decay.ts).
 *
 * Skips, in order and on purpose:
 * - `knowledgeId !== null` — a knowledge row is an index of a markdown file
 *   (ADR-0023); its lifetime belongs to the file and the next sync would
 *   re-insert it. `decay.ts` refuses these rows for the same reason. (Many would
 *   also trip `table-row`: vault tables are full of pipes.)
 * - `pin === 1` — pin is the one explicit "keep this" signal (ADR-0011); an
 *   automatic pass must not override it, whatever the regexes say.
 * - `status !== "active"` — an archived or tombstoned row is already outside
 *   every candidate pool, and a draft is a governance state (ADR-0006) this pass
 *   has no business stomping. This is also what makes a re-run a no-op.
 * - durable kinds (`decision`/`convention`/`gotcha`) — durable by contract
 *   (ADR-0021), the same skip P2 preserved when the decay rule swapped to
 *   hotness. A durable row that trips a lexical junk rule is a question for a
 *   human, not for a sweep.
 */
export async function runTriage(store: VectorStore, opts: TriageOptions = {}): Promise<TriageReport> {
  const apply = opts.apply === true;
  const report: TriageReport = { scanned: 0, partitions: 0, archives: [], demotions: [], merges: [], unjudged: 0, applied: false };

  const liveByMergeKey = new Map<string, { entity: string; text: string; rows: Memory[] }>();

  const namespaces = await store.distinctNamespaces({ includeDeleted: true });
  report.partitions = namespaces.length;

  for (const namespace of namespaces) {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { memories, total } = await store.list({
        namespace,
        includeDeleted: true,
        includeArchived: true,
        includeDraft: true,
        limit: PAGE_SIZE,
        offset,
      });
      for (const memory of memories) {
        report.scanned++;
        // Knowledge rows are file indexes, not memories (ADR-0023): out of every
        // action and out of the merge question, which is reconcile's anyway.
        if (memory.knowledgeId !== null) continue;
        if (memory.status === "active" && memory.isDeleted === 0) {
          if ((memory.tags ?? []).every((t) => !t.startsWith("judged:"))) report.unjudged++;
          if (memory.pin !== 1) collectMergeCandidate(liveByMergeKey, memory);
        }
        // Everything below touches only rows a read can still hand out.
        if (memory.status !== "active" || memory.isDeleted !== 0) continue;
        if (memory.pin === 1) continue;
        if (isDurableKind(memory.kind)) continue;

        const verdict = curateExtracted(memory.text);
        if (verdict.junk === null) continue;
        if (WEAK_CLASSES.has(verdict.junk)) {
          // The weak classes demoted an *explicit* write at write time (ADR-0040);
          // stock rows get the same bargain — rank sinks below every kind default,
          // the row itself survives. A row already at or under the floor is where
          // the ladder would have put it: nothing to do, so nothing to report.
          if (memory.importance > DEMOTE_IMPORTANCE) {
            report.demotions.push({
              id: memory.id,
              namespace,
              kind: memory.kind,
              action: "demote",
              reason: verdict.junk,
              importanceFrom: memory.importance,
              importanceTo: DEMOTE_IMPORTANCE,
            });
            if (apply) await store.updateMeta(memory.id, { importance: DEMOTE_IMPORTANCE });
          }
        } else {
          report.archives.push({
            id: memory.id,
            namespace,
            kind: memory.kind,
            action: "archive",
            reason: verdict.junk,
          });
          // The history row (P6, ADR-0045) names the triage verdict, so the archive
          // event reads as "the stock sweep did this, class <junk>".
          if (apply) await store.updateMeta(memory.id, { status: "archived" }, { reason: `triage:${verdict.junk}` });
        }
      }
      if (memories.length === 0 || offset + memories.length >= total) break;
    }
  }

  report.merges = [...liveByMergeKey.values()]
    .filter((g) => g.rows.length >= 2)
    .map((g) => ({
      entity: g.entity,
      text: g.text,
      ids: g.rows
        // Oldest first: created_at is the only order that says which row earned
        // the claim first, with id as the tie-break — the same deterministic
        // order `list()` itself sorts by, so a same-millisecond bulk import
        // still reports a stable pair.
        .sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : 1))
        .map((m) => m.id),
    }))
    // One group per (entity, text) pair; a row carrying two duplicated entities
    // lands in two groups, which is honest, not a bug.
    .sort((a, b) => a.entity.localeCompare(b.entity) || a.text.localeCompare(b.text));

  report.applied = apply;
  return report;
}

/**
 * Key a live row by every `entity:*` facet it carries, over its comparison form.
 * A row with no entity facet cannot name what it duplicates, so it joins nothing —
 * plain exact duplicates across partitions are P1's fold's business at write time,
 * and reporting every one of them here would drown the entity-shaped cases in noise.
 */
function collectMergeCandidate(
  groups: Map<string, { entity: string; text: string; rows: Memory[] }>,
  memory: Memory
): void {
  const text = normalizeText(memory.text);
  if (!text) return;
  for (const tag of memory.tags ?? []) {
    if (!tag.startsWith("entity:")) continue;
    const key = `${tag}\u0000${text}`;
    let group = groups.get(key);
    if (!group) {
      group = { entity: tag.slice("entity:".length), text, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(memory);
  }
}

/** The one-line-per-row render the CLI summary and the JSON report share. */
export function renderCandidate(c: TriageCandidate): string {
  if (c.action === "demote") {
    return `demote [${c.id}] (${c.reason}, importance ${c.importanceFrom} → ${c.importanceTo}): ${ADVICE[c.reason]}`;
  }
  return `archive [${c.id}] (${c.reason}): ${ADVICE[c.reason]}`;
}

/** The diff summary: counts first, then samples with ids and reasons. */
export function renderTriageReport(report: TriageReport): string {
  const mergeRows = report.merges.reduce((n, g) => n + g.ids.length, 0);
  const head =
    `${report.applied ? "applied" : "dry run — nothing written"}: scanned ${report.scanned} row(s) across ${report.partitions} partition(s)` +
    `${report.applied ? "" : " (re-run with --apply to write)"}`;
  const counts =
    `→ ${report.applied ? "archived" : "would archive"} ${report.archives.length}, ` +
    `${report.applied ? "demoted" : "would demote"} ${report.demotions.length}, ` +
    `merge candidates ${report.merges.length} group(s) / ${mergeRows} row(s) (listed only — never changed here), ` +
    `unjudged ${report.unjudged} (counted only, no tag written — ADR-0041 amendment pending, P5)`;
  const lines: string[] = [head, counts];
  for (const c of report.archives.slice(0, SAMPLE_LIMIT)) lines.push(`  ${renderCandidate(c)}`);
  for (const c of report.demotions.slice(0, SAMPLE_LIMIT)) lines.push(`  ${renderCandidate(c)}`);
  for (const g of report.merges.slice(0, SAMPLE_LIMIT)) {
    lines.push(`  merge candidate entity:${g.entity} ×${g.ids.length}: ${g.ids.map((id) => `[${id}]`).join(" ↔ ")}`);
  }
  return lines.join("\n");
}
