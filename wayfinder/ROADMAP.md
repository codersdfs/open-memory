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
invalidates every stored vector. That is ticket 015 (shipped) — and it is the
prerequisite for knowing whether R2/R3 actually help, or whether the hash
embedder was the bottleneck all along.

## v0.4 (2026-10-19) — the recall/freshness pass, and where R3/R4 stand

Shipped outside the R-numbering because the measurements pointed here rather than
at R3: candidates are now a union of vector and term index (ADR-0012), `k` and the
token budget are honoured literally (ADR-0013), a structural shape gate runs
before the wording rules (ADR-0015), decay archives instead of deleting
(ADR-0016), and leftover budget is filled by projection (ADR-0014). Each has a
measured number in its ADR and in `README.md`.

R3 (redundancy-aware eviction) and R4 (contradiction check) are still open, and
the store audit says R3 is not where the cost is: Jaccard >= 0.6 finds 7 clusters
covering 4.6% of tokens, while 53.7% of rows are not memories at all. R4 keeps its
"do last" position for the same reason as before — a false contradiction erases a
good memory — and it now has a prerequisite the roadmap did not anticipate: the
shape gate and `topic:` facets it would compare on only started existing in v0.4.

## v0.5 (2026-10-19) — the scale pass (direction A of two)

The v0.4 pass bought quality at the cost of paying it on every read: a full-partition
`SELECT *` plus a `JSON.parse` per row, one commit per write, and a lexical candidate
path that materialised the whole partition. At 10k rows that was 279 ms and 114 MB;
extrapolated to 10^5 it was ~2.8 s and 1.1 GB, i.e. outside an agent's turn.

Shipped: vectors moved to float32 blobs in `memory_vectors` with a two-phase read
(ADR-0017 — 2k rows 45.2 -> 12.4 ms, 10k rows 279 -> 64.7 ms, file 113.9 -> 56 MB),
and writes/bulk import/purge/compact became one-transaction operations (ADR-0018).
Existing files migrate on open, resumably (10k rows in 1.03 s).

A harness now keeps the numbers honest: `scripts/scale-bench.mjs` (see
`docs/scale-bench.md`) seeds synthetic rows through the real service stack and reports
write throughput, `search` p50/p95, the phase split, bytes/row and the 10^5 projection.

Then the harness found the next bottleneck, and it was not the vectors: document
frequency was recomputed per search, making the lexical phase 103 of 163 ms at 10k
rows. ADR-0019 keeps `term_df` in the write transaction and skips words that appear in
more than a third of a large store. End-to-end search p50: 2k 30.2 -> 15.3 ms, 10k
163.2 -> 64.6 ms, 20k 341.4 -> 148.9 ms; 10^5 at 384 dims goes 1.71 s -> ~0.68 s, i.e.
inside the 700 ms budget. Stores under 1000 rows are untouched.

Open: 2048 dims at 10^5 rows is still ~2.07 s and needs an index (quantised shortlist
plus exact rescore, or IVF) rather than another layout. Direction B (which memories a
long-lived project should keep, and how an agent asks for them) has not started; the
R-numbering still stands.

## v0.6 (2026-10-19) — project memory (direction B of two)

Direction A made the store hold a long-running project's rows. Direction B is the
question the audit had already answered: 53.7% of rows were not memories and 91.9% were
never retrieved, because nothing in the model said *why* a row deserved to survive or
*which repository* it belonged to.

- **A project is a dimension, not a partition** (ADR-0020). A slug on the row, resolved
  explicit -> `MEMORY_PROJECT` -> the git work-tree root, slugged. The namespace keeps
  saying who wrote it; the read fan-out and the shared layer are untouched. Reconcile is
  scoped to one project, so identical text in two repositories stays two facts.
- **Kind decides retention, type decides shape** (ADR-0021). `decision`, `convention`,
  `gotcha` are durable: the archive pass returns early for them. `task` 7d, `note` 30d,
  `fact` 90d. Lexical and bilingual, zero model calls; an explicit `--kind` wins and
  prices itself.
- **The brief is a query the agent does not have to ask** (ADR-0022): conventions ->
  decisions -> gotchas -> open -> recent, deterministic, trimmed to 600 tokens, exposed
  as `memory_brief`, `GET|POST /brief`, `ai-memory brief`, and used by the injection
  hook on a query-less turn.

