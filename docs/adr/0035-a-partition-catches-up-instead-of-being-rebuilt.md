# 0035 — A decoded partition catches up instead of being thrown away

Date: 2026-10-25
Status: Accepted
Amends: ADR-0029 (partition vector cache), ADR-0034 (writes expire only what they changed)

## Context

ADR-0034 stopped a plain insert from expiring every cached partition, on the
argument that an insert "touches no row a snapshot holds". That argument was true
and useless. An entry is a snapshot of **which rows matched** — `flat`, `ids`,
`norms`, all sized at decode time. An insert adds a row the snapshot does not
contain, and ADR-0034 had just removed the only signal that would have told the
snapshot to stop answering. The entry kept serving its decode-time row set.

Measured before this ADR: a row inserted with a vector equal to the query scored
`1.0` through the exact scan and was **invisible through the cache**. Not slowly,
not at a lower rank — absent, until some unrelated write or eviction happened to
rebuild that partition.

The same hole had a second mouth. `updateMeta` (archive, restore, re-label) writes
`status` / `is_deleted` / `knowledge_id`, all of which are part of the candidate
`WHERE` clause, and it never touched the cache at all. Archiving a row left it in
every partition that had already decoded it. And `prune`, the decay sweep, flips
`is_deleted` on a whole set in one `UPDATE`: with 40 rows pruned, the cached search
still returned the same five memories while the exact scan returned none.

So the cache had three ways to answer a question about an older store. The common
property is that the store knows what changed and the snapshot does not.

## Decision

1. **The store keeps a log of changed row ids.** `changes: { seq, id }[]`, one
   entry per committed write, trimmed to the last 4,096 ids once it passes 8,192.
   Ids only — a few tens of KB, not a copy of the data. Every write records its id
   *after* the transaction commits: a rolled-back write must never appear in the
   log, because the log's whole contract is that its ids are in the database.
2. **An entry carries `seq` — how far into that log it is caught up.** On a cache
   hit, the store replays the log from `entry.seq` forward. Rows the entry does not
   hold are candidates to append; a row it *does* hold means the entry cannot be
   repaired by appending and must be decoded again.
3. **Membership is decided by the database, not by the log.** The log holds ids, so
   "does this new row belong to *this* partition?" is answered by one `SELECT` with
   the same `WHERE` clause that built the entry, `AND m.id IN (...)`. That query
   seeks by primary key, so it costs the same at 40 rows and at 40,000. It is also
   what makes the fix correct for `updateMeta`: a row that left the partition
   simply does not come back from the query.
4. **`absorb` merges rows in place; the arrays are allocated by capacity, not by
   row count.** `PartitionVectors` gained `rows` (live slots) separate from
   `ids.length` (capacity), and every iteration — scoring, cosine spread — runs to
   `rows`. Capacity grows by at least 25%, so a run of single inserts pays one copy
   per doubling rather than one copy per row. Reallocating to the exact needed size
   would make an insert O(partition), which is the cost the cache exists to avoid.
5. **A batch too large to append is decoded instead.** Past 1,024 rows the bound
   parameters alone rival the read, and a decode also repairs any drift.
6. **`prune` clears the cache.** It returns a count, not the ids, and it is a rare
   sweep (decay, the daemon), so dropping every decoded partition once is cheaper
   than reading the affected ids back.

## Measured result

Append versus decode, median of repeated runs (the crossover is what
`MAX_CATCHUP_ROWS` sits above):

| rows | decode | k=1 | k=8 | k=32 | k=128 | k=512 |
|---|---|---|---|---|---|---|
| 4,000 | 27.07 ms | 2.32 | 2.53 | 3.21 | 4.74 | 11.73 |
| 20,000 | 142.63 ms | 7.81 | 16.18 | 15.22 | 22.00 | 28.10 |

The append path is cheaper than a decode at every batch size measured, and the gap
widens with the partition — but the per-row cost also rises with k, which is why
the ceiling exists rather than an unbounded append.

