# ADR-0026: Why the int8 shortlist is off by default, and what would actually reach the budget

- Status: Accepted
- Date: 2026-10-20
- Related: ADR-0025 (the shortlist itself), ADR-0017 (float32 blob), ADR-0019 (lexical side)

## Context

ADR-0025 added an int8 shortlist for wide vectors and fixed a sign bug that had made
it return nothing useful. With correctness restored, the question left is whether it
should be on by default. It should not, and the reason is worth recording so the next
attempt does not repeat the same detour.

## The measurement

10,000 rows, one namespace, 2048 dimensions, one machine, each mode in its own process
so JIT and page cache state could not bleed between them:

| | q8 off | q8 on |
| --- | --- | --- |
| p50 | 181.6 ms | 125.5 ms |
| p95 | 206.7 ms | 141.4 ms |
| bytes per row | 14,112 | 17,702 |
| 10^5 extrapolation (p50) | 1,586 ms | ~1,094 ms |

A 1.45x improvement that lands at 1.09 s against a 700 ms budget is still a miss. The
price is +25% disk at that width, plus a one-time backfill of every existing row on
first open, plus two new columns that must be kept consistent with the float32 copy on
every write and every `reembed`.

## Why it cannot be pushed much further

The phase split shows where the time actually goes at 2048d:

| Query | Time |
| --- | --- |
| `SELECT id, vec, norm` (float32, 8,192 B/row) | 116.0 ms |
| `SELECT id, q8, scale, norm` (int8, 2,048 B/row) | 90.4 ms |

Reading four times fewer bytes bought 26 ms of the 116. The rest is per-row JS object
construction, the JOIN against `memories`, and the result-set marshalling — none of
which shrink when the payload shrinks. This is why the same change is worth almost
nothing at 384d (1.12x) and why tuning the width of the blob has a floor: the
per-row overhead stays.

An earlier estimate in this project claimed "the read is 61% of the search". That was
true of the *phase labelled read*; it was not true that 61% of the time was spent
moving bytes. The distinction matters, because it is the difference between "read less
per row" (bounded win) and "read fewer rows" (unbounded win).

## Decision

`MEMORY_Q8` defaults to **off**. The columns are still written, so turning it on needs
no migration; the search path simply stays on the full-precision scan until someone
asks for the other one. Documented as opt-in, with the numbers above, so the choice is
made with the cost in view rather than assumed.

## What would actually reach the budget

Reading fewer *rows* instead of fewer bytes per row. A nearest-neighbour index (IVF
with k-means lists, or HNSW) scans 1/64 to 1/128 of the partition and is the only
shape here that changes the order of magnitude.

It is not a drop-in, and that is the real reason it is not in this release:

- the cluster assignment and the inverted lists must live in memory for the lifetime of
  the process, so a store that is currently stateless acquires runtime state;
- every write has to update the index in the same transaction, or queries silently
  miss rows written moments ago — unacceptable for a memory system whose whole point is
  remembering what was just said;
- the daemon and a CLI process can both write, so the index needs an invalidation story;
- a crash must rebuild fast enough not to dominate startup.

That is a version's worth of work with its own ADR, not a column addition. Until then,
the honest position is that 2048-dimension retrieval is fast enough for the tens of
thousands of rows a single project generates, and that the tools for keeping a
partition at that size (`db compact --purge`, namespace and project scoping) are the
practical answer at 10^5.

## Consequences

- The default configuration keeps the exact, well-understood scan; nothing changes for
  existing users on upgrade except two extra columns being filled.
- The 2048d ceiling is documented rather than hidden: see `docs/scale-bench.md`.
- A future index implementation can be measured against these numbers instead of
  re-deriving them.
