---
title: "Embedding provider switch: visible in the console, written to settings, applied on restart"
label: wayfinder:task
type: task
HITL: false
blockedBy: []
blocks: []
---

## Question

Asked for: pick the embedding provider/model in the console.

**The console cannot do that alone.** Measured:

- The provider is chosen by `createEmbeddingProvider(env)` from `EMBEDDING_PROVIDER` and friends (`src/core/embedding/index.ts:24-58`) and resolved **once, at construction** — `src/core/memoryService.ts:29` `this.embedder = opts?.embedder ?? createEmbeddingProvider()`, then frozen for the process (`memoryService.ts:79,127`, `retrieval/hybrid.ts:204`). There is no reload: `src/config.ts` loads `.env` once at import.
- Vector width is load-bearing (the store keeps raw JSON vectors), so a swap invalidates every stored vector — which is why `reembedAll(store, embedder, {batchSize, dryRun, onProgress})` exists and rewrites **every row in every partition** (`src/core/embedding/reembed.ts:29-108`), reporting `{partitions, scanned, rewritten, failed[]}`.
- **The guard is loud, but it only ever looks at one row.** `MemoryService.init()` refuses to serve a store whose vectors do not match the configured provider, naming both dims (`src/core/memoryService.ts:47-53`) — so a settings write followed by a careless restart fails *before* it can lie. But that read is `store.storedDim()`, which is `SELECT embedding … LIMIT 1` (`src/core/store/sqlite.ts:218-232`) and says so in its own comment: "A half-migrated store reports whichever row lands first; add a MIN/MAX sweep here if partial re-embedding is ever implemented." Everything past the first row is therefore unguarded, and a foreign-width row is *skipped* by a search rather than fatal (`sqlite.ts:369`, `:221`, `:299`) — so a partly-migrated store answers with quietly fewer rows.
- **The window matters more than the corruption.** The dangerous state is not a broken store, it is the stretch between a finished migration and the restart that follows: every row is at the new width while the running process still embeds its queries at the old one, so searches return nothing at all. `src/core/embedding/index.ts:20-22` records this project getting burned once already by that same shape — `EMBEDDING_PROVIDER` read by nobody, every install silently on `hash`, "hybrid retrieval" one-legged behind a README that claimed otherwise.
- Nothing can see the mismatch today: `/stats` reports `service.embedder.name` / `.dim` — **the process's** configuration (`src/api/server.ts:146`), never the store's actual widths.

So the feature is: make the mismatch **visible**, make the switch **writable**, and keep the blast radius honest.

## Decisions

### D1 — The store's widths become a number (`byVectorDim`)
`summarize(rows, now)` already receives every row, tombstones included, so it gains `byVectorDim: Record<number, number>` — the count of rows per embedding width. Additive under `?full=1` only; the default `/stats` shape stays byte-identical (`tests/console-api.test.ts` already asserts that shape and must keep passing).

This is the field that turns the silent case into "**7 rows are unreadable by the running provider**". Nothing else in this ticket matters as much.

The histogram is also the MIN/MAX sweep `storedDim()`'s comment asks for, one level up: it counts every width instead of trusting the first row. `storedDim()` itself is left exactly as it is — it is the startup guard's input, and that guard is load-bearing ("Not doing").

### D2 — A settings file for non-secret settings, with env winning
`~/.ai-memory/settings.json` (same home `src/core/dbPath.ts` resolves), written by the console, holding **only** `EMBEDDING_PROVIDER`, `EMBEDDING_DIM`/`NIM_DIM`, `OPENAI_EMBED_MODEL`/`NIM_EMBED_MODEL`, `OPENAI_BASE_URL`/`NIM_BASE_URL`, `NIM_INPUT_TYPE`, `NIM_TRUNCATE`. Never a key.

Precedence: **real environment > settings file > built-in default.** Cheap because the factory already takes an env object — `createEmbeddingProvider(env)` — so the change is a merge at the two construction sites (`src/core/memoryService.ts:29`, `src/cli/index.ts:225` `cmdReembed`) rather than new plumbing through every caller. `src/config.ts` keeps loading `.env` exactly as it does; a `.env` value is a real env value and therefore wins, which is what someone who wrote a key into `.env` expects.

New file `src/core/settings.ts`: read (tolerant — a malformed file must not stop the server), validate keys against a whitelist, write atomically (temp + rename), unknown keys rejected rather than stored.

