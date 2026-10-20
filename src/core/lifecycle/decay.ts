import type { VectorStore } from "../store/interface.js";
import type { Memory } from "../types.js";
import { isDurableKind, KIND_RETENTION_MS } from "../write/kind.js";

/**
 * Lifecycle of the store: what to do with rows nobody has ever asked for again.
 *
 * The pre-0.4 rule was prune-only and, measured on the real store, essentially a
 * no-op: 335 rows, 308 of them never retrieved, and one row removed. It compared only
 * `strength` against `maxImportance`, and the lowest strength anywhere was 0.4 against
 * a 0.3 threshold, so the episodic rule could not fire at all. The store now requires
 * BOTH `importance <= maxImportance` and `strength <= maxImportance`: that makes a low
 * threshold reachable, while still letting a reinforced row survive on its strength.
 * Either way the default path must not delete anything.
 *
 * The default is now archiving, because archiving is reversible: it is a status
 * flip (`updateMeta({status:"archived"})`), the row and its vector stay, and an
 * operator can put it back. A prune writes a tombstone whose id an autonomous run
 * never hands out, so the destructive path is opt-in only (`hard: true`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** `list()` defaults to 100 rows; the real store's default partition alone holds 320. */
const PAGE_SIZE = 500;

export interface ArchiveStaleOptions {
  /** How old a never-retrieved row must be before it stops being offered as context. Default 30 days. */
  ageMs?: number;
  /** Rows the judge rated at or above this are kept even if never retrieved. Default 0.6. */
  importanceBelow?: number;
  /** Test seam: pin "now" so age assertions do not depend on the wall clock. */
  now?: number;
}

export interface RunDecayOptions extends ArchiveStaleOptions {
  /**
   * Opt into the old destructive pass. Kept because an operator asked for it can be
   * trusted with it; the default must not be reachable by a scheduled job calling
   * `runDecay(store)` with no arguments.
   */
  hard?: boolean;
  /**
   * Hard pass only. The historical 90-day window survives; the importance floor moved
   * 0.3 → 0.5 because prune() now tests importance AND strength against it and the real
   * store bottoms out at 0.4 on both columns — 0.3 was a rule that could never fire.
   */
  episodicAgeMs?: number;
  episodicImportanceBelow?: number;
  /** Hard pass only. Working notes were always evicted after a week. */
  workingAgeMs?: number;
}

export interface DecayReport {
  archived: number;
  pruned: number;
}

/**
 * Page through one partition without the default 100-row cap.
 *
 * Archiving changes `status` only, and `list()` orders by `pin DESC, created_at DESC`,
 * so the offset window does not shift underneath the scan. A single unpaged call
 * would silently stop at the cap and under-report on exactly the large stores this
 * is meant to clean up.
 */
async function forEachMemory(store: VectorStore, namespace: string, fn: (m: Memory) => Promise<void>): Promise<void> {
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { memories, total } = await store.list({
      namespace,
      includeArchived: true,
      includeDeleted: false,
      limit: PAGE_SIZE,
      offset
    });
    for (const memory of memories) await fn(memory);
    if (memories.length === 0 || offset + memories.length >= total) return;
  }
}

/**
 * Archive rows that were written, never retrieved, and are old enough to be dead weight.
 *
 * The signal is "never used" rather than "old": in the real store 274 of 299 live rows
 * have `lastUsedAt === null`, so age alone would archive the whole store while age plus
 * never-used plus a low importance selects only rows the write-time judge also thought
 * were minor. Archived rows stay readable through `includeArchived`, so this is a
 * reversible demotion, never a delete.
 *
 * Returns how many rows were archived.
 */
export async function archiveStale(store: VectorStore, opts: ArchiveStaleOptions = {}): Promise<number> {
  const ageMs = opts.ageMs ?? 30 * DAY_MS;
  const importanceBelow = opts.importanceBelow ?? 0.6;
  const now = opts.now ?? Date.now();

  let archived = 0;
  // Staleness is a cross-partition property: one agent writing every day does not make
  // another agent's abandoned partition fresh.
  for (const namespace of await store.distinctNamespaces()) {
    await forEachMemory(store, namespace, async (memory) => {
      if (memory.status !== "active") return;
      // ADR-0023: a knowledge row is an index of a markdown file, not a conversational
      // memory. Its lifetime belongs to the file — archiving it would hide a page that
      // is still on disk, and the next sync would re-insert it anyway.
      if (memory.knowledgeId !== null) return;
      // ADR-0021: a decision, a convention or a gotcha is the reason the store exists.
      // Age is not evidence against them — being wrong is — so no age rule may demote
      // one. Only an explicit supersede or delete takes them out.
      if (isDurableKind(memory.kind)) return;
      if (memory.lastUsedAt !== null) return;
      // Kind sets the window: a task nobody touched in a week is done, a fact gets
      // longer than the default because facts age slower than notes. The importance
      // floor stays for every kind, so a high-rated row is never demoted by age alone.
      const window = KIND_RETENTION_MS[memory.kind] ?? ageMs;
      if (memory.createdAt >= now - window) return;
      if (memory.importance >= importanceBelow) return;
      await store.updateMeta(memory.id, { status: "archived" });
      archived++;
    });
  }
  return archived;
}

/**
 * Archive-first decay, with the legacy prune available behind `hard: true`.
 *
 * Order matters in the hard pass: prune first, then archive the survivors, so a row
 * that both rules would touch is counted once (as pruned) instead of appearing in
 * both buckets.
 */
export async function runDecayDetailed(store: VectorStore, opts: RunDecayOptions = {}): Promise<DecayReport> {
  let pruned = 0;
  if (opts.hard === true) {
    // The pre-0.4 shape, with one reachability fix: prune() now requires importance AND
    // strength to be at or below maxImportance, so 0.3 could never fire on a store whose
    // lowest values are 0.4. 0.5 is the lowest reachable floor that still means "minor".
    pruned += await store.prune({
      olderThanMs: opts.episodicAgeMs ?? 90 * DAY_MS,
      maxImportance: opts.episodicImportanceBelow ?? 0.5,
      type: "episodic"
    });
    pruned += await store.prune({
      olderThanMs: opts.workingAgeMs ?? 7 * DAY_MS,
      maxImportance: 1, // every working row, the historical meaning of this rule
      type: "working"
    });
  }
  const archived = await archiveStale(store, opts);
  return { archived, pruned };
}

/**
 * Backward-compatible entry point: callers (`ai-memory decay`, `POST /decay`) render
 * the return value as a single number, so this keeps that shape and reports total rows
 * affected. Use `runDecayDetailed` when the archive/prune split matters.
 */
export async function runDecay(store: VectorStore, opts: RunDecayOptions = {}): Promise<number> {
  const report = await runDecayDetailed(store, opts);
  return report.archived + report.pruned;
}
