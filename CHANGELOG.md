# Changelog

Notable changes. The package is `open-memory`; the command stays `ai-memory`.

Prereleases (`-beta.N`) may still move the HTTP and MCP surfaces between builds. The
on-disk format is the part that does not.

## Unreleased

### Added

- **The console can hold your keys.** `#/settings` writes `OPENAI_API_KEY`, `NVIDIA_API_KEY`, `NIM_API_KEY` and `JEV_API_KEY` — plus the judge and extractor knobs — into `~/.ai-memory/settings.json` instead of asking you to hand-edit `.env`. Settings stay flat (a setting key is still an env-var name), a secret is never echoed back (only an ellipsis and the last four characters), and every row says whether it takes effect on save or needs a restart. A key the real environment already provides is refused with the name of where it lives, rather than silently shadowed by it. [ADR-0010](docs/adr/0010-console-writes-credentials.md) supersedes ADR-0009's "never an API key".
- **Adopt.** A key sitting in `.env` shadows every console write, so `POST /settings/adopt-env` copies the whitelisted ones into `settings.json`, comments those lines out (never deletes, never reorders), keeps a one-time `.env.bak`, and reports the entries it could not read back exactly instead of persisting a value that is subtly wrong.
- **`ai-memory daemon restart`** — probe, stop, start, and confirm the replacement answers `/health` before claiming success; a restart that cannot start one says so and exits non-zero. From a source checkout it prints the exact command instead of pretending.

### Fixed

- **A credential written for the judge reached only the processes that load `.env`.** The judge and the extractor read `process.env` directly while the embedder read the merged settings, so `MEMORY_JEV`, `JEV_API_KEY_FILE` and `ENABLE_EXTRACTOR` in `settings.json` did nothing. One seam (`runtimeEnv`) now serves all three, and each reads it per call rather than at module load, which is what makes a change take effect without a restart.
- **The console's write routes could be driven by any page in your browser.** A loopback-only server is not a trust boundary: a simple request from a web page is a loopback peer and could `POST /admin/shutdown`. Every mutating method now refuses a non-loopback `Origin`, and the console routes additionally require a JSON content type — the CLI, hooks and adapters send neither an `Origin` nor always JSON, so their requests are unchanged.

## 0.3.0-beta.1 — 2026-10-12

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

- **The CLI did nothing at all on Linux.** A global install puts a symlink in `bin/`, and the
  entry guard compared the path that was typed against the path Node resolves through the
  link, so the two never matched: `open-memory version` printed zero bytes and exited 0, and
  every command was a silent no-op for anyone who installed this from npm on a POSIX system.
  The guard compares real paths now. Found by the smoke test below on the first runner it
  ever saw, which is the reason that step exists.
- **A daemon-backed `search` looked in the wrong partition.** The CLI resolves the caller's
  partition plus the legacy one before searching, but the request carried only the raw flags
  — including `agent` and `scope`, which the server has never read — so the daemon answered
  from its own default scope and reported "no memories matched" for rows that were plainly
  there. `GET`/`POST /memories/search` takes a comma-separated `namespaces` now, the CLI
  sends the list it resolved, and a test covers that case.

### Added

- **A semantic gate.** A memory with no shared words is admitted when it is the
  partition's best vector hit and leads that partition's median cosine by
  `MEMORY_SEMANTIC_MARGIN` (default `0.2`). At the production floor of 0.72, four
  paraphrased queries went from 0/4 hits on the hash embedder to 3/4 with nemotron,
  while the unrelated query still returns nothing.
- `ai-memory reembed` — rewrite every stored vector for a provider swap, including
  archived and forgotten rows. `--dry-run` counts first.
- `--all` sweeps every partition you own, rather than the two the resolver guessed.
- Embedding providers (`openai`, `nim`) wired to the save and search paths, with the
  vector weight following the provider (ADR-0004).
- Vector-graph view over the store (`.pi`-free, plain HTML in the same process).

### Known gaps

- No measured comparison between the hash embedder and a real provider yet; that
  needs a key (`wayfinder/tickets/011`). The vector path is wired, not proven.
