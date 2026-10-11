---
title: "Memory Console: a React+Vite UI over recall, memories, sessions, graph, stats"
label: wayfinder:task
type: task
HITL: false
blockedBy: []
blocks: []
---

## Question

`open-memory` already ships an inspector: `src/ui/` — `index.html` (164) + `app.js` (232) + `graph.html` (37) + `graph.js` (255) + `style.css`, plain files served by the same `node:http` process, Tailwind from a CDN. It covers list, create, search playground, soft-delete, pin/status, supersede, export, wiki graph.

What it does **not** do, and what this ticket is for:

1. **Nothing is explainable in the UI.** The API has returned per-hit score decomposition since R1 (`?explain=1` → `bm25 +0.37 · recency +0.24 · strength +0.12 = 0.737`) and the inspector throws it away — the most interesting number in the system is only visible via `ai-memory search --explain`.
2. **Nothing is a timeline.** `strength` / `last_used_at` are reinforcement state (`src/core/store/sqlite.ts:406`) but the UI shows a flat list, so "what is this store actually being used for" is unanswerable.
3. **No session view.** `~/.pi/agent/sessions` currently holds **47 session dirs / 569 `.jsonl` files** (measured). The fabric `memory.recall` index over that timeline is pi-fabric's (`pi-fabric/dist/chunks/chunk-4HJNG5LT.js`), not this repo's — so a UI for *this* memory system has to read those files itself.
4. **`GET /stats` is three numbers** (`{namespace,total,byType,embedding,dim}`) — no decay candidates, no chain count, no reinforcement view.

**Task (AFK, do-not-decide):** a second UI — a Memory Console — built with **React + Vite**, shipped inside this repo next to the inspector, covering the four views the human picked: **recall (search + explain)**, **memories (CRUD + governance)**, **sessions (timeline)**, **graph + stats**.

The inspector stays and keeps `/` until the console covers it. This is a *new app alongside*, not a rewrite.

---

## Decisions

### D1 — `ui/` at repo root, own package.json, toolchain stays out of the package

