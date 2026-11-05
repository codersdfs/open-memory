# Scale benchmark

A memory install is expected to reach 10^5 rows on one machine while every retrieval
stays under the 700 ms budget. `scripts/scale-bench.mjs` is the ruler for that ceiling:
it runs the real stack (`MemoryService` + `SqliteVectorStore`, the same `save` /
`saveMany` / `search` an agent calls) against a throwaway SQLite file, so the same
command can be run before and after a storage or retrieval change on the same machine
and the one-line JSON diffed in CI.

Nothing in the repo is touched and no network is used.

## What one run measures

| phase | call | what the number means |
| --- | --- | --- |
| bulk write | `service.saveMany(batch, { reconcile: false })` | import/replay throughput in rows/s (headline, CI gate). One commit per batch, no write-time reconcile. |
| marginal write | `service.save()` per row at full corpus size | the per-write cost a live agent pays. With reconcile on it runs a 5-neighbour vector search plus a commit **per row**, so it is O(partition rows) per write. |
| search | `service.search({ query, namespace, k: 5, budgetTokens: 800, threshold: 0.35 })`, 2 warmups + 20 measured | end-to-end p50/p95. Two store phases are timed separately: `store.vectorSearch` (vector scan) and `store.lexicalCandidates` (term-index scan). |
| storage | file size after `wal_checkpoint(TRUNCATE)` | DB bytes, bytes/row, bytes still in `-wal` |
| memory | `process.memoryUsage().rss` sampled between phases | RSS peak |
| projection | measured p50/p95 × 10^5/rows, bytes/row × 10^5 | the extrapolation columns the scale target is stated in |

Percentiles use linear interpolation over the sorted samples. The DB is created under
`os.tmpdir()` and removed afterwards (including `-wal`/`-shm`); `--keep-db` keeps it.

## Reproduce

Plain `node` re-execs the script under the repo's `tsx` devDependency, so the TS
sources import straight from `src/` with no build step. `npx tsx scripts/scale-bench.mjs`
works too.

```sh
# the three baselines below
node scripts/scale-bench.mjs --rows 2000  --dim 384  --ns 1
node scripts/scale-bench.mjs --rows 10000 --dim 384  --ns 1
node scripts/scale-bench.mjs --rows 4000  --dim 2048 --ns 1

# full performance JSON for a before/after diff
node scripts/scale-bench.mjs --rows 10000 --dim 384 --out bench-10000x384.json

# CI regression gate: non-zero exit when p95 > 700 ms or rows/s < 100
node scripts/scale-bench.mjs --rows 10000 --dim 384 --quiet --assert > bench.json
```

`node:sqlite` prints `ExperimentalWarning: SQLite is an experimental feature` on stderr;
it is harmless and the script's JSON on stdout is unaffected.

## Corpus

Each memory is a synthetic passage of ~1,100 characters, the same shape as the original
scale investigation:

```
Session 17 (2026-05-19): cache token module router ... latency topic17
```

- the body is words from the same 20-word vocabulary (so bytes/row stays comparable
  with the pre-rewrite numbers);
- the last token is a codename `topic<k>` with `k = i % 64`. It exists because every
  ordinary word in the vocabulary appears ~100× per row: document frequency is ~100 %
  for any natural query, BM25 idf is ~0, and the relevance gate filters **everything**
  (`hits: 0`), which skips MMR, budget enforcement and reinforce. A token with
  df ≈ 1.6 % keeps the query realistic and lets a run reach the end of the pipeline.
  Hits are 2 rather than 5 because each synthetic memory needs ~277 tokens and
  `budgetTokens` is 800.
- 384-d uses the built-in `HashEmbeddingProvider`. Other widths use a deterministic
  dense embedder (xorshift32 seeded from the text, normalized), so a 2048-d BLOB is
  8,192 bytes like a real provider's.
- `MEMORY_VECTOR_WEIGHT` is pinned to `0` by default, so both embedders take the hash
  setup's retrieval path (vector term weight 0, no extra `cosineSpread` scan).
  `--vector-weight 0.6` measures the real-provider arm.

Corpus seed defaults to 42; text length, batch size, sample counts and search knobs are
flags (`--help` lists all of them).

## Baseline — before the rewrite