### D3 — `GET /embedding`: what is live, what would be, and what is broken
Returns:
- `live: { provider, model, dim, source }` — the running process's embedder, plus where that came from (`settings` | `env` | `default`).
- `target: { provider, model, dim } | null` — what the settings file + env would produce on the next start, and `needsRestart: boolean` (live vs target). This is what makes "restart required" an assertion rather than a sentence.
- `presets`: `hash` 384d, `openai` `text-embedding-3-small` 1536d, `nim` `nvidia/nemotron-3-embed-1b` 2048d — read from the factory's own defaults, not retyped in the UI.
- `keys`: for each provider needing one, the **env var name and a boolean** — never a value, never a prefix of one.
- `store: { byVectorDim, unreadableRows }` — from D1, where `unreadableRows` counts widths ≠ live dim.

### D4 — `POST /embedding`: validate with the real factory, then write
Body: the **environment-variable vocabulary**, flat — `{ EMBEDDING_PROVIDER: "nim", EMBEDDING_DIM: "2048", NIM_EMBED_MODEL: "…" }`. A settings key *is* an env var name, so there is no mapping layer to drift and the console's presets speak the same words the factory does. Keys that are secret-shaped, or not on the whitelist, are refused (by `writeSettings`, before it opens anything).

**A key the environment already sets is a 400, not a no-op.** The precedence is real environment > file, so writing `EMBEDDING_PROVIDER` while `.env` (or the shell) sets it would change nothing — and answering `ok` while nothing moves is the silent failure this repo keeps writing comments about (`.env.example` even documents `EMBEDDING_PROVIDER`, so this is the *likely* case on a real checkout, not an edge one). The error names the shadowed keys and where the value actually lives. `GET /embedding` reports the same list as `shadowed`, so a control that cannot do anything can say so.

`needsRestart` in the response is **measured** against the live embedder, not asserted: writing the provider the process already serves with is not a reason to restart. Validation is the production code: build `createEmbeddingProvider({ ...mergedEnvFromBody })` inside a try and return its thrown message as a 400 — the same function that would build it at startup, so a body that validates here cannot fail there. Unknown provider, non-integer dim, or a missing key env var is a 400 **and no file written**. On success: atomic write, `200 { needsRestart: true, target }`.

The running embedder is **not** touched (ADR-0009).

The order is therefore fixed: **write settings → dry-run → migrate → restart.** The middle two are not optional. Restarting straight after a write is refused by `init()` naming both dims — the safety net doing its job, and the console's copy should frame it that way instead of letting it read as a crash.

### D5 — `POST /embedding/reembed` + `GET /embedding/reembed`: dry-run, then migrate
- `POST` with `{ dryRun: true }` (default) → `reembedAll(store, targetProvider, { dryRun: true })` → `{ scanned, rewritten, wouldFail }`, writing nothing. This is the "this will rewrite 12 rows and make 12 remote calls" number the button must show **before** it can be confirmed.
- `POST { dryRun: false }` → the same call for real, with the **target** provider built in-process (the live one is the wrong one by definition). Runs as a single in-memory job: `{ state: 'idle'|'running'|'done'|'error', dryRun, done, total, rewritten, failed[] }`, progress fed by `reembedAll`'s `onProgress`. A second `POST` while running is a **409**, not a queue.
- `GET` returns the job. Polling, not SSE: one client, one process, and a stream is a second protocol to maintain for a progress bar.
- `failed[]` is shown verbatim. Rows that failed stay at the old width and therefore stay counted in `unreadableRows` — the warning does not clear itself on a partial migration.
- **The dark window is the UI's to own.** When the migration finishes, `unreadableRows` climbs from 0 to N and the running server's searches go *empty* until it restarts. That is not a bug to hide behind a green success state: the non-dry run requires an explicit acknowledgement of that sentence first, and afterwards the panel shows `restart now to restore search` rather than a checkmark.

### D6 — The panel lives in Stats
An `Embeddings` card in the Stats view (the view that already owns store-wide facts): live provider / model / dim and its source; the three presets as a radio group; the missing-key line naming the exact env var; a `switch` control with the copy that switching rewrites vectors and needs a restart; the store's width histogram (reuse `Histogram`) with the unreadable count in `--danger` when non-zero; dry-run → `Confirm` stating the real numbers → progress → result; and a persistent `restart required` banner while `needsRestart` is true.

Keyboard/theme/component rules are the console's existing ones — no new component library, no new colour.

### D7 — Say the cost out loud
A rewrite to `openai`/`nim` is one HTTP call per row (batched, `batchSize` 64) and real money. The dry-run numbers are mandatory on the confirm screen, and the copy says rows-and-calls, not "optimizing your index".

## Files

