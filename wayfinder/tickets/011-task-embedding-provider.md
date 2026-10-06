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

## Done (2026-09-05) — implemented; the last item is blocked on a key

**Decided (grilled):** dim mismatch **refuses at startup** and names both dims — not a
per-row skip (which returns half the results as if they were all of them) and not an
auto-re-embed (which is a bigger command than this ticket).

**Shipped**
- `src/core/embedding/openai.ts` — one OpenAI-compatible client. OpenAI and NIM differ
  only in base URL, model, dimension, and whether the body carries `input_type` /
  `truncate`, so they are one implementation with two configs. Validates the returned
  vector length against `EMBEDDING_DIM`.
- `createEmbeddingProvider()` reads the environment and **throws** on an unknown or
  under-configured provider instead of falling back to hash. That fallback *was* the
  bug: `.env.example` documented `EMBEDDING_PROVIDER=openai` and nothing read it, so
  every install ran hash while the README claimed hybrid retrieval.
- `VectorStore.storedDim()` + the guard in `MemoryService.init()`.
- `/health` carries `version`; the CLI ignores a daemon whose version differs from its
  own and warns once. Measured against a real stale daemon (started 2026-10-02, still
  listening on 7331): before this, `ai-memory search` talked to it and printed
  `search: not found`; now it logs `ignoring the running daemon (version unknown, this
  CLI is 0.3.0)` and answers from the in-process store.
- `src/version.ts` — walks up to the nearest `package.json` named `open-memory`. A fixed
  `../../package.json` resolved to `dist/package.json`, which is not shipped, so
  `ai-memory version` crashed on every installed copy.

**Cost table (the ticket's item 3)**

| Option | Cost | Failure mode |
|---|---|---|
| **(a) refuse at startup** — chosen | ~10 lines, no migration | user must move the file aside; recovery is one documented command |
| (b) `reembed` command | migration + progress + partial-failure recovery | silent half-migrated store if it dies midway |
| (c) skip mismatched rows | ~5 lines | **worst**: returns a subset as if complete |

**Not done — blocked, not skipped:** the paraphrase probe (item 4). It needs a real
embedding key and this machine has none (`OPENAI_API_KEY` / `NVIDIA_API_KEY` /
`NIM_API_KEY` all unset), so there is no measurement of whether the vector term beats
lexical recall with a real model. Until that number exists, `MEMORY_VECTOR_WEIGHT`
stays `0` and the README says so. This is the one claim in the project that is still
unverified.

**Tests:** `tests/embedding.test.ts`, 13 cases — provider selection + refusals, the
wire body for both providers, dim validation, API error text, and the startup guard
(mismatch / empty store / matching store). 170 total.

---

## Why this blocks the release

The published package is now installable (`open-memory@0.3.0`), so the only
thing between this and `npm publish` is that the headline feature — *hybrid*
retrieval — is currently one-legged, and the README would have to say so.

---

## Update 2026-10-06 — the code side is done, the measurement is not

`ai-memory reembed` exists now (`src/core/embedding/reembed.ts`), so a store written
by the hash provider can be moved onto a real one instead of being thrown away — the
prerequisite this ticket named. It is what the dimension-mismatch error points at, it
covers archived/draft/soft-deleted rows (a restored row must not carry an old-width
vector), and a failed batch is retried one text at a time so a single bad document
does not cost the whole chunk.

The README no longer implies the vector path is proven: it says neither provider has
a measured comparison and that the term is *wired, not proven*. That clears the
release blocker as stated above — the claim is honest now instead of pending.

What is left is one measurement, and it needs a key rather than code:

1. `EMBEDDING_PROVIDER=openai OPENAI_API_KEY=... ai-memory reembed` — a provider swap
   needs its own store, and `--dry-run` counts the work first
2. Run the same three queries twice: as written, then reworded. Compare `--explain`'s
   `vector` term against the hash baseline. The bar is not a constant — it is "does the
   reworded query return the memory at all", which the hash embedder cannot do
   (it matches vocabulary, not meaning).
3. Record the result here either way. If a real provider does not beat the hash
   embedder on this corpus, that is a finding, and the README should say so.

---

## Measured 2026-10-06 — `nvidia/nemotron-3-embed-1b` (2048d) vs hash (384d)

Run on a **copy** of the live store (`VACUUM INTO`, 84 rows incl. deleted; 53 live), so
the user's store stayed on hash. Six queries, three sessions:{literal}

Three target memories (a TypeScript-engineer fact, a cat's name, the EMBEDDING_PROVIDER
default note), each asked twice: once in its own words, once paraphrased with no shared
vocabulary (`bm25 = 0.000`), and scored by the target's cosine rank among all 53 live
rows — no threshold, no k, no gate in the way of the measurement:

| target | literal: hash → nim | paraphrased: hash → nim |
|---|---|---|
| TypeScript engineer | 1 → 1 | **13 → 1** |
| cat named Mimi | 2 → 1 | **21 → 1** |
| EMBEDDING_PROVIDER default | 6 → 1 | **9 → 2** |

**Verdict: the embedder delivers what the hash one structurally cannot.** A paraphrase
the hash model ranks mid-pack (9th–21st of 53, i.e. indistinguishable from noise) is
ranked 1st–2nd by the real model. The README now carries this table.

**But cosine is not usable as the gate.** Noise ceiling for three unrelated queries
(`kubernetes ingress controller…`, `sourdough bread`, `paris metro prices`) was 0.120,
0.147, **0.256**; the paraphrases that should match scored 0.271 and 0.304. The ranges
overlap, so *any* absolute floor either admits the kubernetes query (≥0.25) or drops a
genuine paraphrase (≥0.30). Rank separates them; similarity does not.

That is why the change this ticket blocked is only half-done on purpose: the relevance
floor stays lexical, and the vector term's measured value is ordering (`vector` weight
0.6 once a real provider is configured).

**Still open, and now a concrete question rather than a vague one:** a semantic gate
that uses *relative* evidence — cosine against the corpus distribution for that query
(a margin over its median / a percentile), or a rank-based floor — instead of an
absolute cosine. That is the R3/R4 shape (`wayfinder/ROADMAP.md`), and it is the only
thing left between a real provider and a config that is worth paying for.

**Cost of the measurement:** 2 batch requests to re-embed 84 rows, 11 single-text query
embeddings.

### Note for whoever runs this next

- Git-bash `/tmp` and Node's `/tmp` on Windows are different directories: `cp memory.db
  /tmp/x.db` then `MEMORY_DB_PATH=/tmp/x.db` reads a *different* file, which produced a
  stale 65-row store and a confusing "provider X, 0 of 0 vectors" run before it was
  spotted. Copy with `VACUUM INTO 'C:/tmp/…'` (a `cp` also misses whatever is still in
  the WAL) and pass the same absolute path to both sides.