Capacity growth is not the spike it looks like. A `Float32Array` copy of a
20,000-row entry (30.7 MB) is **6.13 ms**, and ×1.25 from 20,000 rows absorbs 5,000
inserts before the next copy — about 0.001 ms amortised per insert.

End to end, 20,000 rows / 384 dims / one partition:

| shape | p50 | p95 |
|---|---|---|
| warm search, no writes | 5.63 ms | 7.61 ms |
| search after every insert (the `saveDetailed` shape) | 5.89 ms | 7.77 ms |
| `insert` itself | 0.46 ms | 1.23 ms |

60 interleaved saves produced **1 miss in 120 searches**. A 500-row bulk load
followed by a search was 20.21 ms, and the last row of that bulk was found by its
own vector at score `1.0000` — the row the cache previously could not see.

`scale-bench` (three sizes, `--dim 384 --ns 1`):

| rows | search p50 | search p95 | vectorSearch | lexicalCandidates | save p50 | bulk rows/s | projection @ 10⁵ |
|---|---|---|---|---|---|---|---|
| 4,000 | 5.04 ms | 6.42 | 1.69 | 0.74 | 3.34 | 1,268 | 124.4 ms |
| 10,000 | 8.29 ms | 10.62 | 2.37 | 2.23 | 4.69 | 1,062 | 82.5 ms |
| 20,000 | 12.55 ms | 15.65 | 4.48 | 3.95 | 7.43 | 885 | 62.6 ms |

Full suite: 48 files / 599 tests passed, 7 skipped. The regression test asserts the
thing the old tests could not: a row inserted after the partition was decoded is
found by a search, at score ≈ 1, **without** a miss — it was appended, not
re-decoded.

## What this does not fix

- **A delete still costs a full re-decode** of its partition. An entry cannot
  remove a row without compacting the flat array, so `dropRow` marks it `stale` and
  the next read rebuilds once. Compaction on every delete is the O(rows) shape the
  cache exists to avoid.
- **`prune` drops every decoded partition**, not just the ones it touched. It
  returns a count rather than ids, and it is rare; reading the ids back would cost
  more than one rebuild.
- **The cold decode is unchanged** — ~13 ms at 20,000 rows. This ADR removes
  *repeat* decodes, not the first one.
- **The write path is still a transaction per row**, which is why `bulk` is ~1,000
  rows/s and not 10,000.
- **A partition that falls further behind than the log tail must be rebuilt.** The
  trim is safe — an entry carries its own `seq`, so an old entry becomes
  un-updatable, never wrong — but it does mean a very long write burst between two
  searches still pays one decode.

## Rejected

- **Invalidate on every insert (the ADR-0034 status quo, reverted).** Correct, and
  it made every save re-decode the partition: 113 ms of a 125 ms save at 20,000
  rows. It is what this ADR exists to undo.
- **Serve the snapshot and accept that new rows are missing.** Fast and wrong: a
  search that cannot see a row just written is not a stale answer, it is a missing
  one, and `saveDetailed` searches for neighbours immediately before inserting.
- **Append without a ceiling.** Measured cost per row rises with batch size
  (k=512 is 3.5× k=1 at 4,000 rows), and a bulk import of 5,000 rows would pay
  repeated whole-array reallocations. Decoding is cheaper past the crossover.
- **Two buffers (immutable base + append-only tail).** Measured at 20,000 rows:
  4.42 ms single-buffer versus 4.62 ms two-buffer, so only 4.4% slower — but it buys
  nothing, because ×1.25 growth already costs one 6 ms copy per 5,000 inserts while
  the tail indirection costs 0.22 ms on *every* search.
- **Growth factors of 1.5 or 2.** Fewer copies, but 2× on a 30 MB entry doubles the
  transient allocation and the peak RSS for a saving that is already ~0.001 ms per
  insert at ×1.25.
