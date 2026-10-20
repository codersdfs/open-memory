# ADR-0014: Project a block into leftover budget, never into room another block needs

- **Status:** Accepted (2026-10-19) — implements WP4 of the v0.4 plan; measured against the 70-chunk LoCoMo slice.
- **Options:** return rows whole and leave the tail of the budget unused (v0.3) vs **truncate every row to `budget/k` up front** vs **fill the leftover by projecting one block, with a guard that refuses when a later block would have fit** (chosen) vs raise the budget.
- **Why not raise the budget:** the budget is the contract. A reader that gets 1,400 tokens instead of 800 is a different retrieval setting, not a better one, and the benchmark's `system_tokens` is already near the cap (median 620, max 799).
- **Why not truncate up front:** measured, and it is worse. Projecting every block to `budget/k = 160` tokens scored **any-evidence 61.8% / all 54.6%**, single-hop fell 55 → 43 and temporal rose only 24 → 28. The mechanism is plain in hindsight: the gold evidence line is not reliably the line with the highest query overlap, so cutting every block to its "most relevant" lines deletes evidence that was present. Truncation is safe only when the alternative is *nothing*.
- **Decision:** `budgetEnforce(items, budget, { project? })`. Items are still taken whole in final order. When a row does not fit, its `project(text, remaining)` is offered **only if** `remaining >= 64` **and** no later row would have fit whole (`cheapestAhead` suffix minimum), so a projection can never consume space a whole row needed. `HybridRetriever` wires `project` to `assembleFragment(text, { query })` (`src/core/retrieval/assemble.ts`); `MEMORY_ASSEMBLE=off` restores whole-row-only behavior without a code change.

## Measured (hash embedder, same 152 questions, k=5, budget 800, threshold 0.35)

| arm | any | all | cat2 temporal | cat4 single-hop | blocks | p50 |
|---|---|---|---|---|---|---|
| union, whole rows only | 62.5% | 54.6% | 24/37 | 55/70 | 3.22 | 4.0 ms |
| union + projection up front | 61.8% | 54.6% | 28/37 | 43/70 | — | — |
| **union + projection into leftover** | **62.5%** | **54.6%** | **25/37** | 54/70 | 3.37 | 4.1 ms |

The chosen arm is a strict addition: it never loses a whole row that used to fit, it adds one temporal hit, and it fills budget that was previously returned as `truncated: true` with an extractive summary. The up-front arm is kept in this record because "more context per block" looks better than it is, and the table is the counter-evidence.

## What a projected block looks like

`assembleFragment` keeps the line whose query-term overlap is highest, its ±`neighborRadius` (default 2) lines, and a header line that dates the block (`Session 3 (2026-03-14)`); prose without newlines is split on sentence ends. Every unit is charged with `countTokens`, so the projection cannot exceed the space it was given.

## Rollback

Read-path only. `MEMORY_ASSEMBLE=off` disables it; deleting the `project` wiring in `hybrid.ts` removes it entirely. Nothing is stored differently either way.
