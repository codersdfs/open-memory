# Real-time benchmark — the memory system under a live mixed workload

Two benchmarks already exist and neither answers "what does an agent feel while other work is
happening":

| harness | question | loop |
|---|---|---|
| `bench/run-locomo.mjs` | is the answer *right*, against a dataset and a pinned reader | one shot, offline |
| `scripts/scale-bench.mjs` | what does a corpus *size* cost | closed loop, no churn |
| `scripts/realtime-bench.mjs` | what does the service do while it is *being used* | **open loop, mixed, for minutes** |

`ADR-0024` records why it is built this way.

## Method

- **Open loop.** Requests are scheduled on a fixed clock (`1000 / rate`) whether or not the previous
  one finished. In-flight work is bounded by `--workers`; a request that cannot be issued is counted
  as `dropped` and never retried. A closed loop (awaiting inside a `for` loop) reports the latency of
  a client that politely waits — queueing, which is what a caller actually feels, never appears.
- **Mixed mix.** 45% `search`, 30% `write` (`saveDetailed`, so reconcile runs), 10% `list`,
  10% `brief`, 5% `knowledge` (the page index). Weights are the request mix of one agent per turn
  plus a second agent sharing the store.
- **Recursive churn.** A separate timer rewrites one section of one vault page and calls
  `syncKnowledge` every `--sync-every` seconds, so the knowledge index is being re-indexed while the
  requests run. Sync is not a per-request operation, so it gets its own clock.
- **Quality is measured, not assumed.** Every seeded fact carries a unique marker (`zq1042`). A search
  is scored by the rank at which its gold marker comes back, so `recall@5` is recall against known
  labels — and because writes keep arriving, it is recall on a store that is moving.
- **Live series.** One line per second while it runs; the JSON report keeps the series, because an
  average cannot show a 500 ms stall.
- **Gates.** `--assert` fails the run on: errors, dropped requests, `search p95` over `--max-search-p95`
  (250 ms), `recall@5` per query shape under its floor, a token-budget overrun, or a sync error.

```bash
node scripts/realtime-bench.mjs --duration 60 --rate 60 --assert          # the headline run
for r in 20 40 60 80 100; do node scripts/realtime-bench.mjs --duration 20 --rate $r; done
node scripts/realtime-bench.mjs --embedder nim --duration 60 --rate 40    # real 2048-dim embeddings
```

Default: 800 facts, 6 projects, 12 vault pages, 16 workers, hash/384d embedder (no key, no network,
reproducible), temporary SQLite file, in-process `MemoryService` + `SqliteVectorStore`.

## Results — 2026-10-19, Windows, Node 24.11.1, hash/384d, 1 process

### Capacity curve (20 s per rate, 800 facts, same seed)

| offered req/s | achieved | dropped | search p50 / p95 | sync p50 | rows at end | recall@5 |
|---|---|---|---|---|---|---|
| 20 | 20.1 | 0 | 10 / 17 ms | 28 ms | 953 | 0.944 |
| 40 | 40.1 | 0 | 10 / 14 ms | 41 ms | 1,073 | 0.922 |
| 60 | 60.1 | 0 | 9 / 14 ms | 41 ms | 1,193 | 0.922 |
| 80 | 80.0 | 0 | 10 / 28 ms | 85 ms | 1,313 | 0.918 |
| 100 (60 s) | 96.4 | **222** | **126 / 312 ms** | 217 ms | 2,547 | 0.906 |

The knee is between 80 and 100 req/s on one core. At 100 the offer exceeds capacity: 222 of 5,997
requests (3.7%) were never issued, search p50 went 10 → 126 ms, the worst stall was 517 ms, and the
slowest sync took 1,526 ms. Up to 80 req/s (≈36 searches + 24 writes per second) there are zero
errors, zero drops and the worst stall is 338 ms.

### Headline run — 60 s at 60 req/s, 24 workers

| op | count | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| search | 1,620 | 10 ms | 23 ms | 42 ms | 47 ms |
| write | 1,080 | 3 ms | 21 ms | 25 ms | 33 ms |
| list | 360 | 1 ms | 2 ms | 2 ms | 3 ms |
| brief | 360 | 1 ms | 2 ms | 3 ms | 26 ms |
| knowledge | 179 | 62 ms | 155 ms | 178 ms | 187 ms |
| sync | 11 | 52 ms | 146 ms | 146 ms | 146 ms |

throughput 60.1 op/s · errors 0 · dropped 0 · stall 206 ms · store 1,905 rows, 11.7 → 21.6 MB ·
tokens per search 130 of 800 · verdict **pass**

### Recall by query shape — same run

| shape | n | recall@1 | recall@5 | empty |
|---|---|---|---|---|
| bare marker (`zq1042`) | 555 | 1.00 | 1.00 | 0 |
| noisy (`how do we configure … zq1042 project`) | 556 | 0.89 | 0.97 | 18 |
| CJK (`bench-project-0 里的 zq1042 是怎么配置的`) | 509 | 0.57 | 0.71 | 146 |

Bare markers never miss, so the row and its term posting are there: the CJK loss is the **default hash
embedder**, which tokenises Latin only (`ADR-0004`). Any recall number from this harness must name the
embedder; `--embedder nim` reruns it over 2048-dim vectors.

## What it says

1. **Capacity is a cliff, not a slope.** 20 → 80 req/s costs nothing (p50 flat at ~10 ms); the
   ~90-100 req/s step costs a 12× latency increase and a few percent of unissued requests. The
   interesting number for an operator is the last rate with zero drops, not the average.
2. **Writes degrade before reads.** At saturation write p50 went 3 → 52 ms (each write does a 5-NN
   neighbour lookup plus a WAL commit), while search p50 went 10 → 126 ms mostly because it queues
   behind them. A store shared by a writer and a reader shows up here first.
3. **Recall is stable under churn.** 1,000+ concurrent inserts did not move recall on the original
   facts (0.944 at 20 req/s, 0.918 at 80): the candidate union plus term index absorb new rows
   instead of displacing old answers.
4. **`knowledge` is the one surface that scales with the partition** (62 ms p50 at 1,905 rows, 155 ms
   p95). It lists the partition and groups it into pages — documented as a known limit in
   `ADR-0023`; `list` and `brief` stay at 1-2 ms because they bound rows.
5. **Sync is the only operation that visibly competes with traffic** (p95 146 ms while loaded,
   1.5 s at saturation). Run it when the agent is idle, or accept the spike.

## What it does not measure

- One process, one core, no HTTP layer. An HTTP/daemon run adds `node:http` overhead on both sides;
  the engine number here is the floor, not the client-visible latency.
- Synthetic corpus (English + Chinese templates), warm page cache, local disk, temp DB. Absolute
  latency will differ on other hardware; the *shape* (knee, per-op ordering, churn stability) is what
  transfers.
- No reader and no judge: it measures the memory system, not the quality of an answer an LLM builds
  from its context. Token *cost* is measured (130 of 800 per search); token *usefulness* is the
  LoCoMo harness's job.
- The hash embedder is the default for reproducibility and for having no key in the loop; it is not
  the recommended production embedder, and it is the reason the CJK column is low.

Report: `bench/results/realtime.json` (`schema: realtime-bench/1` — config, per-op stats, quality per
mode, per-second series, DB footprint, gates). `bench/` is gitignored; regenerate with the command
above.
