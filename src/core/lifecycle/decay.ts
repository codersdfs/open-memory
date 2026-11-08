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
 *
 * Since 2026-11-07 the archive rule reads a counter instead of a binary flag, and
 * a scheduler actually calls this file (P2, ADR-0016 amendment): see `hotness` and
 * `runScheduledDecay` below.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** `list()` defaults to 100 rows; the real store's default partition alone holds 320. */
const PAGE_SIZE = 500;

/**
 * Hotness of a row: `log1p(use_count) × exp(−ln2 · age / window)` — the shape
 * OpenViking ships for exactly this question (bench/OpenViking/openviking/retrieve/
 * memory_lifecycle.py:18-41: freq grows in log1p of the access count, recency
 * decays exponentially from the last activity, half-life in the same units).
 *
 * The half-life is NOT a new global constant (that would have been inventing a
 * seventh number): it is the kind's existing retention window from ADR-0021 —
 * `fact` 90 days, `note` 30, `task` 7 — so a row ages out on the same clock that
 * already decided when this kind stops being believed without evidence.
 *
 * `age` runs from the last activity, `lastUsedAt` when there was one and
 * `createdAt` otherwise: the same COALESCE clock `store.prune()` reads, and the
 * same convention the OpenViking decay keys on its last-access timestamp.
 */
export function hotness(useCount: number, ageMs: number, halfLifeMs: number): number {
  return Math.log1p(useCount) * Math.exp(-Math.LN2 * (ageMs / halfLifeMs));
}

/**
 * The keep line: the hotness of a row used exactly once, one half-life after that
 * use — `log1p(1) · exp(−ln2)` = `ln2/2`. Derived, not tuned: it says "a row is
 * retired once it is colder than the least evidence of use one window ago". A
 * never-used row sits at 0 and expires at its window, exactly as ADR-0016 measured
 * (308 of 335 rows never retrieved); a row used once is protected for one window
 * per the old rule's bargain, and every further window costs double the uses
 * (3 survive two windows, 16 three) — which is what replaces the binary: under the
 * old rule, one retrieval in the store's first month made a row immortal forever
 * (gap1: `lastUsedAt` only said "used at all", and strength saturates at 0.95).
 */
export const HOTNESS_KEEP = Math.LN2 / 2;

export interface ArchiveStaleOptions {
  /**
   * Fallback window for a kind `KIND_RETENTION_MS` has no entry for; the durable
   * kinds are skipped before it is read. Default 30 days — the `note` window.
   */
  ageMs?: number;
  /** Rows the judge rated at or above this are kept even if the clock says otherwise. Default 0.6. */
  importanceBelow?: number;
  /** Test seam: pin "now" so age assertions do not depend on the wall clock. */
  now?: number;
}

export interface RunDecayOptions extends ArchiveStaleOptions {
  /**
   * Opt into the old destructive pass. Kept because an operator asked for it can be
   * trusted with it; the scheduled path cannot ask for it at all — the daemon's
   * maintenance job goes through `runScheduledDecay`, which takes no options bag.
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
 * Archive rows whose use has decayed past the keep line — cold, not merely old.
 *
 * The signal used to be the binary "never used" (`lastUsedAt !== null` skipped a row
 * forever): in the real store 274 of 299 live rows had `lastUsedAt === null`, so age
 * alone would archive everything and one retrieval in the first month immunised a row
 * for life. The P2 rule (ADR-0016 amendment, 2026-11-07) reads `use_count` instead —
 * a row stays while its hotness is at least `HOTNESS_KEEP`, so a frequently-recalled
 * old row survives, a once-recalled-and-forgotten row ages out one window after its
 * last use, and a never-used row still expires at its window exactly as measured.
 * Archived rows stay readable through `includeArchived`, so this is a reversible
 * demotion, never a delete.
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
      // one. Only an explicit supersede or delete takes them out. The hotness swap
      // does not reach them: this skip runs before any clock is read.
      if (isDurableKind(memory.kind)) return;
      // Kind sets the window, and the window doubles as the hotness half-life: a task
      // nobody touched in a week is done, facts age slower than notes (ADR-0021).
      const window = KIND_RETENTION_MS[memory.kind] ?? ageMs;
      // The grace period stays a hard floor in front of the formula: a row younger
      // than its own window is never touched, however cold the exponent says it is
      // (`hotness` of a brand-new never-used row is 0 by construction, and 0 is not
      // evidence of anything yet). Age runs from the last activity where there was one.
      const clock = memory.lastUsedAt ?? memory.createdAt;
      if (clock >= now - window) return;
      if (hotness(memory.useCount, now - clock, window) >= HOTNESS_KEEP) return;
      // The importance floor survives the swap for every kind, exactly as before: a
      // row the write-time judge rated highly is never demoted by the clock alone
      // (ADR-0021). Reviewers of the P2 change check this line on purpose.
      if (memory.importance >= importanceBelow) return;
      // The history row (P6, ADR-0045) names the rule that archived the row, so the
      // event is readable as "the hotness rule did this" and not as an unexplained
      // status flip.
      await store.updateMeta(memory.id, { status: "archived" }, { reason: "decay:hotness" });
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

/**
 * The maintenance scheduler's entry point (P2, ADR-0016 amendment 2026-11-07).
 *
 * It runs the reversible half of `runDecayDetailed` and takes NO options bag:
 * `hard` is unreachable from this path because the signature cannot express it —
 * the guarantee the pre-scheduler comment on `RunDecayOptions.hard` asked for is
 * held structurally, not by a calling convention someone could forget. An
 * operator-visible `pruned` from here would mean the scheduler deleted rows; the
 * constant zero is the contract. `POST /decay` and the CLI keep the opt-in.
 */
export async function runScheduledDecay(store: VectorStore): Promise<DecayReport & { pruned: 0 }> {
  const report = await runDecayDetailed(store, {});
  return { archived: report.archived, pruned: 0 };
}