| file | what |
|---|---|
| `src/core/settings.ts` | new — read/tolerant-validate/atomic-write `~/.ai-memory/settings.json`, env-merge helper, key whitelist |
| `src/core/embedding/index.ts` | export the preset/default table the factory already holds (`index.ts:8-9`) so `GET /embedding` reads it instead of retyping |
| `src/core/stats.ts` | `byVectorDim` in `StatsSummary` + `summarize` |
| `src/core/memoryService.ts` | construct with the merged env (`:29`) |
| `src/cli/index.ts` | merge settings in `cmdReembed` too (`:225`), or the CLI migrates with a different provider than the console would |
| `src/api/server.ts` | `GET /embedding`, `POST /embedding`, `POST`/`GET /embedding/reembed`; the in-memory job |
| `ui/src/lib/api.ts` | `api.embedding()`, `api.setEmbedding()`, `api.reembed()`, `api.reembedJob()` + types |
| `ui/src/views/Stats.tsx` | the panel (D6) |
| `tests/settings.test.ts` | new — precedence (env beats file), tolerant read of a broken file, atomic write, unknown key rejected |
| `tests/console-api.test.ts` | `byVectorDim`; `GET /embedding` shape + key booleans; `POST /embedding` 400s (unknown provider, missing key) with no file written; reembed dry-run vs real on a 2-partition fixture; 409 while running |
| `README.md`, `.env.example`, `CONTEXT.md` | the switch, the home-dir settings file, and that env wins |

## Order

ADR-0009 → `settings.ts` + merged construction (+ tests) → `byVectorDim` (+ test) → `GET /embedding` → `POST /embedding` → the reembed job → the UI panel → docs.

## Checks / Done when

- `npm test` green (240 today plus the new cases), `npm run lint` exit 0, `npm --prefix ui run typecheck` exit 0, `npm run ui:build` + `npm run build` exit 0.
- **The default `/stats` shape is unchanged**; `byVectorDim` appears only under `full=1`.
- A fixture store with one row at a foreign width makes `GET /embedding` report exactly that many `unreadableRows`, and the UI shows the warning. A store where every width matches shows none.
- `POST /embedding` with `provider: "nope"` → 400 quoting the factory's own message, **and `settings.json` does not exist afterwards**. Same for `openai` with no `OPENAI_API_KEY`.
- Precedence, proved without touching the real home: a temp `settings.json` sets `nim`; a temp env `EMBEDDING_PROVIDER=openai` + a key beats it; with neither, `hash`.
- Reembed: dry-run on a 2-partition fixture reports the row count and writes nothing (embeddings byte-identical afterwards); the real run rewrites them and a `dryRun:false` retry is a no-op; an embedder that throws per row lands in `failed[]` and still answers 200 with the job's counts.
- Manual, this machine (only `hash` is configured — no NIM/OpenAI key): the panel names `hash` as live at 384d, lists both other providers as needing their env var **by name**, the width histogram matches `ai-memory stats`, and the warning is absent because every row is 384.
- Manual, the migration path: `POST /embedding` → `GET /embedding` reports `needsRestart: true`; **a restart at this point is refused by `init()` naming both dims** (existing behaviour, unchanged — this is the check that it still guards); then the real reembed → `GET /embedding` reports **every** row unreadable by the live provider, i.e. the dark window visible as a number; restart → `needsRestart: false`, `live.source: "settings"`, `unreadableRows: 0`, and search answers again. `ai-memory reembed` in a terminal still works and uses the same merged provider.

## Not doing

- **Live hot-swap** of the running embedder (ADR-0009).
- **Tightening the startup guard** in `MemoryService.init()` / `storedDim()` to sweep every row. Its own comment asks for the sweep and this ticket makes the number visible, but changing it changes what the CLI, the MCP server and the API all do on boot — that is its own ticket, with its own decision about what a mixed store should do.
- API keys in the UI, in `settings.json`, or echoed back in any form — only presence, and only the variable's name.
- A provider per request, a provider per namespace, or two providers at once — one process, one vector space.
- SSE/websocket progress (polling is one route), a job queue, resumable migrations, or surviving a server restart mid-migration (`reembed` is idempotent, so a restart-and-rerun is the answer).
- Auto-restarting or re-executing the server after a settings write.
- Writing `.env` for the user, or migrating the existing `.env`/`EMBEDDING_PROVIDER` values into `settings.json`.

## Risk

- **Two processes, one store.** A daemon and this server can hold the same `memory.db`; a settings write only affects what starts next. The UI says "restart required" for *this* process, and the panel must not pretend the daemon changed. `ai-memory db info` and `/health` are the places that explain which store and which process is speaking.
- **A migration is not atomic.** An interrupt leaves mixed widths — safe (skipped rows are skipped, not fatal) but degraded, and that is exactly why `unreadableRows` stays visible until the count is zero rather than being cleared by a successful *start*.
- **`settings.json` is a new write path into the user's home.** Tolerant read, whitelist, temp+rename, no keys — the four rules are the whole defence, and `tests/settings.test.ts` is what keeps them from drifting.
- **Remote embedding is a real spend.** The dry-run count is the only thing between a click and N API calls, so it is mandatory on the confirm screen, never "~N".
