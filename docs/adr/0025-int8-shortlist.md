# ADR-0025: An int8 shortlist for wide vectors, and the sign bug it hid

- Status: Accepted (shipped off by default; see ADR-0026)
- Date: 2026-10-20
- Supersedes: nothing
- Related: ADR-0017 (float32 blob layout), ADR-0019 (term_df and rarity gate)

## Context

At 2048 dimensions the retrieval index is slow enough to matter. Measured on this
store at 10,000 rows in one namespace, `vectorSearch` sat at 184.5 ms with a 10^5
extrapolation of 2.07 s — nearly three times the 700 ms budget the project set for
itself.

A phase breakdown of that 184.5 ms pointed at the movement of data, not the
arithmetic in it:

| Phase | 384d | 2048d |
| --- | --- | --- |
| SQL read of the blob | 30.3 ms | 112.9 ms |
| decode + dot product | 13.7 ms | 39.0 ms |
| dot product alone (already decoded) | 4.9 ms | 13.4 ms |
| bytes stored per row | 1,536 | 8,192 |

So the plan was to read less: keep a per-row `maxAbs` scale and one signed byte per
dimension alongside the float32 blob, rank the whole candidate set on those bytes,
then re-score only the winners against the float32 copy. Four times fewer bytes on
the scan, exact ordering for whatever survives the shortlist.

## Decision

Add two columns to `memory_vectors`:

- `q8 BLOB` — one signed byte per dimension, `round(v[i] / maxAbs * 127)`
- `scale REAL` — the `maxAbs` used

`vectorSearch` reads `q8`/`scale`/`dim`/`norm` only, scores with `cosineQ8`, keeps the
top `max(limit * 4, 80)`, and re-reads `vec` for just those rows. The backfill is the
same re-entrant `NOT EXISTS`/`IS NULL` pattern as ADR-0017, so an interrupted
migration resumes and rows written by an older build are picked up on the next open.

Two fallbacks keep this from ever being load-bearing for correctness:

- if **any** row in the candidate set has a NULL `q8` or `scale`, the whole query
  returns `null` and the caller runs the full-precision scan;
- if the shortlist would cover the entire candidate set, there is nothing to save and
  the same fallback applies.

## The bug this shipped with, and why the tests did not catch it

The first version returned `Buffer` from `quantizeVector` and stored negatives as
`v + 256` (unsigned, so `-126` became `130`). Rows came back through `unpackQ8` as
`Int8Array` (signed, the same dimension is `-126`). `cosineQ8` multiplies the two
sides, so one dimension contributed `+130` on the query side and `-126` on the row
side. The dot product flipped sign.

Observed, on a 2,000-row store with a query derived from row 21:

```
[q8 ON ]  row21 rank in result: ABSENT   top: 0.076020, 0.070956, 0.062838, ...
[q8 OFF]  row21 rank: 1   score: 0.999711   top: 0.999711, 0.146637, ...
```

An exact self-query scored `-0.55` and ranked **2000 of 2000**. The first eight bytes
made it obvious once they were actually printed:

```
ORIGINAL v:        0.2115, -0.9889, -0.4536, 0.0461, ...
QUERY q8 (Buffer):   27,     130,    198,     6,  ...   <- unsigned elements
ROW   q8 (Int8Array):27,    -126,    -58,     6,  ...   <- signed elements
```

The fix is a type change, not a formula change: `quantizeVector` returns `Int8Array`
and writes `Math.round(vec[i] * k)` directly, letting the typed array do the wrapping.

Why the suite stayed green: every existing test exercises the full-precision path
(`MEMORY_Q8` was on for A/B work only), and a wrong *ranking* is not a crash. Nothing
compared the two paths against each other. That comparison now exists in
`tests/q8-shortlist.test.ts`: same ids, same order, and an exact self-query scoring
above 0.99 in both modes.

## Cost

Measured at 10,000 rows / 2048d on one machine, same data, separate processes:

| | q8 off | q8 on |
| --- | --- | --- |
| p50 | 181.6 ms | 125.5 ms |
| p95 | 206.7 ms | 141.4 ms |

1.45x, and it costs disk: 2048d goes from 14,112 to 17,702 bytes per row (+25%), and
an existing database grows by the size of all its `q8` columns plus the `scale` column
at first open.

At 384d the gain is negligible (1.12x) because the float32 blob is already small
relative to the per-row result-set overhead, which the phase split showed to be the
real cost:

| Query | Time |
| --- | --- |
| `SELECT id, vec, norm` (float32, 8,192 B/row) | 116.0 ms |
| `SELECT id, q8, scale, norm` (int8, 2,048 B/row) | 90.4 ms |

Reading four times fewer bytes saved 26 ms, not 75%. The remaining cost is building JS
objects per row and the JOIN, which quantisation cannot touch.

## Consequences

- Correctness is restored and pinned by a regression test.
- 10^5 rows at 2048d go from ~2.07 s to ~1.09 s. **Still over the 700 ms budget.**
- Because a 1.45x that misses the target is not worth paying 25% storage for, the path
  is **off by default** and opt-in via `MEMORY_Q8=on`. ADR-0026 records why, and what
  would actually reach the budget.
- Any future work here must be measured as q8-vs-exact on the same data, not q8 alone.