Open: R3 (redundancy-aware eviction) and R4 (contradiction check) are unchanged and
still last (a false contradiction erases a good memory). The kind classifier is lexical,
so it is wrong in the cheap direction on purpose — over-preserving a convention costs
brief tokens, under-preserving a decision costs the relearning. Nothing measures a
real multi-month repository yet; every number above comes from this store or from
synthetic rows.

## v0.7 (2026-10-19) — knowledge pages: the vault becomes addressable

v0.4-v0.6 made the store good at *conversation*: recall, scale, projects, kinds, a brief.
The vault was the other half of the same problem and had no road: `vault/` held real
markdown with `[[links]]`, `/graph` drew it, and none of it could be found by a search,
cited by a project, or walked by an agent without reading files by hand.

- **A page is the truth, a section is a row** (ADR-0023). `knowledge sync` reads the vault,
  splits on headings, and keeps one row per section under `knowledge_id` +
  `knowledge_section`. Identity is the heading — `how-tokens-work` — so an edit touches
  one row and the second sync of unchanged files writes nothing (measured:
  `inserted: 0, updated: 0, unchanged: N, embedCalls: 0`). Position-based identity would
  have re-flowed every row below an inserted paragraph.
- **Links beside the rows, never inside retrieval.** `[[target]]` from body or frontmatter
  lands in `knowledge_links`; an unresolved target is `to_id = NULL`, which is the file's
  maintenance debt rather than an error. Search shows a hit's links as metadata;
  `neighbors` walks them explicitly (depth 1..3, cycle-safe). Implicit expansion was
  rejected for the same reason projection was bounded (ADR-0014): context is paid on
  every turn.
- **One write path, and it is not reconcile.** `syncKnowledge` is the only creator of
  knowledge rows; `wiki-ingest` now converts docs to vault and calls it. Ordinary writes
  pass `knowledge: null` to reconcile, so a chat sentence can never reinforce a page
  section away, and the archive pass returns early on knowledge rows — their lifetime is
  the file's, and archiving one would ping-pong with the next sync.
- **Surfaces:** `memory_knowledge`, `GET /knowledge`, `GET /knowledge/:id`,
  `GET /knowledge/:id/neighbors`, `POST /knowledge/sync`, and
  `ai-memory knowledge ls|show|neighbors|sync|link`.

Open: no filesystem watcher (sync is a command, not a daemon), no automatic expansion of
neighbours in a search result, and pages do not enter the brief yet — the brief still
covers conversation rows only, which is the next gap now that a project can have durable
knowledge. A page rename is a delete plus an insert (the id is the path or the slug), and
sync reads the whole partition, which is fine for a vault and would not be for a million
rows. R3/R4 remain open and still last.

## v0.8 (2026-10-19) — real-time benchmark

Accuracy and scale were measured with a quiet process. The normal case is not quiet: one memory
store is shared by a writer and a reader, and on this machine those are the same Node event loop.

- **Open loop, or it is not a measurement** (ADR-0024). Requests are scheduled on a clock and never retried; the ones that cannot be issued are counted as dropped. A closed loop reports the latency of a client that waits, which is not what queueing costs you.
- **Recall measured through the workload**: every seeded fact carries a marker, so recall@k is known-label recall measured while 1,000+ rows are being inserted. It stays flat (0.94 -> 0.92 from 20 to 80 req/s), which is the candidate union doing its job.
- **Numbers**: 20-80 req/s sustain with zero drops and search p50 ~10 ms; the knee is at ~90-100 req/s (222/5,997 requests unissued, search p50 126 ms, worst stall 517 ms, slowest sync 1.5 s). Stores 1,905 rows / 21.6 MB after 60 s of mixed load.
- **The finding worth keeping**: per-mode recall. Bare markers 100%, English 97%, Chinese 71% on the default hash embedder - the CJK loss is the embedder, not the index, and pooling the modes would have hidden it.

Open: no HTTP/daemon arm yet (the engine number is a floor), no recorded-traffic replay, no multi-process contention, and the knowledge index remains the one surface whose cost tracks partition size (62 ms p50 at 1,905 rows). R3/R4 still open and still last.

