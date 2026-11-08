# ADR-0046: The facet index, and a third candidate arm measured to a null result

Date: 2026-11-08

Status: Accepted (the index is on unconditionally; the retrieval arm ships **off** by default behind `MEMORY_LINKS=on`)

Implements P4 of the memory-systems research plan (`docs/research/memory-systems-notes-2026-11-07.md` §3, review verdict: approved — "默认关+负面结果也写 ADR 的纪律与测量文化一致；P5 是它的下游"). Sits beside ADR-0011 (where the facets come from), ADR-0012 (the candidate union this joins), ADR-0019 (the postings shape this mirrors), ADR-0026/0028 (the flag-and-negative-result precedents this follows). P5's conflict window is its named downstream consumer.

## Context

ADR-0011 gave every write a facet vocabulary — `entity:` / `topic:` / `path:` derived from the text's own naming signals, inherited across a supersede — and that was where the structure stopped. `grep -rn "facet" src/core/retrieval/hybrid.ts` hit only comments: **the read path never touched a facet**. The store had join keys nobody joined on. The research plan called this gap4 and pointed at the numbers it costs: multi-hop is the weakest LoCoMo category (cat1 evidence-all 13% on the current tree), and mem0's entity linking — the closest prior art, present in this repo's own bench — scored 14.5% overall / 6% multi-hop, which is why its *boost* was never going to be copied (only its *candidate-source* idea).

Two constraints the review pinned and this builds to:

- **No free channel.** Facet candidates enter the same pool and clear the same relevance gate as every other candidate. A join key is a way to *reach* a row, never a way to *admit* one.
- **`w.entity` defaults to 0 and lands in the breakdown.** The entity term is measurable, not felt, until a caller turns it up.

## Decision 1: the index — `memory_facets`, same transaction as the postings

```sql
CREATE TABLE IF NOT EXISTS memory_facets (
  facet TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  PRIMARY KEY (facet, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_facets_memory ON memory_facets(memory_id);
```

The shape is `memory_terms`' (ADR-0012/0019) with the join keys swapped: a posting list per facet value, written by the same code paths, in the same transactions. `namespace` is carried denormalized so P5's "same entity, this partition" is one indexed read without a join; the candidate read still joins `memories` for the rest of its filters, exactly as the lexical arm does.

**The invariant this ADR pins: a row's facet postings count exactly the facet tags the row's `tags` column carries** (`facetTagsOf(tags).length` both sides, `tests/facets-index.test.ts`). The index is therefore *derived state* like the postings — recomputable from the row, never an independent truth — and every path that can move facets reindexes in the same transaction as the write that moved them:

| Path | What joins the transaction |
| --- | --- |
| `insert` / `insertMany` | row + terms + **facets** + vector + insert event |
| `supersede` | successor's row + terms + **facets** + vector; the inherited facets are what make the chain read as one entity |
| `updateEmbedding` | **the facets follow the text** — `rederiveTags` keeps the caller's plain tags, re-derives the facet part from the text the row now carries, rewrites the `tags` column, and reindexes in the same transaction. A reembed used to leave tags describing the old text; the invariant turned that drift into a bug the tests can see |
| `updateMeta` tags patch | the knowledge sync's relabel — and P5's future `conflict:*` marker — rewrites the postings from the new tags in the same transaction, both directions |
| `purgeDeleted` | postings die with the row, like the terms do |
| open | **self-heal**: an `NOT EXISTS` anti-join backfills rows whose tags hold facets but whose postings are missing (pre-P4 rows, a foreign writer, a crashed write) — no marker row to forget, the same shape `backfillTerms` uses |

One deviation from a naive copy of `backfillTerms`, and it is the load-bearing one: **the 5,000 bound sits on the repairs, never on the scan.** A zero-facet row is common (casual prose legitimately derives nothing) and is a *permanent* member of this anti-join — it will never earn postings — so a `LIMIT` on the scan itself would let the first 5,000 of them shadow an injured row further down the table on every open, and the self-heal would silently die exactly on the chat-heavy stores this index matters for (reproduced: 5,100 zero-facet rows ahead of one injured row left `repaired: 0` forever under the scan-side shape). The scan is therefore chunked by rowid and runs to exhaustion or to the repair cap; the cap bounds what one open *repairs*, only an actual repair consumes it, and zero-facet rows are additionally skipped before the write transaction opens so the steady state is a scan per open and no write. A huge store still heals over multiple opens — now guaranteed to make progress. `tests/facets-index.test.ts` pins the shadow shape: 5,100 zero-facet rows ahead of one injured row, healed on the first reopen.

