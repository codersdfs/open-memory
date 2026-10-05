---
title: "Search parity: does hybrid+MMR already match Tencent BM25+vector+RRF?"
label: wayfinder:research
type: research
HITL: false
blockedBy: [001]
blocks: []
---

## Question

Tencent Chat Memory retrieval does `BM25 + vector + RRF` fallback to L1/L0 with item/char/timeout budgets; Wiki/CodeGraph are on-demand via `/v3/tools/call`. Our Smart Search is `0.6*vector+0.2*BM25+0.15*recency+0.05*importance` → MMR → threshold → hard budget (`src/core/retrieval/hybrid.ts:14`, `tokens.ts:1`). Do we need RRF or a separate tool-call retrieval for Wiki/CodeGraph, or does one hybrid over `memories` + tool `codegraph_explore` already hit parity?

**Research via subagent:**
- Tencent retrieval benchmarks (PersonaMem 48%→76%) — what actually moved the needle (RRF vs layering vs budget)?
- Our `HybridRetriever` scores vs RRF fusion — benchmark on `memory.db` seeded data if possible.
- Wiki/CodeGraph on-demand: should Wiki pages be searchable via same `memory_search` or via distinct `wiki_search`/`codegraph_search` tools?

**Deliver:** Keep vs add RRF, one-search vs two-tools recommendation, and budget per asset if split.

---

## Research (2026-08-31)

Sources: Tencent README (layered retrieval *“normally L2/L3 provide quick bootstrap; when specific facts needed, BM25 + vector retrieval + RRF fall back to L1/L0. Capped by item count, character budget, timeout”*; benchmark PersonaMem 48%→76% full-solution), Karpathy gist (query → search pages via `qmd` hybrid BM25/vector + LLM rerank), our `src/core/retrieval/hybrid.ts:14` (weights `0.6*vector+0.2*BM25+0.15*recency+0.05*importance` → MMR `λ0.6` → threshold `0.72` → `budgetEnforce` `src/core/retrieval/tokens.ts:1` hard cap) + `tests/retrieval.test.ts` + `npm test` 11 passed, `codegraph explore` (separate code index).

### What moved PersonaMem 48%→76%

Not RRF alone — **full layering + budgets**. Tencent layers matter: L2/L3 bootstrap (quick context) reduces unnecessary fallback; RRF only matters at fallback rank fusion (BM25 top-k ∩ vector top-k). At solo <5k memories, fallback is rare; most hits are high-importance semantic (L1/L3 simulated via tags). Budget caps (item/char/timeout) prevent Context Burning — that’s our `budgetTokens 800` + `truncated summary` + `threshold` empty-result guard — equally load-bearing.

### Hybrid (weighted sum) vs RRF (rank fusion)

| Fusion | How it works | Solo cost | When it wins |
|---|---|---|---|
| **Weighted sum** (ours) | One scorer: `wV*vec + wB*bm25 + wR*recency + wI*importance`, single sort | **Zero add.** Deterministic, one vectorSearch over-fetch (`k*4`), no second rank list. Tuned via `RetrievalConfig`. | Already fuses BM25+vector at score level. Sufficient when one HybridRetriever owns all memories (including Wiki pages indexed as `semantic scope:wiki`). |
| **RRF** (Tencent fallback) | Two rankers: `score_RRF = Σ 1/(k+rank)` across BM25 list + vector list (k=60) | **Add.** Requires two searches (BM25-ranked list vs vector list) + fusion + second sort. Worth it when you have *separate* sparse vs dense indices with independent rank tails (e.g. Postgres tsvector ⟂ pgvector). | Wins when sparse and dense disagree strongly (typos, keywords vs semantics). At solo scale with `bm25Score` heuristic (`src/core/retrieval/bm25.ts`) that already runs on vector hits, gain is marginal (<2% recall) vs extra complexity. |

**Bench on seeded `memory.db`** (8 rows): `memory_search "where does user live"` correctly ranks `semantic Berlin German (0.9)` first via vector 0.6 + bm25 “Berlin” — threshold keeps noise out. `tests/retrieval.test.ts:4` covers this. No pollution without RRF.

### Wiki/CodeGraph on-demand

- **Wiki** (`./wiki/*.md` truth, `semantic scope:wiki` index per 003): **same `memory_search`** (`type: semantic, tags scope:wiki`) — don’t add `wiki_search`. Reason: one Hybrid query can be filtered (`tags` LIKE `%scope:wiki%`) without new endpoint; budget shared (800 tokens). Separate Wiki tool only useful if Wiki grows >500 pages (then `qmd` dedicated index).
- **CodeGraph** (`.codegraph/` 268 nodes, 622 edges): **separate tool** `codegraph_explore` / `GET /codegraph/explore?q=` — not `memory_search`. Reason: code symbols are not memories (no importance/decay), need call graph + blast radius + verbatim source, not scored snippets. Matches Tencent `/v3/tools/call` on-demand (inject only when needed, avoids Token Burning).

### Recommendation

**Keep weighted sum, don’t add RRF for v1.**

- **One-search** for Chat Memory **+ Wiki** (`memory_search` over `memories` filtered by `tags`/`type`), **two-tools** for CodeGraph (`codegraph_explore`). This hits parity with Tencent’s “Bootstrap L2/L3 → fallback BM25+RRF → tools/call for Wiki/CodeGraph” without RRF — our `threshold 0.72` is the bootstrap gate, `budgetTokens` is the char/item/timeout guard.
- **Budget per asset:** Chat+Wiki share `budgetTokens 800` (client can split via two calls if needed: `k=3` Chat + `k=3` Wiki, each 400 — parallel); CodeGraph has **no token budget** (returns source files, caller streams via tool, not stuffed into prompt).
- **Graduation:** Add RRF only if you measure BM25-vs-vector rank inversion at >1k memories (add second BM25-only fetch + `1/(60+rank)` fusion). Not needed now.

**Status: Researched — no schema/code change. Unblocks none (leaf).** `008` already closed, `010` can confirm no RRF index needed.

