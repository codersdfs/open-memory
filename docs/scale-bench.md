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

1. **Search is a full-partition scan, and it scales linearly.** 2k → 10k → 20k rows
   gives 15.3 → 64.6 → 148.9 ms; the last step is 2.3× for 2× the rows. No cliff and no
   saving from caching: the vector phase reads every live row's vector, and that is now
   the dominant term.
2. **The term index stopped being the bottleneck** once document frequency moved into
   `term_df` and high-df words were skipped (ADR-0019): 103 ms → 12 ms at 10,000 rows.
   What is left is the vector scan (52 ms at 10k, 119 ms at 20k).
3. **The vector phase grows slightly faster than linear** at the top end (2.3× for
   2× rows between 10k and 20k). The live vector set passes ~30 MB around 20k rows,
   consistent with page-cache pressure rather than an algorithmic change.
4. **A single write is O(partition rows).** `save()` costs 14.0 → 55.1 → 128.1 ms at
   2k → 10k → 20k. Bulk is ~20× faster per row at 10k (1,113 vs 18 rows/s), which is
   the entire point of ADR-0018: a full `save()` load of 10k is minutes, whereas
   `saveMany` does it in 9 s.
5. **Commit/fsync is not what makes bulk writes slow here.** 500-row batches, 20
   commits for 10k rows, 9.0 s total ≈ 450 ms per batch — that is embedding plus
   term-index and df writes, not per-commit durability. The counterintuitive check: the
   2048-d run (8 KB vectors, 8× the vector bytes) is *faster* per row than the 384-d
   run (2,588 vs 1,113 rows/s) because its synthetic embedder is cheaper than hashing
   1,100 characters. rows/s includes the embedder; it is not a storage-only number.

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
  OS page cache is warm. A cold-start query is slower; re-run with a separate process
  if that matters.
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
