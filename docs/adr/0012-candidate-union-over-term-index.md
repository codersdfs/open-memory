# ADR-0012: Candidate union over a term index

- **Status:** Accepted (2026-10-19) — implements WP1 of the v0.4 plan; measured against `bench/results/om-ds41.json`.
- **Options:** raise `overFetch` vs **FTS5 virtual table** vs **posting table `memory_terms` + lexical candidates merged into the vector candidate set** (chosen) vs leaving retrieval alone.
- **Why not leaving it alone:** the read path could only ever return rows the embedder had already ranked into the top-`max(20, k*4)`. BM25 re-scored that list; it never added to it. Measured on the live 295-row store, 32.5% of known targets sat outside the vector top-20 and recall@5 was *exactly* P(target inside the vector top-20) — the ceiling was the candidate set, not the scoring function. The benchmark says the same thing from the other side: of 75 zero-score answers, 51 (68%) are retrieval misses, and 35% of all questions retrieved no gold evidence at all.
- **Why not raise `overFetch`:** `vectorSearch` already parses every embedding in the partition and computes every cosine, so a wider window is cheap in CPU — but a target ranked 300th is a *ranking* failure, and widening the window mostly adds the near-noise tail of the cosine distribution to MMR and the budget. Recall, not window size, is what moved.
- **Why not FTS5:** `node:sqlite` does ship FTS5, but `unicode61` treats a CJK run as one token, while `bm25.ts` already tokenizes Chinese into unigrams + bigrams (and the `Memory` BM25 tests pin that). Two lexical scorers, two rankings, and the SQL ranker cannot be reused by `InMemoryVectorStore`, which the tests and the embedder-switch path both use.
- **Decision:** an inverted index `memory_terms(token, memory_id, tf)` maintained inside the same transaction as every text write, plus `VectorStore.lexicalCandidates()` (optional on the interface, so a v0.3 third-party store still compiles) returning the rows whose query overlap is highest, capped at `overFetch`. `HybridRetriever.searchOne` merges the two candidate lists by id.

## Why the merge keeps the gate honest

A row found only by words enters with `vectorScore = 0` and must clear the same relevance gate, the same threshold and the same MMR/budget as a vector row. Being lexically plausible buys a *ticket to compete*, not a score. The union is also bounded on purpose: merging every query term's LIKE results instead of the top-`overFetch` candidates measured **worse** (recall@5 87.2% → 82.1%), because the extra rows crowded real matches out of the 800-token budget.

## Why BM25 needed real `df` and `avgLen`

`avgLen = 20` and `idf = 1` were calibrated on one-sentence memories. Against the benchmark's 1,200-character session chunks (~275 tokens) the length penalty divided every term contribution by ~14, collapsing BM25 to ~0.01 on rows that contained the query verbatim — which is precisely how exact-match evidence failed a 0.35 gate. `bm25Score(query, doc, stats)` now takes `{avgLen, docs, df}` computed over the merged candidate set, normalizes by the score a perfect-length document would earn, and falls back to v0.3 behavior without `stats` (all six `tests/bm25-cjk.test.ts` cases unchanged).

## Measured (hash embedder, 70 LoCoMo chunks, 152 questions, k=5, budget 800, threshold 0.35)

| metric | vector-only (v0.3) | union (v0.4) |
|---|---|---|
| any gold evidence in context | 27.6% (42/152) | **62.5% (95/152)** |
| all gold evidence in context | 21.1% (32/152) | **54.6% (83/152)** |
| single-hop (cat4) | 18/70 | **55/70** |
| temporal (cat2) | 13/37 | **24/37** |
| multi-hop (cat1) | 10/32 | 12/32 |
| blocks per query | 3.24 | 3.22 |
| search p50 (in-memory) | 0.9 ms | 4.0 ms |

Real store (299 live rows, copied with `VACUUM INTO`): `init()` 50 ms (one full posting backfill), 20 mixed Chinese/English queries at p50 **10.8 ms**, p95 15.2 ms, 0 empty results — the acceptance line is p50 ≤ 700 ms.

## Cost

- Write amplification: one INSERT per distinct token per row (200-char memory ≈ 80 rows). `insert()` and `updateEmbedding()` now run in `BEGIN IMMEDIATE` transactions; `retryWrite` still wraps them.
- `init()` backfills up to 5,000 rows per boot (idempotent `NOT EXISTS`), so an existing `memory.db` pays once.
- The index is derived data: `DROP TABLE memory_terms` plus a restart rebuilds it exactly.

## Rollback

Returns are additive and read-path only. A store that does not implement `lexicalCandidates` gets the v0.3 behavior (that is also the A/B arm the table above compares against); reverting the commit restores it for the built-in stores. No migration and no data rollback: `memory_terms` can be dropped at any time.