Measured by the original scale investigation on the JSON-text-embedding tree
(`embedding` stored as JSON text in `memories`, one commit per save, single-phase read):
2,000 rows @384d → ~45 ms per search and ~11.9 KB/row; 10,000 rows @384d → 279 ms;
4,000 rows @2048d → ~24 KB/row. Extrapolated to 10^5: 2.8 s (384d) / 6.0 s (2048d),
1.1 GB / 2.2 GB.

These numbers are the "before" column; this script was not re-run on that code.

## Baseline — current tree

Measured 2026-10-19 on Windows 11, Node v24.11.1, 16 logical CPUs, temp DB on the system
drive. Tree: rev `1d7a372` plus the in-flight rewrite (BLOB vectors, ADR-0017; bulk
insert, ADR-0018; two-phase read; maintained `term_df`, ADR-0019). One namespace,
`--vector-weight 0`, reconcile on.

Run twice the same day: **before** the term-index change, then **after**. Only the
lexical phase changed in between.

| rows | dim | bulk rows/s | save p50 | search p50 before | search p50 after | search p95 after | DB | bytes/row |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2,000 | 384 | 1,630 | 14.0 ms | 30.2 ms | **15.3 ms** | 16.4 ms | 14.5 MB | 7,397 |
| 10,000 | 384 | 1,113 | 55.1 ms | 163.2 ms | **64.6 ms** | 77.6 ms | 70.9 MB | 7,397 |
| 20,000 | 384 | 842 | 128.1 ms | 341.4 ms | **148.9 ms** | 162.5 ms | 141.7 MB | 7,411 |
| 4,000 | 2048 | 2,588 | 72.6 ms | 122.2 ms | **83.7 ms** | 101.7 ms | 54.3 MB | 14,046 |

Three runs of the 2,000/384 row moved p50 27.9 / 30.2 / 31.9 ms before the change and
15.3 ms after, and bulk 1,591 / 1,607 / 1,813 rows/s, so that row is reproducible to
roughly ten percent (worse on a loaded machine). The 20,000-row run is a linearity
check, not a routine baseline.

Projected to 10^5 rows in one namespace (linear in rows; the 384-d column scales the
20,000-row run, the 2048-d column the 4,000-row run, both divide by total rows including
the marginal-save samples):

| dim | search p50 | search p95 | DB |
| --- | --- | --- | --- |
| 384 | **0.68 s** (was 1.71) | 0.74 s (was 1.83) | 0.69 GB |
| 2048 | **2.07 s** (was 3.02) | 2.51 s (was 3.63) | 1.31 GB |

