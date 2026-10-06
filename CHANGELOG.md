# Changelog

Notable changes. `0.3.0` is the first release under the `open-memory` package name;
the command stays `ai-memory`.

## 0.3.0 — unreleased

### Fixed

- **A bare `ai-memory search` could not see your memories.** A read resolved to the
  caller's agent partition (`pi:<user>`) while every row written before layering
  existed sat in `default:default`, so the documented command printed "no memories
  matched" for data that was plainly there. Reads now always cover the legacy
  partition. (Worth separating from the next item: the CLI's own default threshold is
  0.35, so the empty result was never the threshold.)
- **Old memories went dark.** The relevance floor was applied to the total score,
  which includes recency — so the gate got harder every day a memory lived. A
  near-perfect lexical match (`bm25 0.884`) scored 0.710 against the 0.72 gate at 36
  days old and was discarded, and the effect compounds as a store ages. The floor now
  applies to relevance (or to the total), while zero shared terms still never
  qualifies.
- **Six install bugs**, all found by installing the tarball and using it rather than
  by reading code: `bin` pointing at the wrong `dist` path, a missing shebang, UI
  files absent from the package, `version` reading a nonexistent path,
  `GET /memories/search` shadowed by `/memories/:id`, and `.env.example` promising an
  `EMBEDDING_PROVIDER` that nothing read.
- **Search crashed on a partially migrated store.** A row left at the old vector
  width by an interrupted re-embed is now skipped rather than throwing mid-search.
- **The write gate let questions in.** Measured against a real store, "what next to
  ship this" and its neighbours scored 0.07–0.21 with the judge yet were stored
  anyway — the judge is optional (no key) and the cheap regex only looked for a
  trailing "?". Spoken questions and agent scaffolding are dropped now, while orders
  ("Do not force push"), procedures ("How to deploy the UI: npm run …") and
  when-clauses ("When user says save, call …") are kept.

### Added

- `ai-memory reembed` — rewrite every stored vector for a provider swap, including
  archived and forgotten rows. `--dry-run` counts first.
- `--all` sweeps every partition you own, rather than the two the resolver guessed.
- Embedding providers (`openai`, `nim`) wired to the save and search paths, with the
  vector weight following the provider (ADR-0004).
- Vector-graph view over the store (`.pi`-free, plain HTML in the same process).

### Known gaps

- No measured comparison between the hash embedder and a real provider yet; that
  needs a key (`wayfinder/tickets/011`). The vector path is wired, not proven.
- `repository` and `author` are still unset, so the npm page cannot link to the
  source yet.
