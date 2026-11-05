# 0036 — A rewrite patches the snapshot in place

Date: 2026-10-25
Status: Accepted
Amends: ADR-0029 (partition vector cache), ADR-0034 (writes expire only what they changed)

## Context

ADR-0035 taught a decoded partition to catch up with rows that *arrived* after the
decode. It did nothing for rows whose *numbers moved*, and that turned out to be the
expensive shape.

`updateEmbedding` — the call behind `reembed`, behind a model switch, behind any
re-embed of an existing row — went through `noteChange`, which calls
`dropRow(id)`. `dropRow` marks the entry `stale`, and a stale entry sends the next
read down the exact-scan path: a full decode of the partition. For a single write
that is the right trade (an entry cannot remove a row without compacting the flat
array). For a rewrite it is not, because **the row never leaves the candidate set** —
only its vector changes, and the writer is holding the new vector.

Measured at 20,000 rows / 384 dims, one rewrite followed by one search, forty times:

```
cache after warm:     {"hits":0,"misses":1}
rewrite+search ×40:   p50 109.82 ms   max 134.40 ms
cache after rewrites: {"hits":0,"misses":41}
```

Forty rewrites produced forty-one misses: every rewrite paid a whole-partition
decode. `reembed` rewrites every row of a partition in turn, so it degenerated to
O(rows²) — 20,000 rows would have cost 20,000 decodes.

## Decision

1. **A rewrite is not a change.** `noteRewrite(id, embedding)` patches the new
   vector into every entry that holds the row, and the store's change log never sees
   it. The log exists for changes the snapshot cannot be told about row by row; a
   rewrite can be told completely.
2. **`PartitionCache.patchRow(id, vec, norm)` overwrites in place.** It finds the
   row through the entry's `index` and writes `dim` floats and one norm. O(dim), no
   allocation, no invalidation. It returns whether any entry held the row.
3. **The entry's `index` became `Map<string, number>` (id → slot).** `dropRow` and
   `absorb` ask a membership question on every write, and a linear scan of 20,000
   ids cost more than the scoring it guards; the slot is what makes a rewrite a
   copy instead of a lookup followed by a search.
4. **A row the entry does not hold is not patched, and does not need to be.** Either
   it is in the change log as an insert — in which case `catchUp` will read the row
   and get the new vector — or the entry does not contain it at all. This is why a
   rewrite needs no log entry of its own.
5. **A width mismatch still invalidates.** If the entry decoded the row at another
   `dim`, it predates a reembed and cannot be patched in place; `patchRow` marks it
   stale instead of writing a vector of the wrong length.
6. **Nothing is patched inside a transaction.** Both `noteChange` and `noteRewrite`
   run after the commit. A rolled-back write must not leave a vector in the cache
   that the database never accepted.

## Measured result

The same 20,000-row workload, after this ADR:

| shape | before | after | |
|---|---|---|---|
| rewrite + search, p50 | 109.82 ms | **5.06 ms** | 21.7× |
| rewrite + search, p95 | — | 7.97 ms | |
| warm search, no writes | 4.73 ms | 4.73 ms | unchanged |
| misses over 40 rewrites | 41 | **0** | |

The rewrite cost is now within noise of a warm search, which is the point: the
snapshot stays correct *and* warm, so the price of a rewrite is `dim` floats.

`scale-bench` (three sizes, `--dim 384 --ns 1`) — no regression against ADR-0035:

| rows | search p50 | search p95 | vectorSearch | lexicalCandidates | save p50 | bulk rows/s | projection @ 10⁵ |
|---|---|---|---|---|---|---|---|
| 4,000 | 4.67 ms | 5.94 | 1.03 | 0.54 | 3.26 | 1,289 | 115.3 ms |
| 10,000 | 7.71 ms | 9.90 | 2.34 | 2.12 | 4.50 | 1,135 | 76.7 ms |
| 20,000 | 11.93 ms | 13.64 | 4.43 | 3.96 | 7.29 | 969 | 59.5 ms |

`realtime-bench --embedder synthetic --rate 20`: `ok: true`, `recall5` 0.9944,
by mode `bare 1.00 / cjk 1.00 / noisy 1.00 / semantic 0.980`, `recall1` 0.900,
`mrr` 0.934, `errors 0`, `dropped 0`, `search p50 25 / p95 35 ms`.

Full suite: 48 files / 600 tests passed, 7 skipped. Three tests exist for this ADR:
a rewritten row moves in the ranking **without** a miss, a reembed run over every
row in turn produces **zero** misses, and a rewrite in another namespace leaves this
partition warm.

## What this does not fix

- **A delete still costs a full re-decode.** The row must leave the candidate set,
  and an entry cannot remove a row without compacting the flat array. `dropRow` keeps
  marking the entry stale for deletes and re-labels, which is the correct trade at
  one decode per delete rather than one per write.
- **`prune` still clears the whole cache.** It returns a count rather than ids, so
  there is nothing to patch row by row.
- **The cold decode is unchanged** — ~13 ms at 20,000 rows.
- **A rewrite of a row no entry holds still does an O(entries) scan** to find that
  out. `patchRow` walks the map looking for the id. With one cached partition that is
  one lookup; with many partitions it is one lookup each. It is not on the hot path
  (rewrites are a maintenance shape, not a per-search one), so it is left simple
  rather than indexed by id.
- **The write path is still a transaction per row**, which is why `bulk` is ~1,000
  rows/s and not 10,000.

## Rejected

- **Keep invalidating on rewrite (the ADR-0034/0035 status quo).** Correct, and it
  made a reembed run quadratic: 109.8 ms per rewrite-plus-search at 20,000 rows.
- **Compact the flat array on delete so an entry can lose a row.** Correct, and
  O(rows) per delete — the same shape the cache exists to avoid.
- **Patch by scanning `ids` linearly instead of carrying a `Map`.** Measured worse
  than the map on the membership question, which `dropRow` asks on *every* write, not
  just rewrites.
- **Log rewrites and let `catchUp` replay them.** Works, but makes a rewrite pay a
  log entry, a replay, a `SELECT`, and an `absorb` — for a change the writer could
  describe in `dim` floats it already holds. The log stays for what it is good at:
  changes the snapshot cannot be told about.
- **Patch the snapshot before the transaction commits.** Saves nothing measurable and
  breaks the invariant that the cache never holds a vector the database rejected.
