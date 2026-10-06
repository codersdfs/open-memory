---
title: "Ship gate: a real embedding provider, per ADR-0004"
label: wayfinder:task
type: task
HITL: false
blockedBy: []
blocks: []
---

## Question

ADR-0004 promises `EMBEDDING_PROVIDER=openai|nim` and `.env.example` documents it,
but `createEmbeddingProvider()` (`src/core/embedding/index.ts:6`) ignores the
environment and always returns `HashEmbeddingProvider`. The env vars are a lie
today. Can we make the promise true without introducing the failure mode ADR-0004
itself warns about — *"Vector dimensions are load-bearing, so swapping dims
requires re-embedding/clearing `memory.db`"*?

Today `MEMORY_VECTOR_WEIGHT` defaults to `0` for exactly this reason: a hash
vector returns ~0.9 cosine to everything, so the vector term is noise. Retrieval
is lexical-only in practice. That is the honest state, and it is the reason this
is the last item before publishing.

**Task (AFK, do-not-decide):**

1. Implement one OpenAI-compatible provider (`src/core/embedding/openai.ts`):
   `POST {base}/embeddings`, `{model, input}`, reads `dim` from the response.
   NIM is the same code with a different base URL plus the `input_type`
   (`query`/`passage`) body field the E5 models require — already carried by
   `EmbeddingProvider.embed(text, {inputType})`.
2. Wire `createEmbeddingProvider()` to `EMBEDDING_PROVIDER` (`hash` default,
   `openai`, `nim` + `nvidia`/`nvidia-nim` aliases), so an unset var keeps the
   current offline behaviour byte-for-byte.
3. **Dimension guard.** Measure the cost of each option and report, no decision:
   - (a) refuse to start when stored dim != provider dim, naming both dims
   - (b) `memory.db` records its dim; mismatch triggers an explicit
     `ai-memory reembed` command the user runs
   - (c) store dim per row, skip mismatched rows at search time
4. Measure: with a real embedder, does the vector term beat lexical on a
   paraphrase query the hash embedder misses? A 3-query probe is enough —
   if it does not, `MEMORY_VECTOR_WEIGHT` should stay 0 and the provider is
   decoration.

**Constraints:** no model calls in the hot path, no new dependencies (global
`fetch`), no change to the default `npm test` path (tests must not need a key).

**Done when:** `EMBEDDING_PROVIDER=openai` works against a stub server in a test,
`hash` is unchanged, health reports the real name+dim, and a note exists with
the dim-mismatch cost table + the paraphrase probe result.

---

## Why this blocks the release

The published package is now installable (`open-memory@0.3.0`), so the only
thing between this and `npm publish` is that the headline feature — *hybrid*
retrieval — is currently one-legged, and the README would have to say so.
