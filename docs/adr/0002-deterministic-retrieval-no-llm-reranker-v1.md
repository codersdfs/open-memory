# Deterministic retrieval without LLM reranker in v1

Stage 1 scores memories as `0.6*vector + 0.2*BM25 + 0.15*recency + 0.05*importance`, then MMR diversifies and a threshold (0.72) allows empty results. No LLM reranker in v1. An LLM judge would be the smartest reranker but would itself burn tokens — defeating the Token Burning goal — and add latency/cost to every query. A pluggable reranker interface is kept so an LLM stage can be added in v2 when needed.

## Update 2026-10-06 — the threshold gates relevance, not the total

The threshold used to be applied to the whole weighted score, and that score
includes `recency` — a term that decays. So the gate got harder every day a memory
lived. On a real store, "user is a TypeScript engineer who hates boilerplate"
answered the query "TypeScript engineer" with a BM25 of 0.884 (near-perfect term
overlap) and still scored 0.710 against the 0.72 gate at 36 days old, so it was
filtered and the CLI printed "no memories matched" for a memory that was plainly
there. The effect compounds: the older a store, the more of it goes dark, silently,
which is the opposite of what a memory is for.

The gate now passes on relevance (BM25, or cosine when a real embedder is
configured) *or* on the total. The `relevant` filter above it stays the hard floor:
zero shared terms is not a candidate at all, and that is what keeps unrelated
queries out — this ADR's original goal, unchanged. Every test guarding that goal
passed its threshold explicitly, so the default path was never exercised; see
`tests/relevance.test.ts`, which covers the default now.

Weights as of this date are `0.6*BM25 + 0.25*recency + 0.15*strength`, with the
`vector` weight following the embedder (ADR-0004). The numbers in the paragraph
above predate that change.
