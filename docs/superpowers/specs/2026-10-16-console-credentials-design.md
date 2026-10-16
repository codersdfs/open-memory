# Console credentials: configure keys from the console

- **Status:** Proposed (2026-10-15). Supersedes the "never an API key" clause of ADR-0009.
- **Destination:** a user installs `open-memory`, opens the console, fills in their provider keys and judge knobs there, and never hand-edits `.env` again.
- **Approved in chat:** storage = settings.json (approach B); scope = A1+A2+A3+B1, keep B2, drop B3; adopt comments out `.env` lines; restart is a CLI command; keys live in a new `#/settings` view and the Stats Embeddings card does not move.

## Why

Hand-editing `.env` is the only way to set a key today, and that is the friction this removes. Two things make it worse than it sounds:

1. **Keys are not in the layer that already exists.** `src/core/settings.ts` already reads, validates and atomically writes `~/.ai-memory/settings.json`, and `embedEnv()` already merges it into the environment for the embedder. That file deliberately refuses credentials — `writeSettings` throws on `/API_KEY|_KEY|TOKEN|SECRET/i` — so the one writable, validated, atomic seam the project has cannot hold the values users most need to change.
2. **`.env` is loaded by exactly one process.** `src/config.ts` is the only `loadEnvFile()` call in the repo. Everything else reads `process.env`, which for the CLI/MCP/hook paths means the daemon's environment or a shell export. So "edit .env" is both fiddly *and* only half-true.

## Context (verified, 2026-10-15)

- `src/core/settings.ts`: `SETTING_KEYS` (9, all embedding), tolerant `readSettings`, atomic `writeSettings` (tmp + rename), `mergeEnv(base, settings)`, `embedEnv()` = `mergeEnv(process.env, readSettings())`, `pickSettingKeys` whitelist. Precedence: **real environment > settings file > built-in default**; empty string reads as absent on both sides.
- `src/api/server.ts`: `GET /embedding` reports `live`, `source: env|settings|default`, `settingsPath`, `shadowed`; `POST /embedding` refuses a patch whose key is already in the real environment (naming where the value actually lives), then **previews before it writes** (`previewEmbedding`), then reports a *measured* `needsRestart`. This guard/preview pair is the pattern to reuse, not re-invent.
- `src/core/judgment/judge.ts`: `jevApiKey()` precedence `JEV_API_KEY` → `JEV_API_KEY_FILE` → `TYPESAFE_API_KEY`; `jevEnabled()` reads `MEMORY_JEV`; floor is `MEMORY_JEV_MIN`; endpoint `JEV_ENDPOINT`, model `JEV_MODEL`.
- `src/core/extraction/extractor.ts`: `ENABLE_EXTRACTOR`, `OPENAI_API_KEY`, `EXTRACTOR_MODEL`.
- `src/core/embedding/index.ts`: `OPENAI_API_KEY` or `NVIDIA_API_KEY`/`NIM_API_KEY`, already read through `embedEnv()`.
- `ui/`: Vite + React console at `/app`, hash router with 5 views (`recall`, `memories`, `sessions`, `graph`, `stats`); the Embeddings card lives in `Stats.tsx`; `ui/src/lib/api.ts` declares the wire types with file:line citations on purpose.
- `bin`: `open-memory` and `ai-memory` → `dist/src/cli/index.js`. There is **no** `daemon restart` today; `src/cli/index.ts:112` only prints a "Restart it" hint.
- ADR-0007: the *published* package keeps `dependencies: {}`; `ui/` is an exempt, separately-built app. ADR-0009: embedding changes are settings + restart, and the console writes **non-secret keys only**.
- Tests live in `tests/` (relevant: `settings.test.ts`, `api.test.ts`, `console-api.test.ts`, `judge.test.ts`, `extraction.test.ts`, `cli.test.ts`).
- On this machine the judge is wired and working: `.env` holds `JEV_API_KEY` (literal), so it is a real instance of the shadowing case the adopt flow must handle.

## Design

### S1 — Where the value lives

