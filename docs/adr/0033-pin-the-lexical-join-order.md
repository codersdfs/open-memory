# ADR-0033 — Pin the lexical join order, but only while it pays

- **Status**: Accepted
- **Date**: 2026-10-23
- **Amends**: ADR-0012 (the lexical arm), ADR-0031 (FTS5 was tried and rejected here)
- **Related**: ADR-0029 (partition vector cache), ADR-0027 (coverage)

## Context

After ADR-0029 cut the vector scan, `lexicalCandidates` became the largest single item in
a search. On the 10,000-row bench it was **14.6 ms of a 22.5 ms search** — 65% — and it grew
linearly with the partition.

The cost was not the index. `SELECT token, n FROM term_df WHERE token IN (...)` takes
**0.002 ms**. The cost was the *plan*. `EXPLAIN QUERY PLAN` for the scoring query:

```
CO-ROUTINE df | SCAN CONSTANT ROW | SCAN df
  | SEARCH m USING INDEX idx_memories_ns_deleted (namespace=? AND is_deleted=?)
  | SEARCH t USING INDEX sqlite_autoindex_memory_terms_1 (token=? AND memory_id=?)
  | USE TEMP B-TREE FOR GROUP BY | USE TEMP B-TREE FOR ORDER BY
```

SQLite walked the partition index and probed `memory_terms` once per row: a lookup that
should read **one posting record** became 10,000 primary-key probes. The `(token, df.n)`
list had been written as a `UNION ALL` subquery, which made it the driving side of the
join, and the planner never reconsidered.

