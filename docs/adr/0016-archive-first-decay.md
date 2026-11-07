# ADR-0016: Archive-first decay, and a stats view that can see it

- **Status:** Accepted (2026-10-19) — implements WP3 of the v0.4 plan; measured against a copy of the live store.
- **Options:** keep the destructive sweep as the only decay vs **archive never-retrieved rows by default, keep deletion behind `hard: true`** (chosen) vs delete nothing and only report.
- **Why not the destructive sweep alone:** measured, it never fired. `runDecay(store)` applied `episodic > 90d AND strength <= 0.3`, but the store's minimum strength *is* 0.4 and its oldest row was 49 days old, so the rule was structurally unreachable — 0 of 335 rows pruned. Meanwhile 308 of 335 rows had `lastUsedAt = null`, i.e. the store only grew and nothing was ever demoted for being useless.
- **Decision:** `runDecayDetailed(store)` archives by default: rows with `status = active`, `lastUsedAt = null`, `createdAt` older than 30 days and `importance < 0.6` get `status = "archived"`. Archived rows stay readable through `includeArchived`, so this is a reversible demotion, never a delete. Deletion survives only behind `hard: true` (episodic > 90d, working > 7d), and its importance floor moved 0.3 → 0.5 so the rule can actually fire.
- **`runDecay` keeps its number-shaped return** for the CLI and older callers, and now counts archived + pruned. `POST /decay` returns `{ archived, pruned, affected }` because one number could no longer say which of the two happened.

## Why `prune` tests two columns

`store.prune({ maxImportance })` requires `importance <= maxImportance` **and** `strength <= maxImportance`. Testing strength alone was unreachable (strength starts at the write-time importance, bottoms out at 0.4, and only ever rises); testing importance alone broke R2: a weak row that had been *used* several times was pruned while an untouched row with the same numbers survived. `tests/recall.test.ts` caught exactly that case (expected 1 eviction, got 2). The pair of tests — one row in, one row out — is the guard for both directions.

## Measured on a copy of the live store (299 live / 36 deleted)

| pass | archived | pruned |
|---|---|---|
| default `runDecay()` | 2 | 0 |
| `hard: true` | 1 | 1 |

The two default archives were a stale working note (`"current task: inspect memories in the simplest UI"`, 49 days, importance 0.4) and a procedure that still described a UI that no longer exists (`"How to deploy the memory UI…"`, 49 days, importance 0.5). Re-running either pass returns 0, so both are idempotent.

## The stats view

`memory_stats` now reports `archived`, `archivedRatio`, `neverRetrieved`, `neverRetrievedRatio` per scope, and the console's decay preview lists what a run would take with the action it would take (`archive` vs `prune`). The constants in `src/core/stats.ts` deliberately duplicate `decay.ts` rather than import it: the preview must be able to drift *visibly*, and a comment on both sides pins the numbers.

## Seed isolation

`scripts/seed.ts` used to write into whatever store `MEMORY_DB_PATH`/`.env` pointed at — which is how 19 fixture rows (7 still active) ended up in the real store. It now writes to `mkdtemp(join(tmpdir(), "ai-memory-seed-"))` unless a path is passed explicitly, and it snapshots the env *before* any dynamic import, because `config.ts` loads `.env` on import and a static import would make the repository's `.env` look like an explicit choice. `tests/seed-isolation.test.ts` spawns the script both ways to keep it that way.

## Amendment (2026-11-07): the sweep has a trigger, and the trigger counts

This ADR shipped with a rule no scheduler ran: decay was reachable only through the human hands of `POST /decay` and the CLI, and the store grew between them (the gap study: 89% of the audited store had never been retrieved; the one `setInterval`-shaped comment in `decay.ts` was preventing a scheduled job that did not exist). Three changes, all measured against this store's own shapes:

- **`use_count` — a retrieval counter per row.** `reinforce` moves three numbers now: `strength +0.02` capped, `last_used_at = now`, and `use_count + 1`, on both stores. The binary `lastUsedAt !== null` the archive rule skipped on was not enough: it made one retrieval in the store's first month immortal, and the counter is what "forgotten" needs to mean. Migration follows the `text_hash` pattern from the ADR-0018 amendment (2026-11-07): ALTER and the zero-backfill in ONE transaction, so a crash rolls the column itself back and the next open re-runs the whole thing instead of leaving NULLs; NULLs from a foreign writer read as 0 (`COALESCE` in the UPDATE, `?? 0` in the row mapping). Old rows start at zero because "no evidence of use" is the honest floor, not a guess.
- **The archive rule reads hotness, not a binary flag.** A row is archived when it is past its kind's window *and* its hotness `log1p(use_count) × exp(−ln2 · age / window)` has fallen under `HOTNESS_KEEP = ln2/2` — the hotness of a row used exactly once one window ago, derived from the formula rather than tuned (OpenViking runs the same shape for the same question: `log1p` frequency against exponential recency, and its recency also runs from the last activity). The half-life is not a new global constant: each kind's window from ADR-0021 doubles as its half-life (`task` 7d, `note` 30, `fact` 90), and the window still stands as a grace floor in front of the formula. What the swap does *not* touch, checked line by line at review: the durable-kind skip (ADR-0021 — `decision`/`convention`/`gotcha` are still never archived by age) and the `importance < 0.6` floor (a judge-rated-high row still never demotes by the clock).
- **The daemon sweeps.** `MEMORY_MAINTAIN_HOURS` (default 24, `0` fully off) hangs a timer on the reversible pass at the server main entry — which is also the daemon. The scheduled path calls `runScheduledDecay(store)`, which takes **no options bag**: the hard pass is unreachable from it by signature, not by a calling convention someone can forget — the promise the original file's comment made about scheduled callers is now kept structurally. `store_meta`, a small KV table (both stores), holds `last_maintenance_at` and the last pass's result; opening a store whose stamp is a stale-or-missing one fires a catch-up pass in the background — nothing awaits it, so no request pays for a sweep, and a daemon that was down for a week does not wait another interval to notice. Each pass logs `ai-memory maintenance: archived N cold rows` to stderr, and `/stats?full=1` carries `lastMaintenanceAt`/`lastMaintenanceResult` so the console's decay panel shows when the automatic pass last ran, alongside each candidate's `uses`.

Verified live on a throwaway store (2026-11-07): a boot with `MEMORY_MAINTAIN_HOURS=0` produced no maintenance line at all, and a restart with a short interval archived a seeded 100-day never-used note from the open-store catch-up — first stderr line `ai-memory maintenance: archived 1 cold row`, the following ticks reporting 0. The October measurement above stands for the binary rule, not this one: never-used rows fall under both rules identically, so the hotness rule's archive set is a superset (rows used once and forgotten since now join it); the new rule has not been re-measured on that store copy. The superset claim and the idempotency of re-runs are pinned by `tests/decay.test.ts` and `tests/maintenance.test.ts`.