So 384 dimensions at 10^5 rows now lands at roughly the 700 ms budget instead of 2.4×
over it, and the remaining overrun is the vector scan at 2048 dimensions, which is an
index problem (ADR-0019's open half), not a layout one.

## The int8 shortlist, measured and left off (ADR-0025 / ADR-0026)

An attempt to fix the 2048-d column by reading four times fewer bytes per row is in the
tree as an opt-in path (`MEMORY_Q8=on`): each vector keeps a per-dimension signed byte
plus a `maxAbs` scale, the scan ranks on those, and only the shortlist is re-scored
against the float32 blob.

10,000 rows at 2048d, same data, each mode in its own process:

| | q8 off (default) | q8 on |
| --- | --- | --- |
| p50 | 181.6 ms | 125.5 ms |
| p95 | 206.7 ms | 141.4 ms |
| bytes/row | 14,112 | 17,702 |
| 10^5 projection (p50) | 1,586 ms | ~1,094 ms |

1.45×, +25% disk, and still over budget — so it is **off by default**. The reason it
cannot be pushed further is that the cost was never mostly the bytes:

| Query on the same store | Time |
| --- | --- |
| `SELECT id, vec, norm` (8,192 B/row) | 116.0 ms |
| `SELECT id, q8, scale, norm` (2,048 B/row) | 90.4 ms |

Four times fewer bytes bought 26 ms. The rest is per-row object construction, the JOIN,
and result-set marshalling, which shrink only if the number of *rows* read shrinks. That
is what an index does and a narrower blob does not.

## Where the time goes

| rows | dim | `vectorSearch` p50 | `lexicalCandidates` p50 | `search` p50 |
| --- | --- | --- | --- | --- |
| 2,000 | 384 | 10.4 ms | 15.5 → *bounded* | 15.3 ms |
| 10,000 | 384 | 52.4 ms | 103.1 → **12.0 ms** | 64.6 ms |
| 20,000 | 384 | 118.8 ms | 214.8 → *bounded* | 148.9 ms |
| 4,000 | 2048 | 62.3 ms | 37.4 → *bounded* | 83.7 ms |

The lexical phase used to be the larger half: scoring it recomputed document frequency
with a `GROUP BY` over the postings of every query word. With `term_df` maintained in
the write transaction, and words that appear in more than a third of a large store
skipped entirely, 103 ms became 12 ms at 10,000 rows — the vector scan is the wall
again, which is where an index would go.

## The partition vector cache (ADR-0029)

The table above is the "before" column for the cache work. The question it answers is
whether an index is the only way out; it is not. `SELECT ... JOIN memory_vectors` was
11.7 ms of an 18.6 ms search at 4,000 rows × 384d, and splitting that query proved the
cost is *touching the blob column at all*, not its width — `SELECT id` alone is 1.3 ms,
adding a 4-byte literal blob keeps it at 2.5 ms, but four bytes of the real `vec` column
costs 8.1 ms and all 1,536 bytes cost 9.6 ms. SQLite pays a per-row page load for that
column regardless of how many of its bytes are wanted, which is exactly why the int8
copy could not help.

So the cache does not shrink the blob, it stops re-reading it. A candidate set is
decoded once into one flat `Float32Array` (`src/core/store/partitionCache.ts`), keyed by
the resolved `WHERE` clause (filters, not just namespace), bounded by
`MEMORY_VECTOR_CACHE_MB` (default 64), and invalidated per row on write. `vectorSearch`
and `cosineSpread` — which `hybrid.ts` calls on the same population every query — share
one decode.

Same machine, same command (`--rows 4000 --dim 384 --ns 1`), warm cache:

| metric | before | after |
| --- | --- | --- |
| search p50 | 28.6 ms | **9.5–10.8 ms** |
| search p95 | 34.5 ms | **10.6–11.8 ms** |
| `vectorSearch` p50 | 22.4 ms | **1.3–1.5 ms** |
| `cosineSpread` p50 | ~22 ms | **served from the same decode** |
| 10^5 projection, search p50 | 706 ms | **234–267 ms** |
| 10^5 projection, search p95 | 883 ms | **261–291 ms** |

The 10^5-row projection is now a factor of ~2.8 under the 700 ms budget where it used
to sit exactly on it. The result is identical by construction — same vectors, same
cosine, same top-k — and was checked query by query against the uncached path.

What it does not do: recycle the cost for a cold partition (the first search after
startup still pays the page loads, no worse than before), or remove the linear-in-rows
term. (It also does not speed up writes — see ADR-0034 for why that took a second fix:
the cache was being invalidated wholesale on every insert, which is what made a save pay
a re-decode it did not need.) With the vector phase down to 1.3 ms,
`lexicalCandidates` became the largest piece of a search (5.2–6.2 ms of the
9.5–10.8 ms p50) — that is where the next attempt went, see below.

## The lexical arm was asking for the wrong plan (ADR-0033)

`lexicalCandidates` was not slow because of its index. `SELECT token, n FROM term_df
WHERE token IN (...)` takes 0.002 ms. It was slow because of its *plan*:
`EXPLAIN QUERY PLAN` showed SQLite walking `idx_memories_ns_deleted` over the whole
partition and probing `memory_terms` once per row, because the df list was written as a
`UNION ALL` subquery and became the driving side. A lookup that should read one posting
record cost 10,000 primary-key probes.

`CROSS JOIN` (the planner may not reorder it) fixes the order to
`SEARCH t (token=?) → SEARCH m (id=?)`. But pinning trades one partition walk for one
`memories` probe *per posting*, which stops paying once the chosen words are held by
thousands of rows: at 10,000 rows with df 2,500 the planner is 1.36× **faster**
(9.7 vs 13.2 ms). So the store picks per call on the chosen words' total df, with the
cutover at `PINNED_ORDER_DF = 2000`. Both plans read the same rows and score identically;
only the order of access changes.

Same machine, `--dim 384 --ns 1 --quiet`:

| rows | `lexicalCandidates` p50 | search p50 | search p95 |
| --- | --- | --- | --- |
| 4,000 | 4.63 → **0.58 ms** | 10.39 → **5.03 ms** | 12.51 → **6.77 ms** |
| 10,000 | 14.60 → **1.99 ms** | 22.53 → **7.41 ms** | 24.22 → **8.89 ms** |
| 20,000 | — → **3.75 ms** | — → **12.11 ms** | — → **13.98 ms** |

The lexical arm is no longer the largest item at any of these sizes. What is left is the
vector scan (5.95 ms of the 12.11 ms search at 20,000 rows) and, on the write side, the
reconcile neighbour lookup.

## The write path was paying for a cache it never used (ADR-0034)

That "reconcile neighbour lookup" was the accepted explanation for why a single `save`
cost 23.7 ms at 4,000 rows and 123.1 ms at 20,000 — a full partition scan per write, the
price of ADR-0018's per-row reconcile. Measuring the two calls separately says otherwise.
At 20,000 rows, the neighbour `vectorSearch` on its own is **0.26 ms**; the *same* call
inside `saveDetailed` is **113 ms of a 124.8 ms save**, and 19 of 20 of them fell through
to the exact scan. The search was not slow — it was re-decoding 20,000 rows (31.8 MB)
before every insert, because `writeVectorSync` bumped a store-wide version and expired
every cached partition, including the ones the insert did not touch.

Invalidation is now scoped to the rows a write actually changed. An insert changes no
decoded row and expires nothing; a rewrite or a delete expires exactly the partitions
that held it, once. `--dim 384 --ns 1 --quiet`:

| rows | save p50 | search p50 | search p95 |
| --- | --- | --- | --- |
| 4,000 | 27.47 → **4.25 ms** | 10.39 → **5.47 ms** | 12.51 → **6.42 ms** |
| 10,000 | 62.77 → **4.96 ms** | 22.53 → **7.92 ms** | 24.22 → **10.02 ms** |

The 10^5 projection follows the search: 256.5 → **135.1 ms** at 4,000 rows' run, and
**78.8 ms** extrapolated from the 10,000-row run.

The 10^5 projection in the JSON is a linear extrapolation of the whole search, which was
honest while one scan dominated both arms. It is not honest any more: the lexical arm is
bounded by df rather than by partition size, so the projected number depends on the
`--rows` of the *run*, not on the projection target (extrapolating from 4,000 rows gives
124 ms, from 20,000 rows gives 60 ms, same code). The output therefore also carries
`projection.vectorP50MsLinear` (still meaningful — that arm is genuinely linear) and
`projection.lexicalP50MsAtThisSize` (not extrapolated). Read `searchP50Ms` as an upper
bound, and the two components when the distinction matters.

## Not invalidating was a correctness bug (ADR-0035)

Scoping invalidation to "the rows a write changed" rested on an argument that was true
and useless: an insert changes no decoded row, therefore it expires nothing. An entry is
a snapshot of **which rows matched**, so a row inserted after the decode was not in it and
could not be returned. Measured: a row inserted with a vector equal to the query scored
**1.0** through the exact scan and was **invisible** through the cache — not ranked low,
absent, until something else happened to rebuild that partition.

Two more mouths on the same hole. `updateMeta` (archive, restore, re-label) writes
`status` / `is_deleted` / `knowledge_id`, all part of the candidate `WHERE`, and never
touched the cache at all. And `prune` flips `is_deleted` on a whole set in one `UPDATE`:
with 40 rows pruned, the cached search still returned the same five memories while the
exact scan returned none.

The fix is a log of changed row ids (ids only, trimmed to the last 4,096) plus a `seq` on
each entry. On a cache hit the store replays what changed since the decode and asks the
database — with the same `WHERE` that built the entry — which of those ids belong here,
then appends them in place. Membership stays the database's answer, so a row that left the
partition (`updateMeta`) simply does not come back. `prune` clears the cache wholesale,
because it returns a count rather than ids and is a rare sweep.

Append versus decode, median, so the ceiling `MAX_CATCHUP_ROWS` sits above is a measured
one:

| rows | decode | k=1 | k=8 | k=32 | k=128 | k=512 |
| --- | --- | --- | --- | --- | --- | --- |
| 4,000 | 27.07 ms | 2.32 | 2.53 | 3.21 | 4.74 | 11.73 |
| 20,000 | 142.63 ms | 7.81 | 16.18 | 15.22 | 22.00 | 28.10 |

Capacity grows by ≥25%, which is not the spike it looks like: copying a 20,000-row entry
(30.7 MB) is **6.13 ms**, and ×1.25 from 20,000 rows absorbs 5,000 inserts before the next
copy — about 0.001 ms amortised per insert.

End to end at 20,000 rows / 384 dims: warm search **5.63 ms**, search after every insert
(the `saveDetailed` shape) **5.89 ms**, `insert` itself **0.46 ms**. Sixty interleaved
saves produced **1 miss in 120 searches**, and the last row of a 500-row bulk load was
found by its own vector at score `1.0000`.

## Then rewrites were the expensive shape (ADR-0036)

`reembed` rewrites every row of a partition in turn through `updateEmbedding`, which went
through the same invalidation path as a delete. A rewrite does not remove a row from the
candidate set — only its numbers move — but marking the entry stale sends the next read
down the exact-scan path, so each rewrite paid a whole-partition decode:

```
cache after warm:     {"hits":0,"misses":1}
rewrite+search ×40:   p50 109.82 ms   max 134.40 ms
cache after rewrites: {"hits":0,"misses":41}
```

Forty rewrites, forty-one misses: a full re-embed of 20,000 rows was O(rows²).

A rewrite is the one change the writer can describe completely, and it is holding the new
vector. `patchRow` overwrites the row at the slot the entry already keeps for it — `dim`
floats and one norm, no allocation, no invalidation — and the change log never sees it. A
row the entry does not hold needs no patch: either it is in the log as an insert (so
`catchUp` reads the new vector) or the entry does not contain it.

| shape | before | after | |
| --- | --- | --- | --- |
| rewrite + search, p50 | 109.82 ms | **5.06 ms** | 21.7× |
| misses over 40 rewrites | 41 | **0** | |

## What the numbers still say

1. **Search scales with the partition, but no longer linearly.** 4k → 10k rows gives
   4.7 → 7.7 ms (it was 10.4 → 22.5 before ADR-0033, close to linear). Three things
   changed the slope: the vector arm is a decoded-array read rather than a blob re-read
   (ADR-0029), the lexical arm is answered from the posting list, so it tracks df instead
   of partition size (ADR-0033), and neither arm is rebuilt needlessly on a write
   (ADR-0034/0035/0036). What is left is the vector scan, which is still one pass over
   the partition.
2. **The term index is no longer the bottleneck.** It was 103 ms at 10,000 rows before
   `term_df` (ADR-0019), 14.6 ms after the vector cache exposed it again (ADR-0029), and
   **2.1 ms** now that the query seeks the token index instead of walking the partition
   (ADR-0033). The vector phase is the largest item again at every size measured.
3. **The vector phase grows slightly faster than linear** at the top end (2.3× for
   2× rows between 10k and 20k on the pre-ADR-0033 tree). The live vector set passes
   ~30 MB around 20k rows, consistent with page-cache pressure rather than an algorithmic
   change.
4. **A single write was O(partition rows) because of the cache, not the scan.**
   `save()` cost 14.0 → 55.1 → 128.1 ms at 2k → 10k → 20k, and it looked like the price
   of reconciling against 5 nearest neighbours — a full partition scan per write. It was
   not: the neighbour search is 0.26 ms once its partition is decoded, and the 113 ms was
   a *re-decode*, because every vector write bumped a store-wide version and expired
   every cached partition (ADR-0034). With invalidation scoped to the rows a write
   actually changed, `save` p50 is **3.3 ms at 4k** and **4.5 ms at 10k**. Bulk is
   still ~10× faster per row at 10k (1,135 vs 222 rows/s) because of the commit and the
   reconcile search per row — the entire point of ADR-0018: a full `save()` load of 10k
   is minutes, whereas `saveMany` does it in 9 s.
5. **Commit/fsync is not what makes bulk writes slow here.** 500-row batches, 20
   commits for 10k rows, 9.0 s total ≈ 450 ms per batch — that is embedding plus
   term-index and df writes, not per-commit durability. The counterintuitive check: the
   2048-d run (8 KB vectors, 8× the vector bytes) is *faster* per row than the 384-d
   run (2,588 vs 1,113 rows/s) because its synthetic embedder is cheaper than hashing
   1,100 characters. rows/s includes the embedder; it is not a storage-only number.

## Why there is no vector index

One was built and reverted (ADR-0029's "Rejected" section): binning rows along the
principal axis, the cheapest exact-preserving-looking structure available without a
dependency, matched the exact scan's top-1 79% of the time and its recall@5 **43.8%** on
4,000 clustered embeddings. 384-dimensional cosine space does not project onto one axis
in a way that keeps clusters apart. The cache replaces that plan: it is exact, it needs
no index maintenance, and `MEMORY_VECTOR_CACHE_MB=off` reverts it.

The end-to-end recall bench did **not** notice the IVF loss, because every bench query
carries a marker token and hash embeddings set the vector weight to zero
(`docs/realtime-bench.md`). Any future index has to be judged on a vector-recall gate
that realtime-bench does not currently run.

## Limits of the numbers

- **Synthetic corpus, not a real distribution.** A 20-word vocabulary repeated ~150×
  per row makes the term index small and the idf degenerate (hence the codename in the
  query). Real prose has more unique tokens and therefore more `memory_terms` rows, so
  expect bytes/row and the lexical phase to be *worse* than these tables, not better.
  The numbers are for comparing two trees on one machine, not for predicting a
  specific installation.
- **One namespace.** Search scans the requested partition only. A real install with
  P active projects keeps rows/P per partition and pays one scan per query, so at
  10^5 total rows the per-query cost is roughly the row shown at 10^5/P (each project
  is still scanned in full; there is no cross-project sharing yet).
- **Warm cache.** Search runs after the corpus was seeded in the same process, so the
  OS page cache is warm, and since ADR-0029 so is the in-process partition cache. That
  is the intended steady state (a long-lived daemon), but it means the first search
  after a restart is slower: 13.0 ms to decode 4,000 × 384d plus 0.8 ms to score, versus
  0.8 ms warm. Use `MEMORY_VECTOR_CACHE_MB=off` to measure the uncached path.
- **One platform.** Windows 11 / Node v24.11.1 / 16 CPUs above; SQLite I/O behaviour
  differs on macOS and Linux and with WAL on a network drive. Re-baseline per machine.
- **Old-tree fallback is untested.** The script walks `service.saveMany` →
  `store.insertMany` → `store.insert` to seed, so it should still run on the
  pre-rewrite tree, but only the current tree has actually been exercised. The
  "before" numbers above come from the investigation, not from this script.
- **`--assert` is a regression gate, not the scale target.** It checks the measured
  run (p95 < 700 ms, rows/s ≥ 100). At 2,000–20,000 rows a healthy tree passes; the
  10^5 projection is what says the budget is still missed. Assert on the projection
  separately (or raise `--rows`) if the gate should track the ceiling itself.

## Flags

| flag | default | meaning |
| --- | --- | --- |
| `--rows N` | 2000 | total rows in the corpus |
| `--dim N` | 384 | embedding width; 384 = `HashEmbeddingProvider`, others = deterministic dense embedder |
| `--ns N` | 1 | spread rows round-robin over `bench:0..bench:N-1`; the search targets `bench:0` |
| `--namespace NAME` | bench | base namespace |
| `--search-namespace NAME` | first ns | partition the search runs in |
| `--seed N` | 42 | corpus seed |
| `--text-chars N` | 1100 | synthetic text length |
| `--batch N` | 500 | `saveMany` / `insertMany` batch size |
| `--write-mode marginal\|full` | marginal | marginal = bulk-seed then sample `save()`; full = `save()` the whole corpus |
| `--save-samples N` | 50 | measured `save()` calls at full corpus size |
| `--search-runs N` | 20 | measured searches (minimum 3) |
| `--warmup N` | 2 | warmup searches |
| `--k N` | 5 | search k |
| `--budget N` | 800 | `budgetTokens` |
| `--threshold N` | 0.35 | search threshold |
| `--vector-weight N` | 0 | pins `MEMORY_VECTOR_WEIGHT`; `0.6` measures the real-provider arm |
| `--no-reconcile` | off | pins `MEMORY_RECONCILE=off` |
| `--assert` | off | gate on p95 and rows/s, non-zero exit on failure |
| `--max-search-p95-ms N` | 700 | p95 gate |
| `--min-rows-per-sec N` | 100 | throughput gate |
| `--out PATH` | — | write the full JSON (raw latency arrays included) |
| `--keep-db` | off | keep the temp DB and print its path |
| `--no-store-phases` | off | skip the per-phase `store.vectorSearch` / `lexicalCandidates` timings |
| `--quiet` | off | no human summary on stderr (stdout stays one JSON line) |

The int8 shortlist is controlled by the environment, not a flag, because it is a store
setting rather than a benchmark setting: `MEMORY_Q8=on` before the run compares the two
paths on otherwise identical data (ADR-0026 explains why the default is off). Likewise
`MEMORY_VECTOR_CACHE_MB=off` disables the partition vector cache to reproduce the
pre-ADR-0029 scan timings.
