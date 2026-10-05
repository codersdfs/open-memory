# Deterministic retrieval without LLM reranker in v1

Stage 1 scores memories as `0.6*vector + 0.2*BM25 + 0.15*recency + 0.05*importance`, then MMR diversifies and a threshold (0.72) allows empty results. No LLM reranker in v1. An LLM judge would be the smartest reranker but would itself burn tokens — defeating the Token Burning goal — and add latency/cost to every query. A pluggable reranker interface is kept so an LLM stage can be added in v2 when needed.
