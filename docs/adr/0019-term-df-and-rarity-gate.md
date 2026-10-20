# ADR-0019: Document frequency is data, and common words are not candidates

- **Status:** Accepted (2026-10-19) — closes the bottleneck ADR-0017 exposed. Measured with `scripts/scale-bench.mjs` (see `docs/scale-bench.md`).
- **Options:** keep recomputing df per search (`GROUP BY token` over the postings of every query word) vs **maintain a `term_df(token, n)` table in the write transaction and skip words that cannot discriminate** (chosen) vs cap the number of postings scanned per token (would truncate a word's evidence arbitrarily) vs add FTS5 (ADR-0012 already rejected it: `unicode61` does not segment CJK and the in-memory store could not implement it).
- **Why this was the next bottleneck:** after the vector scan became a two-phase read (ADR-0017), the lexical half was the larger one — 103 ms of 163 ms at 10,000 rows, and 215 of 341 at 20,000. The cost was not the join: the query first asked SQLite to count, for each of up to 64 query tokens, how many rows contain it. On a store where common words appear in nearly every row, that is hundreds of thousands of index entries scanned to answer a question whose answer changes slowly.

## What changed

1. **`term_df(token TEXT PRIMARY KEY, n INTEGER NOT NULL)`** is updated inside the same transaction as the postings: `indexTermsSync` reads the row's old tokens, decrements them, deletes and rewrites the postings, then increments. `purgeDeleted` rebuilds the table from what is left (one `GROUP BY`, on an operation that is already offline and destructive). `rebuildTermDfIfEmpty` repairs a store written by v0.4 or earlier on open.
2. **`lexicalCandidates` reads eight primary-key rows instead of aggregating postings.** The df values then enter the aggregation as a literal `UNION ALL` list, so the query only ever scans the postings of the words it actually uses.
3. **Words that appear in more than a third of a large store are skipped.** For those, BM25's idf is near zero — they cannot single a row out — and their postings are exactly what made the query expensive. A query made only of such words returns no lexical candidates and the vector half carries it, which is the same outcome as their ~0 idf contribution, reached without the scan.
4. **Both limits are gated on store size (`MIN_ROWS_FOR_DF_CAP = 1000`)** and live in `store/interface.ts` so the SQLite and in-memory stores cannot drift. Below 1000 live rows nothing changes: the real 335-row store and the 70-chunk LoCoMo bench run behave exactly as v0.4, and the v0.4 recall numbers stand.

## Measured (end-to-end `service.search`, k=5, budget 800, threshold 0.35)

| rows / dim | `lexicalCandidates` | `search` p50 |
|---|---|---|
| 2,000 / 384 | 18.8 ms | 30.2 → **15.3 ms** |
| 10,000 / 384 | 103.1 ms | 163.2 → **64.6 ms** |
| 20,000 / 384 | 214.8 ms | 341.4 → **148.9 ms** |
| 4,000 / 2048 | 37.4 ms | 122.2 → **83.7 ms** |

Projected to 10^5 rows: 384 dims **1.71 s → 0.68 s** (now at the 700 ms budget), 2048 dims 3.02 s → 2.07 s.

## Costs accepted

- **One more write per distinct token.** A row of 200 distinct tokens makes 200 small upserts; bulk writes (ADR-0018) amortise that into one transaction, and it is what buys the read path 8×.
- **`term_df` can drift from the postings** if a future write path forgets to call `indexTermsSync`. The mitigation is structural: it is the only function that writes `memory_terms`, and `rebuildTermDf` is one statement away.
- **The df cap is a heuristic with a constant.** A third is defensible for prose (a word in >33% of rows is a stopword or a boilerplate header) but it is not derived; it is pinned in one place with the measurement that motivated it.

## What is still open

The 2048-dim × 10^5 case (2.07 s) is a vector-scan problem. The next move is an index, not another layout: a quantised shortlist (int8) plus exact float32 rescore of the shortlist, or IVF. That is a separate decision with its own recall cost, so it is left as the named open item rather than smuggled into this change.
