---
title: "Pluggable embedding provider with local default"
slug: 0004-pluggable-embedding-provider-local-default
source: "docs\adr\0004-pluggable-embedding-provider-local-default.md"
links: []
---

# Pluggable embedding provider with local default

`EmbeddingProvider {embed(text, opts?)->vec, dim}` defaults to a local 384-dim hash provider (bge-small semantics, zero download) and swaps to `OpenAI text-embedding-3-small` (1536-dim) via `EMBEDDING_PROVIDER=openai` or to **NVIDIA NIM** (`nvidia/nv-embedqa-e5-v5` 1024-dim, `nvidia/nv-embed-v1` 4096-dim) via `EMBEDDING_PROVIDER=nim` (`NVIDIA_API_KEY`/`NIM_API_KEY`, `https://integrate.api.nvidia.com/v1`). NIM adds `input_type` handling (`query` for searches, `passage` for saves) required by E5 models. Vector dimensions are load-bearing (DB store holds raw JSON vectors), so swapping dims requires re-embedding/clearing `memory.db`. Local default gives offline, zero-cost, private operation; the `inputType` opts on `embed()` keep NIM correct without code changes.


> Source: docs\adr\0004-pluggable-embedding-provider-local-default.md