This is the same shape ADR-0031 measured against FTS5 — the conclusion there ("MATCH has
to scan to find which rows hold a token, a postings index answers it with an equality
lookup") applies to the *current* SQL too. Replacing the index was never going to help
while the query refused to use it.

## Decision

### Ask for the plan that seeks

```
FROM memory_terms t CROSS JOIN memories m
WHERE m.id = t.memory_id AND t.token IN (?, ?, ...) AND <candidate filter>
GROUP BY t.memory_id, t.token
```

`CROSS JOIN` forbids the planner from reordering, so the plan is fixed:

```
SEARCH t USING INDEX sqlite_autoindex_memory_terms_1 (token=?)
  | SEARCH m USING INDEX sqlite_autoindex_memories_1 (id=?)
```

### …but not always

Pinning trades one partition walk for one `memories` probe **per posting**. That is the
right trade while postings are scarce and the wrong one once the chosen words are held by
half the partition. Measured at 20,000 rows, single-token queries:

| token holds | hits | planner (JOIN) | pinned (CROSS) | winner |
|---|---|---|---|---|
| 1 row | 1 | 8.814 ms | **0.005 ms** | pinned, 1,762× |
| 100 rows | 100 | 10.439 ms | **0.083 ms** | pinned, 125× |
| 400 rows | 400 | 11.592 ms | **3.232 ms** | pinned, 3.6× |
| 2,000 rows | 2,000 | 14.570 ms | 12.442 ms | pinned, 1.17× |

And at 10,000 rows with df 2,500: **9.7 ms planner vs 13.2 ms pinned** — the planner wins
by 1.36×. Same query shape, opposite answer, decided by df.

So the store picks per call, on the total df of the chosen words:

```ts
const total = tokens.reduce((sum, r) => sum + r.n, 0);
const pinned = total <= PINNED_ORDER_DF; // 2000
```

`PINNED_ORDER_DF = 2000` sits between the two measured regimes: below it the probe count is
bounded by 2,000, and the partition walk it replaces at 10k–20k rows is 4–9× more expensive.

### Two things this is not

- **Not a semantic change.** Both plans read the same rows and produce the same scores.
  `SUM(tf/df)`, `ORDER BY score DESC, id` and the `LIMIT` are unchanged; the df weighting
  moved from SQL into JS purely because the pinned plan returns `(id, token, tf)` rows
  instead of a pre-aggregated sum. A test asserts both plans agree row for row.
- **Not a tunable for callers.** There is no environment switch. The threshold is derived
  from measurements, and a store whose distribution makes 2000 wrong should be fixed here,
  not configured around.

### The `limit` still applies after aggregation

The pinned plan returns one row per `(memory_id, token)`, so the SQL cannot `LIMIT` before
the sum. Rows are aggregated in JS and sliced to `opts.limit` afterwards. The candidate set
is bounded by `LEXICAL_RAREST_K = 8` tokens under `PINNED_ORDER_DF = 2000` total df, i.e. at
most 2,000 rows in memory — the thing SQLite was already sorting in the old plan.

## Measured result

`npx vitest run`: 48 passed | 1 skipped (49 files), **588 passed | 7 skipped**.

`node scripts/scale-bench.mjs --dim 384 --ns 1 --quiet`, one namespace, hash embeddings:

| rows | search p50 | search p95 | vectorSearch p50 | lexicalCandidates p50 |
|---|---|---|---|---|
| 4,000 | **5.03 ms** (was 10.39) | 6.77 ms (was 12.51) | 1.12 ms | **0.58 ms** (was 4.63) |
| 10,000 | **7.41 ms** (was 22.53) | 8.89 ms (was 24.22) | 2.58 ms | **1.99 ms** (was 14.60) |
| 20,000 | **12.11 ms** | 13.98 ms | 5.95 ms | **3.75 ms** |

The lexical arm stops being the largest item at every size. What remains is the vector
scan, which ADR-0029 already made a memory read rather than a blob read.

## What this does not fix

- **The vector arm is still O(partition rows).** It is now the largest term: 5.95 ms of a
  12.11 ms search at 20,000 rows. ADR-0028 tried an index and lost recall; ADR-0029 made
  the scan cheap. Further gains need a better index, not a better query.
- **The write path is still O(partition rows).** `save` went 23.7 ms at 4,000 rows to
  **123.1 ms at 20,000** — `saveDetailed` runs a 5-neighbour `vectorSearch` to reconcile,
  and that scan is over the whole partition. Untouched by this ADR.
- **The 10^5 projection is now the wrong shape.** `scripts/scale-bench.mjs` extrapolates
  the whole search linearly from the measured size. That was right when the vector scan
  dominated; the lexical arm is now df-bounded rather than partition-bounded, so the
  projected number moves with the row count of the *run*, not the row count of the
  projection (124 ms extrapolated from 4,000 rows, 60 ms from 20,000 — for the same code).
  The script now also reports `vectorP50MsLinear` (still linear, still meaningful) and
  `lexicalP50MsAtThisSize` (no extrapolation) so the two arms can be read separately.

## Rejected

- **`UNION ALL` / `MATERIALIZED` / `INDEXED BY`.** Measured at 10,000 rows, df 1:
  9.199 ms (`MATERIALIZED`), 10.635 ms (`INDEXED BY` — the planner ignores it here),
  7.527 ms (`WITH acc AS (UNION ALL ...)`). All still walk the partition first.
- **`WHERE t.token IN (...)` with a plain `JOIN`.** 9.226 ms; the planner puts the IN-list
  on the right, but still drives from `memories`.
- **`EXISTS (...)` per token.** 0.005 ms at df 1 — as fast as `CROSS JOIN` — but returns a
  bitmap rather than a score, and the score needs tf. It would need a second pass.
- **A single pinned plan for all densities.** Tried; loses 1.36× at df 2,500. See the table.
- **`MIN_ROWS_FOR_DF_CAP` / `DF_CAP_RATIO` adjustment.** A different lever on a different
  problem: they bound which words may be *chosen*, not how the chosen ones are read. They
  already cap total df at `live/3` above 1,000 rows, which is why the planner path is rare
  in practice — the pinned path is the normal one, and the planner path is the safety net
  for a corpus where every candidate word is common.