**Measured cost** (this machine, real numbers, not projections): the every-open scan on a *fully healed* 20,000-row store is **8.3 ms** — one chunked pass, the anti-join proving a negative over the whole table; on a fresh open (20,000 rows, postings empty) the first pass finds and repairs 5,000 in **4.3 ms**, so a fully unindexed 20,000-row store heals over four opens; linear extrapolation puts 10^5 rows near ~40 ms per open. The bulk write path's marginal cost is below timer resolution: 5,000 rows via `insertMany` in **673 ms with facet postings vs 673 ms without** (same texts, vectors, terms — only the postings removed). The InMemory store mirrors the same posting list as a `Map<memory_id, facets>` maintained by the same call sites, so a drift bug fails the same test on both backends.

## Decision 2: the third candidate arm — same gate, no free channel

`searchOne` gains one arm, behind `MEMORY_LINKS=on` (default **off**):

- the query goes through the **same `deriveFacets`** the write path built the rows' tags with — one vocabulary on both sides of the join, not two conventions;
- `store.facetCandidates({namespace, facets, limit: overFetch, …filters})` returns rows sharing ≥ 1 query facet, most shared facets first, under the same visibility filters as every other arm;
- they join the pool with `vectorScore = 0`, exactly like lexical-only rows, and then face the same `relevant` floor and the same threshold/coverage gate. Nothing in the gate reads the entity signal;
- `entityScore` — the share of the query's facets the row holds, read back from the row's own tags — lands in `breakdown.entity` and `weighted.entity`, multiplied by `w.entity` (default 0). It orders, never gates;
- skipped on the PRF second pass, like the vector arm: `lexicalOnly` exists to widen lexical reach at posting-list cost, and a third query per pass would price the expansion past what ADR-0028 already measured it losing.

The capability (`facetCandidates`) exists on the store **whether or not the flag is on** — the flag decides whether *retrieval* reads it, nothing else. That is the seam P5 consumes: the conflict window needs "same entity, this partition" from the store, not a search setting.

## The measurement: a clean null

The model-free evidence ruler (`bench/evhit.mjs`, conv-26, 152 questions, NIM embeddings, 2048d, chunk 1000, k=5 / budget 800 / threshold 0.35 — the ADR-0028 grid), one variable: `MEMORY_LINKS`. Both runs on this tree, this machine, 2026-11-08:

| | evALL | evANY | cat1 (multi-hop, n=32) evALL / evANY / ev-part | cat2 evALL | avg blocks | avg ms |
|---|---|---|---|---|---|---|
| links **off** (default) | **66%** | **77%** | 13% / 56% / 32% | 89% | 4.50 | 456 |
| links on | **66%** | **77%** | 13% / 56% / 32% | 89% | 4.50 | 381 |

(456 → 381 ms is inter-run noise: a controlled re-run of the same searches measured 79.4 s vs 80.0 s total, +0.7%.) **What these two runs can and cannot support.** They can support the outcome level: `ev_all` / `ev_any` / `ev_hit` / `string_hit` / block-count are identical across all 152 rows — the table reads nothing else. They cannot support a per-question composition claim, because each run ingests the conversation fresh into its own database (random row ids), and the artifacts do differ in composition: 3 questions' retrieved session sets, 4 questions' character counts, and 71 score vectors differ between the runs — and all four affected questions derive **zero** facets (`deriveFacets` returns `[]` on each, re-verified), so none of that can be the arm; it is fresh-ingest tie noise the two-run A/B cannot isolate. The comparison that *can* isolate it is one store, one ingest, only the flag flipped — and there the answer is **0 of 152** questions' final five blocks change, with the arm firing on exactly the 9 facet-deriving questions. The honest LoCoMo accuracy run (`bench/run-locomo.mjs`, reader + judge) could **not** be re-run for this ADR: its reader/judge gateway (`BENCH_BASE`, `http://localhost:20128/v1`) answers no requests in this session (connection refused, probed twice), so any accuracy number here would be invented. The null result above is retrieval-side and model-free, which is the half the facet arm can move.