`settings.json` stays **flat**: a setting key *is* an environment variable name (the existing design's whole point is that there is no mapping layer to drift). It simply grows a second whitelist.

- `SECRET_KEYS = ["OPENAI_API_KEY", "NVIDIA_API_KEY", "NIM_API_KEY", "JEV_API_KEY"]` — writable from the console, never echoed back.
- `SETTING_KEYS` gains `JEV_ENDPOINT`, `JEV_MODEL`, `MEMORY_JEV`, `MEMORY_JEV_MIN`, `ENABLE_EXTRACTOR`, `EXTRACTOR_MODEL` (all non-secret, all currently env-only).
- Precedence is **unchanged**: real environment > settings file > default. `JEV_API_KEY_FILE` stays readable from the environment but is not a console field — the file form exists for a shareable `.env`, which is exactly what this feature removes the need for.
- File is created with mode `0600`. **Stated honestly in the ADR: on Windows `mode` is largely inert and the protection is the user profile ACL.** No promise of a locked file is made anywhere.

**Adopt (`.env` → settings).** Because the environment wins the merge, a key sitting in `.env` shadows every console write: the save must fail rather than silently do nothing. Adopt is how a user gets out of that without hand-editing:

1. read `.env` (a ~20-line line-oriented reader; the repo has no `.env` parser and needs no dependency for this)
2. copy whitelisted keys into `settings.json`
3. **comment out** those lines in `.env` (`# NAME=value`), never delete them
4. write `.env.bak` first, and write `.env` through the same tmp+rename discipline `writeSettings` uses
5. report "restart required"

Reason for commenting rather than deleting: `settings.ts`'s own comment says a bad `.env` write is the unrecoverable case. Adopt must be reversible by hand.

### S2 — How the value reaches the code

- `writeSettings`'s secret guard changes from "reject anything key-shaped" to "reject anything outside the two whitelists" — secrets in, unknown keys still out.
- `embedEnv()` generalizes to `runtimeEnv()` (same `mergeEnv(process.env, readSettings())`, one function, one seam). The `process.env` reads in `judge.ts` (7: `JEV_API_KEY`, `JEV_API_KEY_FILE`, `TYPESAFE_API_KEY`, `JEV_ENDPOINT`, `JEV_MODEL`, `MEMORY_JEV`, `MEMORY_JEV_MIN`) and in `extractor.ts` (4: `OPENAI_API_KEY`, `ENABLE_EXTRACTOR`, `EXTRACTOR_MODEL`, `ENABLE_EXTRACTOR`/LLM path) move to it. `embedEnv` either becomes an alias or disappears; one name, not two.
- `memoryService`, `cli/index.ts` and `server.ts` keep their current calls.

**Effect timing, per item — this is the part that generates support questions, so it is explicit in both the spec and the UI:**

| Item | Effect |
|---|---|
| every key (`OPENAI_API_KEY`, `NVIDIA_API_KEY`, `NIM_API_KEY`, `JEV_API_KEY`) | **immediate** — read per call through `runtimeEnv()` |
| `MEMORY_JEV`, `MEMORY_JEV_MIN`, `JEV_ENDPOINT`, `JEV_MODEL` | **immediate** |
| `ENABLE_EXTRACTOR`, `EXTRACTOR_MODEL` | **immediate** |
| `EMBEDDING_PROVIDER`, `EMBEDDING_DIM`, `*_EMBED_MODEL`, base URLs | **restart** (ADR-0009, unchanged) |
| adopt | **restart** — the running process still holds the old values from boot |

Not touched: retrieval, embedding, extraction and judgment logic; `MEMORY_DB_PATH`, `PORT`, `HOST` stay `.env`-only (a database path or a bind address chosen from a web page is a way to lose the store or the page).

### S3 — API

| Route | Behaviour |
|---|---|
| `GET /settings` | inventory: per key `{kind: secret\|plain, source: env\|file\|default\|absent, masked, effect: immediate\|restart}`. Secrets are **never** returned in clear — a masked tail only |
| `POST /settings` | write one or more keys from either whitelist, reusing the `shadowed` 400 (naming where the live value actually lives) and preview-before-write |
| `POST /settings/adopt-env` | the S1 adopt flow; returns `{adopted: string[], restartRequired: true, backupPath}` |
| `GET/POST /embedding`, `/embedding/reembed` | **unchanged** |

- The shadowed check and the preview-then-write sequence are extracted into **one** shared function used by both `/settings` and `/embedding`. Copying that guard is how the two routes would start disagreeing.
- Validation before write, using seams that exist: embedding keys through `previewEmbedding`, `JEV_API_KEY` through one noul call with the candidate key. A stored-but-broken key is the silent-fallback failure this codebase keeps writing comments about. *(If this is cut for v1, saving is unvalidated and the UI must say so.)*
- Writes are logged by name only; values are never logged.

### S4 — UI

New sixth view `#/settings`, added to the `VIEWS` list in `ui/src/router.tsx`:

- **Keys card** — one row per `SECRET_KEYS` entry: source badge, masked value, input, save, effect badge.
- **Judge card** — `JEV_ENDPOINT`, `JEV_MODEL`, `MEMORY_JEV`, `MEMORY_JEV_MIN`.
- **Extractor card** — `ENABLE_EXTRACTOR`, `EXTRACTOR_MODEL` (notes that it shares `OPENAI_API_KEY`).
- **Adopt banner** — shown only while `GET /settings` reports a key sourced from `.env`; explains the comment-out, names the backup, and says "restart required".
- **Restart line** — shows `ai-memory daemon restart` with a copy button.
- One link at the top: the Embedding 9 stay in the Stats card.

`Stats.tsx` and its tests are not touched. Types go in `ui/src/lib/api.ts` with the same file:line citation discipline.

### S5 — CLI, ADR, docs, tests

- **New CLI command** `ai-memory daemon restart` (stop the answering daemon, start a fresh one), so the loop closes without the user reading the README. A console button that restarts the server by killing itself is deliberately **not** v1: new-process-fails-while-old-is-dead is the failure mode this avoids.
- **New ADR-0010** — "the console may write credentials, into settings.json only": flat file, two whitelists, masked reads, adopt, `0600` with the Windows caveat, and an explicit supersede of ADR-0009's "never an API key".
- **README**: the "never an API key" paragraph (around line 184) and the jev key section (around lines 267-274, which still sells `.env` as shareable).
- **Tests**: `settings.test.ts` (secret whitelist accepted, unknown still rejected, adopt writes comments + backup), `api.test.ts`/`console-api.test.ts` (new routes, masked GET, shadowed 400, adopt, no cleartext in any response), `judge.test.ts` + `extraction.test.ts` (the `runtimeEnv` seam), `cli.test.ts` (`daemon restart`).

## Out of scope

- OS keyring / any native dependency (ADR-0007's zero-dependency promise for the published package) — a documented upgrade path in ADR-0010, not v1.
- restarting the server from the console UI.
- `PORT`, `HOST`, `MEMORY_DB_PATH`, and every other startup-level variable.
- multi-user or remote access: the console is a localhost surface. No auth is added, and the design assumes it stays that way; if `HOST` is ever pointed off-host, this route needs a credential story first.

## Risks

| Risk | Mitigation |
|---|---|
| Console save silently does nothing because `.env` shadows it | existing 400 guard, surfaced in the UI, plus adopt |
| `.env` damaged by a write | line-oriented edit, comment-out not delete, `.env.bak`, tmp+rename |
| secret in cleartext on disk | already true of `.env` today; `0600` on write; masked reads; Windows caveat documented rather than assumed |
| two writers of the same value (`.env` and settings) | precedence is unchanged and reported per key (`source`); adopt exists to collapse them |
| "I changed it and nothing happened" | effect badge per item, measured `needsRestart` reused from `/embedding` |

## Acceptance

1. Fresh install: console → `#/settings` → paste key → save → embedding call works, with no `.env` edit.
2. A key present in `.env`: the save is refused with a message naming `.env`; adopt → keys move to `settings.json`, `.env` lines commented, `.env.bak` exists; after `ai-memory daemon restart` the key is live and `source: file`.
3. `GET /settings` never returns a full secret.
4. Judge and extractor pick up a key change **without** a restart; an embedding provider change still reports `needsRestart`.
5. `npm test` green; `npm --prefix ui run typecheck` green; the published package still has `dependencies: {}`.

## Open / follow-up

- OS keyring behind an optional dependency.
- A console button for restart (once `daemon restart` has proven itself).
- Per-key "test" for `NIM_API_KEY`/`NVIDIA_API_KEY` beyond the embedding preview.
