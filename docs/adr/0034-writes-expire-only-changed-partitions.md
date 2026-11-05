# 0034 — A write expires only the partitions it changed

Date: 2026-10-24
Status: Accepted
Amends: ADR-0029 (partition vector cache)

## Context

ADR-0029 introduced a per-partition decode cache so a repeated search scores from a
`Float32Array` instead of re-reading every vector BLOB from SQLite. It made warm
searches 16× cheaper. Its invalidation rule was: *any* vector write bumps a
store-wide `vectorVersion`, and a cached entry whose `version` no longer matches is
treated as unusable.

That rule was written for correctness — a decode that included a rewritten row is a
lie — but it is far stronger than correctness requires. `dropRow(id)` already marks
exactly the entries that held `id`. The unconditional `vectorVersion++` next to it
undid that precision: **one insert expired every cached partition in the store.**

Nothing noticed, because the cost only appears when a write sits between two
searches. A benchmark that searches in a loop sees a warm cache; a benchmark that
writes in a loop sees `insert` at 0.2 ms. The expensive shape is the one real
callers actually use — `saveDetailed`, which searches for neighbours and *then*
inserts.

### Measured (20,000 rows, 384 dims, one namespace, hash embedder)

Every `saveDetailed` runs one `vectorSearch(limit 5)` before its insert. Instrumented
per store call:

| call | per save | what it did |
|---|---|---|
| `embed` | 0.2 ms | — |
| **`vectorSearch`** | **113.3 ms** | 19 of 20 calls fell back to the exact scan |
| `insert` | 0.7 ms | — |
| total `saveDetailed` | **124.8 ms** | |

The same `vectorSearch`, run standalone without a write in between: **0.26 ms**. The
search was not slow; it was re-decoding 20,000 rows (31.8 MB of `Float32Array`) on
almost every save.

Per-call breakdown of where the time went, after the fix, confirmed the mechanism:
`scans` (exact-scan fallbacks) went from 19/20 to 0/20 on the same workload.

## Decision

1. **A write invalidates only what it touched.** `PartitionCache.dropRow` now returns
   whether it matched an entry, and the store bumps `vectorVersion` only when it did.
   A plain insert matches nothing — it adds a row without changing any decoded row —
   so every cached partition survives it.
2. **A rewrite still invalidates.** `updateEmbedding` and `deleteSoft` go through the
   same path; when they match, the version moves and the next search rebuilds exactly
   once. The correctness property ADR-0029 promised is unchanged: no search is ever
   answered from a decode that included a rewritten or deleted row.
3. **A stale hit is charged as a miss.** `get` used to count a hit for an entry that
   `partitionVectors` then rejected as stale, so the stats reported a healthy hit rate
   while every save rebuilt the partition. `markStaleMiss()` moves that count. This is
   not cosmetic: it is the instrument that would have caught the bug, and the new test
   asserts on it rather than on wall time so it cannot go flaky.
4. **The entry is marked in the map, not through the caller's reference.** `set` stores
   a spread copy, so writing `version = -1` through the object returned by `get` marks
   a detached object and silently does nothing. `dropRow` now re-inserts the map entry.

## Measured result

`scale-bench --rows 4000 --dim 384 --ns 1` (reconcile on, 50 save samples):

| metric | before | after | |
|---|---|---|---|
| `save.p50Ms` | 27.47 | **4.25** | 6.5× |
| `save.meanMs` | 27.14 | **5.63** | 4.8× |
| `search.p50Ms` | 10.39 | **5.47** | 1.9× |
| `search.p95Ms` | 12.51 | **6.42** | 1.9× |
| projection @ 10⁵ rows | 256.5 | **135.1** | 1.9× |

`scale-bench --rows 10000`: `save.p50` **4.96 ms** / `p95` 16.74 ms, `search.p50`
**7.92 ms** / `p95` 10.02 ms, projection **78.8 ms**.

`realtime-bench --embedder synthetic --rate 20`: `recall5` 0.9722, by mode
`bare 1.00 / cjk 1.00 / noisy 1.00 / semantic 0.918`, `errors 0`, `dropped 0`,
`search p50 28 / p95 36 ms`.

Full suite: 48 files / 590 tests passed, 7 skipped. Two of them are new and exist
only for this ADR: one asserts an insert does not expire the partition, the other
asserts a rewrite still does.

## What this does not fix

- **A rewrite still costs a full re-decode** of its partition on the next search.
  That is ADR-0029's accepted trade: rebuilding once is cheaper than compacting a
  6 MB array on every write. A store that rewrites constantly will still pay it; the
  fix for that is incremental patching of the flat array, not a weaker invalidation.
- **The cold decode is unchanged** at ~3.5 ms per 8,000 rows (13.0 ms at 20,000 rows).
  This ADR removes *repeat* decodes, not the first one.
- **`lexicalCandidates` is now the largest remaining store item** at 0.97–2.38 ms,
  after ADR-0033 pinned its join order. `vectorSearch` is 1.67–2.48 ms.
- **The write path is still a transaction per row** (~0.7 ms insert), which is why
  `bulk` is 1,375 rows/s and not 10,000.

## Rejected

- **Invalidate on write, accept the cost.** That is the status quo this ADR replaces;
  it made the common write-then-search shape 24× slower than it needed to be.
- **Never invalidate, serve the stale decode.** Fast, and wrong: a superseded row
  would keep being returned with its old vector, which is the one thing ADR-0029
  refused to allow.
- **Compact the flat array on every write.** Correct and O(rows) per write, i.e. the
  same quadratic shape the cache exists to avoid.
- **Timer-based or size-based expiry.** Would trade a correctness proof for a bound
  nobody can state.