Why the arm is a no-op here, measured rather than guessed — an instrumented pass over the same store and questions:

- **143 of 152 questions derive zero facets.** `deriveFacets` is deliberately narrow (ADR-0011): backticks, `@handles`, 《titles》, CamelCase, acronyms, paths. A natural-language question that names nothing explicitly gets nothing back — 9/152 derive any, 6 of them the acronym `entity:lgbtq`. The stored side is rich (a probe over the same 1000-char chunk shape finds 80 of 81 chunks carrying facets); the join starves on the query side.
- Where the arm did fire it proposed **102 facet rows** across those 9 questions: **72** were already in the vector/lexical pool (a real embedder's top-20 catches most of them), **29** were new to the pool and were **gate-dropped** — no lexical support, exactly the no-free-channel rule doing its job — and **1** entered the kept set without changing the final-5 order anywhere.
- Turning `w.entity` up to 0.3 in a probe reorders the final-5 on 4 questions; all four already held their full evidence before and after. The default of 0 is not leaving a measured win on the table.

**Verdict, per the ADR-0026/0028 precedent:** the index ships on (it is the store capability P5 stands on, and its invariant is cheap and tested); the retrieval arm ships **off** — built, measured null on this corpus, kept behind `MEMORY_LINKS=on`, with the null explained rather than hidden.

## What would change the verdict

The bottleneck is the query side's vocabulary, not the index. Two honest routes, neither taken here because each changes what `deriveFacets` *means*:

- a **looser query-side derivation** (proper nouns, noun-phrase mining) — ADR-0011 narrowed these signals for a measured reason: guessed entities join unrelated rows, and a wrong join is worse than no join;
- an **entity judge at write time** (the jev price already exists) so `entity:` stops depending on naming accidents — that is a write-path decision with its own blast radius, adjacent to what P5 needs anyway.

Both would need this same ruler re-run before the flag flips; the numbers above are the baseline they would be judged against.

## Consequences

- `tests/facets-index.test.ts` pins the invariant per path (insert, insertMany, supersede, the tags patch in both directions, updateEmbedding's facet-follows-text), the self-heal on reopen — including the shadow shape, 5,100 zero-facet rows ahead of one injured row — purge's cleanup, the capability on both stores **without the flag**, and the arm's three retrieval behaviors: off-by-default (capability untouched), join-through-the-gate when on, and no-free-channel for a zero-overlap facet hit. `tests/recall.test.ts` adds `weighted.entity` to the sum identity so the breakdown stays honest at any weight.
- Schema: one new table + one index, `CREATE TABLE IF NOT EXISTS`, no column changes — a downgrade opens the file and ignores the table, the same as every derived structure here.
- `ScoreBreakdown` gained `entity` / `weighted.entity`; consumers that read specific fields (`ui/src/lib/score.ts` renders bm25/recency/strength) are untouched.
- `updateEmbedding` now also rewrites the `tags` column (facet part re-derived from the new text). Stores that relied on stale facets surviving a rewrite were relying on the drift this ADR closes.
- Bulk imports carry only caller tags (no `deriveFacets` on the bulk path, per ADR-0018) — their facet set is what the caller tagged; the invariant holds and P5 sees them through the same capability.
- P5 consumes `store.facetCandidates` directly; it must route any tags change it makes (e.g. a `conflict:<entity>` marker) through `updateMeta`'s tags patch, which is now one of the indexed paths — otherwise the postings drift from the tags and this ADR's invariant catches it in the tests.

## Not done here

- The end-to-end LoCoMo accuracy arm of the acceptance: reader/judge gateway unreachable in this session (connection refused on `localhost:20128`); not estimated, not faked. The evidence ruler (which is the retrieval half) is fully reported above.
- A looser entity extraction on either side of the join: see "What would change the verdict".
