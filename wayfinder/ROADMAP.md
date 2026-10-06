---
title: "Differentiators: explainable recall, reinforcement, redundancy eviction, conflict"
label: wayfinder:roadmap
type: plan
HITL: false
blockedBy: []
blocks: []
---

# Roadmap — what makes this stand out

*Written 2026-08-31. Every item below is zero-LLM-call, local, and free. That is
the constraint: an item that needs a key is a different roadmap, and the whole
pitch of this repo is that it doesn't.*

Standing competition: mem0 / Zep / Letta / Cognee all call a model on every
write. We win on cost, privacy, cold start, and the enforced token budget. These
four items are what "actually smart without a model" means concretely.

## R1 — Explainable recall

**Why:** every other system returns results; we return *why*. The weights already
exist in `src/core/retrieval/hybrid.ts`. This is a debugging tool first and a
demo second.

**What:**
- `HybridRetriever` returns per-term scores (`vector`, `bm25`, `recency`,
  `importance`, `final`) alongside the memory
- `/memories/search` gains `explain` via `?explain=1`, so the default payload and
  the token budget are unchanged
- Inspector: one line per hit, score chips

**Acceptance:** `tests/retrieval.test.ts` — the four weights sum to the final
score; `?explain=1` does not change ranking; the default response is unchanged.

**Done (2026-09-05):** `?explain=1` / `--explain` returns the weighted terms behind
every hit. Off by default — four extra numbers per hit is real payload on a
response whose whole point is a token budget. 157 tests.

**Cost:** ~1 file in `src/core/retrieval/`, ~40 lines of UI. No store change.

**Do this first.** It is the cheapest item here and it makes the existing
architecture visible, which is worth more than any of the other three.

## R2 — Retrieval reinforcement

**Why:** the store should get better the more it is used. `importance` is written
once, at save time, and `decay.ts` prunes but never learns. Nothing in the
landscape does reinforcement without a model.

**What:**
- on a successful above-threshold retrieval, `importance += 0.02` (cap 0.95) and
  `last_used_at` is set — a separate write, not on the read path's hot path
- `decay.ts` additionally subtracts for `importance` untouched since `last_used_at`
- `judged:jev` memories combine judge confidence with reinforcement rather than
  the two competing over one field

**Acceptance:** a test that searches the same memory 50 times and asserts the
importance climbs then clamps at 0.95, and that an untouched high-importance
memory eventually falls below a repeatedly-retrieved low-importance one.

**Cost:** one column (`last_used_at`), one `UPDATE`, one hook in the retriever.

**Open:** does reinforcement corrupt the meaning of `importance`, which the judge
also writes? Proposed split — `importance` (write time, judge's view) vs
`strength` (use time, reinforcement's view), retrieval weighting on `strength`.
Decide before implementing.

**Done (2026-09-05):** shipped as `strength` + `last_used_at` columns with an
automatic backfill (`strength = importance`) — the split the Open note below
proposed, so ranking reads `strength` and the judge keeps `importance`. Decay now
measures age from `COALESCE(last_used_at, created_at)`, so a retrieved memory's
clock resets. Reinforcement happens in SQL (`MIN(0.95, strength + 0.02)`), not in
JS, so it is not a read-modify-write race. Only memories that made it into the
token budget reinforce — the ones actually handed to a model are the ones that
proved useful. 157 tests.


## R3 — Redundancy-aware eviction

**Why:** `decay.ts` prunes by age + importance and will keep five memories saying
the same thing while dropping an old unique one. That makes the budget bar
dishonest: "8 memories" should mean 8 *distinct* memories.

**What:**
- before pruning, cluster the pool by cosine > 0.9 (one O(n²) pass; the vectors
  are already loaded)
- keep the highest `strength` per cluster, evict the rest
- report evicted-elsewhere separately so decay stays legible

**Acceptance:** five near-duplicates plus one unrelated memory — a run evicts
four and keeps all five distinct ones, including the unique old one.

**Cost:** one pass, no new dependency, no schema change.

## R4 — Contradiction check

**Why:** "prefers dark mode" and "prefers light mode" coexist forever and both get
returned. `supersedeId` handles the conflict you noticed; this generalizes it to
the ones you don't.

**What:**
- lexical conflict detection at write time only (negation flips, opposed
  numbers, same-subject clustering above 0.85 cosine)
- on detection, surface both and ask which wins; the loser becomes a
  `supersedeId` of the winner rather than a delete

**Do last.** This is the one item that can be wrong in a way the user pays for — a
false "these contradict" erases a good memory. It needs the write-time review
loop the other items do not.

**Acceptance:** conflicting pair → one status prompt, no auto-delete; a
non-conflicting paraphrase → no prompt.

## Explicitly not doing

Temporal decay curves (everyone has them) · tags-as-layers (ADR-0005 already
decided) · a plugin API (`EmbeddingProvider` + `VectorStore` is enough) · anything
with an LLM in the hot path.

## Ordering

R1 → R2 → R3 → R4. R1 alone is a shippable demo improvement; R1+R2 together are
the defensible pair, because one makes the architecture visible and the other
makes it improve.

## Already decided elsewhere, listed so it is not lost

`wayfinder/map.md` names `EMBEDDING_PROVIDER=nim` as a standing preference, but
`src/core/embedding/` contains only `hash.ts`. Real embeddings need a provider
file plus a re-embed path (`memories reembed`), because changing the provider
invalidates every stored vector. That is its own ticket — and it is the
prerequisite for knowing whether R2/R3 actually help, or whether the hash
embedder was the bottleneck all along.