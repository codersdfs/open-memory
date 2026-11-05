# ADR-0032 — The realtime bench measures the vector path, or says it cannot

- **Status**: Accepted
- **Date**: 2026-10-23
- **Related**: ADR-0027 (coverage ranks the union), ADR-0029 (partition vector cache)

## Context

ADR-0029 made the vector scan cheap by caching decoded candidate sets. Verifying that
change is a problem that outlived it: this bench could not see the vector path at all,
for two independent reasons, and either one alone was enough to make it blind.

1. **Every query shape carried the gold marker.** `bare`, `noisy` and `cjk` all contain
   the fact's rare token (`zq1234`), so the term index answers them by itself. A retriever
   with a completely dead cosine still scored ~1.00 on all three. During the ADR-0028
   work this was measured directly: an IVF index that lost **57% of the vector top-5**
   ran the bench green, recall@5 1.00 across every mode. The gate was incapable of
   failing.
2. **The default embedder has no vector path.** `hybrid.ts` zeroes `weights.vector` when
   the embedder is `hash` — deliberately, since hash vectors carry no semantic signal
   (ADR-0004) — so the default run ranks on terms, recency and strength only. There was
   nothing to measure even if a query had asked for it.

A bench whose most prominent number is "recall@5 = 1.00" while its most expensive
subsystem is untested is worse than no bench: it reports confidence it has not earned.

## Decision

### A fourth query shape, `semantic`, that no marker can answer

One query in four is now marker-free. It names the row the way a person would — its
subject (`project + noun + area`) and a paraphrase of its own case (`a late ordering
case`) — and nothing else:

```
in bench-project-1 the parser for auth behaves one way;
bench-project-2 billing differs, bench-project-3 ingest differs too
— which is a late ordering case?
```

To make that a real target, the corpus grew a `sig` (two words per row, drawn from the
row's own gotcha) rendered as an appositive in the fact, plus a wider noun pool so
`project + noun + area` actually names ~8 rows rather than ~100.

The shape rotates on the query index from its own PRNG stream, so adding it **shifted no
draw** the first three shapes make: `bare`/`noisy`/`cjk` on a given seed produce exactly
the queries they produced before, which keeps their long-run numbers comparable across
this change.

### A gate that fails a run without a vector path

```js
const vectorPathLive = (svc.retriever?.weights?.vector ?? 0) > 0;
...
["semantic mode needs a vector path", vectorPathLive]
```

A `hash` run now **fails** instead of printing a green semantic recall number. The
replacement is `--embedder synthetic`: offline, deterministic, and semantics-carrying, so
`weights.vector` is non-zero without a network key. It is much more expensive per write
than hash (a 60 req/s offered load overruns it — dropped ops, sync p50 in the seconds),
so the documented invocation is `--rate 20`.

The floor itself is `minRecall5Semantic: 0.75`, chosen against measurement: healthy runs
read 0.95–0.98, a vector path losing a third of its candidates reads 0.63, and ordinary
latency churn moves it by ~0.03.

## What this gate can and cannot do (measured, both directions)

`semanticQuery()`'s doc comment records the honest limit, because the first draft of this
ADR claimed more than the shape delivers:

- **It is a floor on vector-assisted ranking, not proof that only a cosine can answer.**
  The question names the gold's subject, so plain word overlap also reaches ~0.86 inside
  recall@5; with `hash` the real bench reads 0.86 on this mode. It does not prove
  "a term index could not have answered this".
- **It does catch the thing it was built for.** Pure cosine over the synthetic embedder
  reads recall@5 0.96 / recall@1 0.50 on this mode, and the real pipeline with a vector
  path that loses a third of its candidates drops from 0.98 to **0.63** while every other
  mode stays at 1.00.
- **A stricter shape was tried and rejected on measurement.** Describing the gold in words
  the stored sentence never uses (a paraphrase across the vocabulary gap) was unanswerable
  by *anything*: with the synthetic embedder the gold's own cosine (0.323) sat below the
  top row's (0.360) and pure-vector recall@5 was 0.04. A bag-of-features embedder cannot
  bridge a zero-shared-feature paraphrase, so a gate built on it would fail for every
  embedder this repo has — a gate that always fails is not a gate.

## Measured result

`node scripts/realtime-bench.mjs --duration 20 --rate 20 --embedder synthetic`:

| mode     | recall@5 | gate (floor) |
| -------- | -------- | ------------ |
| bare     | 1.0000   | ≥ 0.98 ✅     |
| noisy    | 1.0000   | ≥ 0.85 ✅     |
| cjk      | 1.0000   | ≥ 0.60 ✅     |
| semantic | 0.9487   | ≥ 0.75 ✅     |

search p50 27 ms / p95 37 ms, errors 0, dropped 0, 553 rows over the run. Every gate
green, including `semantic mode needs a vector path`.

`node scripts/realtime-bench.mjs --duration 20 --rate 60` (default `hash`) now reports
`verdict: fail` on the vector-path gate — **by design**. The recall numbers it prints
(bare/cjk/noisy 1.00, semantic 0.83) are term-index numbers and are labelled as such.

## Cost

- One extra mode means 25% fewer samples per original shape at the same `--queries`.
- The corpus sentence gained an appositive clause; `avgWords` and token counts moved with
  it (155 → ~170 tokens per search), so token-budget numbers from before this ADR are not
  directly comparable.
- The default `hash` run is no longer the headline. That is the point: a default that
  cannot fail is not a default worth running.

## Rejected alternatives

- **Gate on a pooled recall instead of per mode.** A pooled floor hides exactly this
  failure — three shapes at 1.00 dilute one shape at 0.63 into 0.91.
- **Keep `hash` as the gated default and add the vector gate only under `synthetic`.**
  Then the path the CI-like invocation exercises is still the unmeasurable one. Failing
  loudly on `hash` forces the operator to choose a measurable run.
- **Assert on `markerFree` share instead of recall.** It measures the question's shape,
  not the retriever's answer; a retriever can have 100% marker-free questions and still
  return nothing useful for them.
