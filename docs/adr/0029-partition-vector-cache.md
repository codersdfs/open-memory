# ADR-0029: Cache decoded partitions instead of shrinking the blob

- **Status:** Accepted
- **Date:** 2026-10-23
- **Supersedes:** the withdrawn IVF proposal (never landed; one-dimensional binning lost 56% of the vector top-5, see the "Rejected" section)
- **Related:** ADR-0017 (two-phase read), ADR-0025 (int8 shortlist), ADR-0026 (why q8 is off by default), ADR-0027 (coverage)

## Context

An exact scan is the only vector search this store has. The question was how to make
it cheaper without giving up exactness — the previous attempt at an index (one
dimensional bins along the principal axis) was rejected because on clustered
embeddings it lost 56% of the vector top-5, and a memory system that silently stops
returning the right row is worse than a slow one.

The 4000-row projection and the 700 ms budget made this an engineering problem with a
number attached: `scripts/scale-bench.mjs --rows 4000 --dim 384 --ns 1` reported
search p50 28.6 ms, and projecting 10^5 rows landed at 706 ms — exactly on the line.

### Where the time actually went

The assumption in ADR-0025 was that the cost was *bytes*: 2048d floats are a lot of
bytes, so store a narrower copy. Measured per phase on 4,000 rows × 384d, one
partition:

| phase | ms |
| --- | --- |
| `SELECT id` only, no vector table | 1.3 |
| `SELECT id` + JOIN to `memory_vectors` | 2.1 |
| `SELECT id` + a 4-byte literal blob | 2.5 |
| `SELECT id` + `substr(vec, 1, 4)` | 8.1 |
| `SELECT id, vec` (1,536 bytes) | 9.6 |
| `unpackVector` over all rows | 2.6 |
| `cosineFast` over all rows | 4.8 |
| full `sort` to return 20 | 6.6 |
| **`vectorSearch` end to end** | **18.6** |

The two 4-byte rows are the tell. A literal blob costs the same as no blob at all;
four bytes *of the real column* cost almost as much as all 1,536. So the cost is not
the width of the value — it is the per-row page load SQLite pays to reach that column,
which is why the int8 copy (392 bytes instead of 1,536) bought only 1.45x. Narrowing
the blob was never going to work, and ADR-0026 was right to shelve it.

`group_concat(vec, '')` was tried as a way to pull the column out as one contiguous
buffer; it treats blobs as text and returned 45 bytes for 4,000 rows.

## Decision

**Do not read the blob again when nothing changed.** Decode a candidate set into one
flat `Float32Array` (plus ids and norms), keep it, and score from memory on repeat
queries. `SqliteVectorStore.vectorSearch` and `cosineSpread` — which
`src/core/retrieval/hybrid.ts` calls on the same population for every query — share
one decode.

1. **Exactness is preserved by construction.** The cached path runs the same dot
   product against the same vectors divided by the same norms. The only change is
   where the floats came from. Verified: 25 queries, cold and warm, returned
   identical ids *and* scores to six decimal places.
2. **The key is the resolved candidate WHERE clause**, not the namespace. `project`,
   `kind`, `status` and `knowledge` filters produce different row sets inside one
   namespace, so the key is `dim | whereSql | params`.
3. **Bounded memory, LRU.** `MEMORY_VECTOR_CACHE_MB` (default 64 MB, `off`/`0`/`false`
   disables). An entry larger than the whole budget is refused rather than evicting
   everything else and still not fitting.
4. **A write invalidates only what it touched.** `writeVectorSync` bumps
   `vectorVersion` and marks the entries holding that id unusable; the next read goes
   down the exact-scan path and rebuilds once. `deleteSoft` does the same.
   `purgeDeleted` and `compact` clear outright, since they make every entry suspect.
   A blanket clear would have made the cache useless under realtime-bench's write
   burst; with precise invalidation the measured hit rate is **99.6%** (239 hits, 1
   miss) across 120 interleaved writes and searches.
5. **Warm scoring keeps a bounded top-k instead of sorting.** The full sort to return
   twenty was 6.6 ms of an 18.6 ms search; a k-long insertion with a floor is one
   comparison per losing row and returns the same k.

## Measured result

Same machine, same data, `scripts/scale-bench.mjs --rows 4000 --dim 384 --ns 1`:

| metric | before | after | change |
| --- | --- | --- | --- |
| search p50 | 28.6 ms | **10.3 ms** | 2.8x |
| search p95 | 34.5 ms | **11.5 ms** | 3.0x |
| `vectorSearch` p50 | 22.4 ms | **1.4 ms** | 16.5x |
| `cosineSpread` p50 | ~22 ms | **0 (served from the same decode)** | — |
| projection, 10^5 rows, search p50 | 706 ms | **254 ms** | 2.8x |
| projection, 10^5 rows, search p95 | 883 ms | **284 ms** | 3.1x |

The 10^5-row projection is now **254 ms against a 700 ms budget**, where it used to
sit exactly on it. `scripts/realtime-bench.mjs` is unchanged at recall@5 1.0 with
bare/CJK/noisy all 1.0, p95 9-11 ms, throughput 60.1 op/s, zero errors and zero drops.

## What this does not fix

- **`lexicalCandidates` is now the largest remaining piece** of a search (5.0 ms of
  the 10.3 ms p50): an SQL `GROUP BY` over `memory_terms`. The next step, if one is
  wanted, is there and not in the vector scan.
- **The write path is untouched.** Reconciling a save still runs a 5-neighbour vector
  search, which now hits the cache but still scans. `save` p50 stayed at 24.8 ms.
- **Cold is not faster, only warm.** The first search of a partition still pays the
  page loads (13.0 ms decode + 0.8 ms score, no worse than the old 18.6 ms). A
  workload that touches each partition once gets nothing.
- **Memory is real.** 64 MB holds roughly 11 partitions the size of the 4000-row
  bench at 384d, or 43,000 rows of 384d vectors. A wider embedder (2048d) holds
  eight times fewer rows per megabyte. Beyond the budget the behaviour degrades to
  the old scan, which is the intended failure mode.

## Rejected

- **One-dimensional IVF along the principal axis.** Implemented, measured, reverted:
  on 4,000 clustered embeddings it matched the exact scan's top-1 79% of the time and
  its recall@5 only **43.8%**. A 384-dimensional cosine space does not project onto
  one axis in a way that separates clusters — the 30 centroid projections all landed
  inside a 0.285-wide band that the rows themselves spanned 0.634 of. Worth recording
  because the end-to-end bench did *not* notice (every bench query carries a marker
  token, so the lexical path found the answer), which is why
  `docs/realtime-bench.md` now says what that bench does and does not measure.
- **int8 shortlist (ADR-0025/0026).** Already shelved; this ADR explains why it could
  not have worked, and `MEMORY_Q8` remains an off-by-default lever.
- **`group_concat` to extract the column in one buffer.** Blobs are concatenated as
  text.
