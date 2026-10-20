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