Vite + React + TypeScript in `ui/`, with `ui/package.json` holding the dev toolchain (`react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `typescript`, `@types/*`). Root `package.json` keeps `"dependencies": {}` untouched — that promise is about the *published CLI*, and a browser bundle is not a runtime dependency of `ai-memory`.

`ui/` is **tracked in git**. Precedent to avoid: `.gitignore` currently excludes `pi-usage-ui/` as "another project that lives in this folder — not part of ai-memory". This one is part of it, so it ships.

This contradicts the "Not doing: new dependency, framework, build step" line in earlier tickets, so **ADR-0007** records the reversal, the exemption boundary, and the exit (delete `ui/` and the `/app` route and the package is exactly what it was). Nothing else in the repo changes behaviour.

### D2 — two dev servers, one origin in prod

- API: `npm start` → `127.0.0.1:3000` (`src/api/server.ts`, `PORT` / `MEMORY_PORT`).
- Console dev: `npm --prefix ui run dev` → `127.0.0.1:5173`, Vite proxy for `/memories`, `/memories/search`, `/graph`, `/positions`, `/stats`, `/health`, `/extract`, `/decay`, `/sessions` → `http://127.0.0.1:3000`.
- Prod: `vite build` → `ui/dist` → `scripts/copy-ui.mjs` also copies it to `dist/src/ui-next` → `server.ts` serves it under **`/app`** (inspector keeps `/`, `graph.html`).

All client fetches use **absolute paths** (`/memories?…`), never a configured base, so the same build works behind the dev proxy and behind `server.ts` with no CORS work and no `VITE_*` base. The one exception is an optional `VITE_API_BASE` for pointing the dev server at a different port.

In dev via `npm start` + tsx (no build present) `/app` falls back to serving `ui/dist` when it exists, else 404s — one `if`, because the alternative is "the console 404s unless you remembered to build".

### D3 — no router dependency; hash routing

`#/recall`, `#/memories`, `#/sessions`, `#/graph`, `#/stats` — a ~30-line `useHash()` in `ui/src/router.tsx`. A router library for five flat views is the dependency that pays for nothing. Deep links work, refresh works, and `server.ts` needs no SPA fallback because the server only ever sees `/app/`.

### D4 — Recall view: the explain payload is the point

Controls: query, namespace, type, and three sliders — `k` (1-20), `threshold` (0-1), `budgetTokens` (100-4000). One row of presets: **HTTP floor 0.72** vs **pi agent floor 0.35 EN / 0.2 CN** — the divergence README documents becomes a button instead of a paragraph, which is how the human will actually feel why it exists.

`POST /memories/search` with `explain: true`, and each hit renders the decomposition as a stacked bar (`bm25` / `recency` / `strength` / total), plus:

- budget bar `tokensUsed / budgetTokens`, `truncated` badge, and the overflow `summary` when present;
- the relevance-floor behaviour is *visible*: a zero-hit result renders "nothing cleared 0.72 — empty is the designed answer, not a failure" rather than an empty void;
- per-hit "strength was reinforced" hint when `strength > 0.5`.

No `explain:false` fast path in v1 — the panel exists to show the why.

### D5 — Memories view: governance with the destructive ops confirmed

Table: text preview, type, status, importance, strength, `last_used_at` age, pinned, superseded. Filters: namespace, type, status, `includeDeleted`, `q`.

Detail drawer (`GET /memories/:id`): full text, tags, source, timestamps, embedding-independent metadata, and the **supersede chain** — follow `supersedes_id` to the ancestor, and find the successor by filtering the list response for rows whose `supersedes_id` is this id (one extra list call, no new endpoint).

Actions: create (`POST /memories`), `POST /extract`, edit metadata (`PATCH` `status` / `pin`), soft-delete (`DELETE`), restore (`PATCH {isDeleted:false}` — the route supports it and the CLI's `restore` uses it), supersede (`POST /memories/:id/supersede`), `POST /decay` with its pruned count.

Delete, decay and supersede each need an explicit confirm; `decay` states what it will prune *before* running (predicates below), because it is the one button that destroys data in bulk.

### D6 — Sessions view: read pi's own timeline, read-only, no index, no table

Two new read-only routes:

| route | returns |
|---|---|
| `GET /sessions?limit=&offset=` | `{sessions:[{id, file, dir, mtimeMs, sizeBytes, turns}], total}` — dirs walked from `PI_SESSIONS ?? ~/.pi/agent/sessions`, `.jsonl` only, newest first |
| `GET /sessions/:id?offset=&limit=` | `{id, file, turns:[{index, role, tool, timestamp, isError, text}], total, truncated}` — line-paged, text clipped per turn (default 400 chars, `?full=1` to bypass) |

Discipline that matters here:

- **Directory comes from env, not from the request.** `PI_SESSIONS` / `PI_AGENT_DIR` resolved server-side; a `file` query param would be a path-traversal hole in a route whose whole job is reading files.
- **Read-only. Never write, never mutate, never create a session index.** An `id` resolves only to a file that a fresh walk actually returned.
- **Size guards**: cap the bytes read per turn-list request and report `truncated: true` instead of loading a 40 MB jsonl into memory.
- Only `role`, `tool`, `timestamp`, `isError` and text are surfaced; anything else in the JSONL is ignored (it is pi's format, not ours, and coupling to it is what the guard is for).

The view: session list (dir, file, mtime, turn count), then a vertical timeline where turns are grouped and the memory-relevant ones are highlighted — `memory_search` / `memory_save` / `memory.recall` tool calls get a distinct marker with their query/result, because "what did the agent recall, and when" is the question the timeline exists to answer.

Cross-link: a memory whose `source` contains the session file/id renders a "from this session" chip, and a session turn that produced a memory links into the memories view. One string match, no join table.

### D7 — Stats view: only numbers the store actually has

`GET /stats` gains an **additive** `?full=1`: by type, by status, pinned, active-vs-tombstoned, `strength` histogram, age histogram from `created_at`, reinforcement count (`strength > 0.5` or `last_used_at` set), **decay candidates** using the exact predicates from `decay.ts` (episodic >90d && `importance <= 0.3`; working >7d), supersede chain count, embedding provider/dim, db path and file size.

**No token-savings chart.** Recall results are not persisted (`tokensUsed` lives only in a response), so any "tokens saved" number would be invented. The view shows budget behaviour live in the recall panel and says so in one line; a `recall_log` table is the upgrade path, explicitly not this ticket.

### D8 — Graph view v1 = the existing `graph.html`, embedded

`graph.js` already does force layout, pan/zoom/drag, position persistence, local graph BFS, `tag:`/`path:` filters, folder colour groups and hover focus (`wayfinder/tickets/012`). Porting 255 lines of canvas to React buys nothing the human asked for, so v1 embeds `/graph.html` in a view-filling iframe and adds nothing to `graph.js`.

Documented as a deliberate ceiling: a React graph is justified only when the graph needs to share state with the console (e.g. clicking a node filters the memories table).

### D9 — Plain CSS, no component library

One `ui/src/styles.css` with CSS variables for the existing zinc-950 palette, so the console and the inspector do not look like two different products. No Tailwind CDN (the current inspector's `index.html` pulls it from a CDN — that is an offline-first repo loading its styling from the network, and the console does not repeat it). No shadcn/MUI in v1: five views, mostly tables and bars.

---

## Files

| file | change |
|---|---|
| `docs/adr/0007-react-console-beside-zero-dep-ui.md` | new — the reversal, the exemption boundary, the exit |
| `ui/package.json`, `ui/vite.config.ts`, `ui/tsconfig.json`, `ui/index.html` | new — Vite app, proxy table, `base: "/app/"` |
| `ui/src/main.tsx`, `ui/src/router.tsx`, `ui/src/styles.css`, `ui/src/api.ts` | new — shell, hash router, client + response types |
| `ui/src/views/Recall.tsx` | new — sliders, floors preset, explain bars, budget bar, summary |
| `ui/src/views/Memories.tsx`, `ui/src/views/MemoryDrawer.tsx` | new — table, filters, detail, governance actions |
| `ui/src/views/Sessions.tsx` | new — session list + turn timeline, memory-call markers |
| `ui/src/views/Graph.tsx` | new — iframe on `/graph.html` |
| `ui/src/views/Stats.tsx` | new — histograms, decay candidates, store info |
| `ui/src/lib/format.ts`, `ui/src/lib/supersede.ts` | new — pure helpers (score/token/age formatting, chain walk) — the unit-tested part |
| `src/api/server.ts` | `?full=1` stats; `/sessions` + `/sessions/:id`; `/app` static route (~+120 lines) |
| `src/core/sessions.ts` | new — walk, parse, page, size-guard (~110 lines, `node:fs` only) |
| `scripts/copy-ui.mjs` | also copy `ui/dist` → `dist/src/ui-next` (best-effort, skip when unbuilt) |
| `package.json` | `files` += `dist/src/ui-next`; scripts: `ui:dev`, `ui:build` (2 lines) |
| `tests/api.test.ts`, `tests/sessions.test.ts` | stats `full=1`, session walk/parse/page/traversal-guard |
| `ui/src/lib/*.test.ts` | pure-helper tests (picked up by the existing vitest `environment: node`) |
| `README.md`, `CONTEXT.md` | the console: how to run it, `/app`, and what the four views are for |
| `.gitignore` | `ui/node_modules/`, `ui/dist/` |

Order: ADR-0007 → shell + proxy + router → recall → memories/governance → `?full=1` + stats → sessions (server then view) → graph iframe → build/serve wiring → tests + docs.

---

## Checks / Done when

- `npm test` green, plus new cases:
  - `GET /stats?full=1` adds the new fields and leaves the default shape byte-identical;
  - `sessions.ts` on a fixture dir: only `.jsonl`, newest-first ordering, line paging matches, a missing/corrupt line returns `isError`-style passthrough instead of throwing, an oversized file reports `truncated`, a `..`-style id or a path outside the sessions root is refused (400/404, never a read).
- `tsc -p tsconfig.lint.json` exit 0; `npm --prefix ui run typecheck` exit 0.
- `ui/src/lib/*.test.ts` cover the supersede-chain walk in both directions and the score/token formatters.
- Manual, with `npm start` + `npm --prefix ui run dev` on the real store (`coding-agent:frank`, 13+ rows):
  - a query whose hits show a real decomposition (`bm25 + recency + strength = total`) and a budget bar that moves when the slider moves;
  - the 0.72→0.35 preset change actually changes the hit count on the same query (that is the divergence, felt);
  - create → pin → status → supersede → soft-delete → restore all round-trip and survive a page reload, confirmed independently with `ai-memory list` / `ai-memory get`;
  - a real session from `~/.pi/agent/sessions` opens, pages, and its memory tool-calls are marked;
  - `/graph.html` renders inside the console's graph view;
  - stats numbers match `ai-memory stats` for the same namespace.
- `npm run build` produces `dist/src/ui-next`; `node dist/src/api/server.js` serves the built console at `/app` and the inspector at `/` — both 200, and `/app` 404s cleanly when the console was never built.
- Inspector untouched: `src/ui/*` diff is empty in this ticket.

---

## Not doing

- **Replacing the inspector.** Root `/` stays the inspector until the console covers list/search/governance/graph; swapping root is a follow-up ticket with its own delete-the-old-UI diff.
- **Porting the graph to React** (D8). Iframe until the graph needs to share console state.
- **Indexing sessions into SQLite / a `sessions` table.** The filesystem is the source of truth for pi's timeline; an index is a second stale copy.
- **A `recall_log` table or any token-savings chart** (D7) — no fabricated metrics.
- **Auth, multi-user, remote binding.** The API binds `127.0.0.1` and the console inherits that. `visibility` is a fixed `private` today; a login screen would be security theatre over a loopback socket.
- **Component library, Tailwind, router dependency, state manager** (D3, D9).
- **A graph/observability dashboard for pi's own usage** — that is `pi-usage-ui/`, deliberately not part of this repo.
- **Writing to `vault/`, editing markdown, or note-taking in the console.** The graph stays a read-only view over files (map.md).
- **Light theme, mobile layout, i18n, keyboard shortcuts.** Dark desktop first; taste later.

---

## Risk

- **Toolchain in a zero-dependency repo.** `ui/package.json` is the firewall: root deps stay `{}`, `npm test` / `npm run build` of the package never need node_modules inside `ui/`, and `tsc` already excludes `ui/dist`. `copy-ui.mjs` must stay best-effort so a package build does not fail on a machine that never installed the UI dev deps.
- **Two static roots, one server.** `/app` and `/` must not shadow each other — the `/app` branch runs before the catch-all static handler and is covered by a test, since the existing catch-all does `normalize(path)` and a wrong prefix here would serve the inspector for `/app/foo`.
- **Reading pi's session files couples us to a format we do not own.** Contained in `src/core/sessions.ts`, tolerant of unknown fields and malformed lines by design; a format change degrades the timeline, it does not throw.
- **Explain payload size.** Four extra numbers per hit is real payload — fine for a UI whose point is showing them, and the CLI already gates it behind `--explain`, so nothing regresses.
