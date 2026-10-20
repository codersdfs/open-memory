# ADR-0013: k, the token budget and decay are now honest

- **Status:** Accepted (2026-10-19) — implements WP1/WP3 of the v0.4 plan.
- **Context:** three settings were decorative. `k` never truncated; `countTokens` divided by 4 regardless of script; `prune`'s `maxImportance` compared `strength`. Each one looked fine in a test suite that never asserted the thing it was supposed to control.

## `k` is a cap again

`k` was only used to size `overFetch = max(20, k*4)`. With a 800-token budget and ~220-token rows, the budget usually bound first: the benchmark's 152 queries asked for `k = 5` and 148 of them got fewer than 5 blocks (67 got ≤ 2). Callers who pass `k` are asking for at most `k` memories, so `search()` now slices the budgeted result to `k` and reports `truncated: true` when it does — `truncated` used to mean "budget overflow" only.

## `countTokens` counts Chinese

`Math.ceil(text.length / 4)` is a fair estimate for English and an underestimate by roughly 2-3x for Chinese: a 68-character Chinese memory was budgeted at 17 tokens and actually costs ~60. Since the store's traffic is 60% Chinese rows, budgets overflowed silently and `tokensUsed` (what the caller and the benchmark report) lied. The heuristic is now `cjkChars + ceil(latinChars / 4)` over the same CJK ranges the tokenizer uses. It stays a heuristic — no tokenizer dependency — but it errs on the side of over-counting CJK, which is the safe direction for a budget.

## One oversized row no longer starves the list

`budgetEnforce` used to `break` on the first row that did not fit, so a single long memory at the top of the ranking could hide every shorter memory behind it. It now skips and keeps scanning; only when *nothing* fits and the budget is at least 40 tokens does it clip the first row to the budget (`clipToBudget`, sentence boundaries). Overflow still produces the extractive `summary` that the MCP renderer prints as "also: ...".

## `prune` requires both columns to be low

`prune({olderThanMs, maxImportance})` documented `maxImportance` as an importance ceiling but compared it to `strength`. That made the shipped decay rule structurally unreachable: strength starts at importance (live-store minimum 0.4) and only ever increases, so `strength <= 0.3` matched zero of 335 rows and `runDecay` pruned one row in the store's whole history — a `working` row, by the unrelated 7-day rule.

Comparing `importance` alone is equally wrong in the other direction: reinforcement (R2) is supposed to protect a row, and the test for that (`tests/recall.test.ts`, "a repeatedly-used memory outlives an untouched higher-importance one") failed with `evicted === 2` instead of `1`, because a row that had been used kept an untouched row's low *importance*.

The predicate is now `COALESCE(last_used_at, created_at) < ? AND importance <= ? AND strength <= ?` — the same number for both columns. A row survives if it was important *or* if it has been used. Both stores implement it identically.

**Consequence for callers:** with importance starting at 0.4 in the live store, any pruning threshold below 0.4 is dead by construction. WP3 therefore changes `runDecay` to *archive* (`status = 'archived'`) by default and to pass thresholds ≥ 0.5, leaving physical deletion behind `hard: true`.

## Rollback

No schema change and no data change. All three behaviors are pinned by tests (`tests/retrieval.test.ts`, `tests/lexical.test.ts`, `tests/recall.test.ts`, `tests/api.test.ts`); reverting the commit restores the previous semantics exactly. `tokensUsed` values will shift for existing Chinese-heavy stores, which is the point.
