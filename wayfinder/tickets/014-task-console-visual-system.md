---
title: "Console: visual system + usability pass, and it replaces the inspector"
label: wayfinder:task
type: task
HITL: false
blockedBy: []
blocks: []
---

## Question

Ticket 013 specifies the console's *scope* — five views over an API that already returns a score decomposition, a supersede chain, a session timeline and histograms — and the **backend half is done and green**: `src/core/sessions.ts`, `?full=1` stats, `/sessions` + `/sessions/:id`, the `/app` static route, `tests/{sessions,console-api}.test.ts` (`npm test` = 220 passed, measured). What is missing is the app: `ui/` does not exist.

Two things 013 left open, and the reason this ticket exists:

1. **What it looks like.** 013's `Not doing` says *"Light theme, mobile layout, i18n, keyboard shortcuts. Dark desktop first; taste later."* This is the taste. The human picked *dark premium* + *warm-white editorial*.
2. **The inspector's fate.** 013 keeps it at `/` and ships the console beside it at `/app`. But the inspector renders **unstyled with no network** (`cdn.tailwindcss.com`, `src/ui/index.html:7`) in a local-first offline tool, and it throws away the explain payload it already receives. Two UIs over one API, neither one good.

## Decisions

### D1 — Two themes, one token set
Dark **Vantablack** (default) and light **Paper** (warm white): same layout, same components, different values. Three-state control `auto | dark | light`, `auto` following `prefers-color-scheme`, choice in `localStorage`. A second token set is ~40 lines of custom properties; two *parallel designs* would be the expensive version and is not what this is. The warm-white surface is what makes a long session transcript and a memory's full text legible.

| token | Vantablack | Paper |
|---|---|---|
| `--bg` | `#08090B` | `#FBFAF7` |
| `--panel` / `--panel-2` | `#0E1013` / `#14171C` | `#FFFFFF` / `#F5F3EE` |
| `--hairline` (hover) | `rgba(255,255,255,.06)` (`.11`) | `rgba(0,0,0,.07)` (`.14`) |
| `--fg` / `--dim` / `--faint` | `#E9EBEF` / `#8A9099` / `#5A6068` | `#17181A` / `#6F6D68` / `#9C9A94` |
| `--accent` | `#8FA6FF` | `#2F5D50` |
| radius | 8px card / 6px control | same |
| motion | `150ms`/`220ms cubic-bezier(.2,.8,.2,1)` | same |

### D2 — No CDN, no Inter, no icon font
Everything ships in the bundle. Fonts are system stacks: UI `ui-sans-serif, "SF Pro Display", Geist, system-ui`; numerals and code `ui-monospace, "SF Mono", "JetBrains Mono", Consolas` with `font-variant-numeric: tabular-nums`; Paper headings `"Iowan Old Style", Georgia, serif` at `letter-spacing: -.02em`. No Tailwind, no component library, no chart library, no icon library — six hand-written inline SVGs.

Bans, because each one is what makes a generated UI read as templated: gradients, saturated fills on large surfaces, shadows heavier than `0 24px 48px -24px rgba(0,0,0,.6)` (light theme uses a hairline instead), emoji anywhere (the `🔍` in `index.html` does not come back), sticky full-width top bars, motion that is `linear`/`ease-in-out` or instant.

### D3 — Shell
220px nav rail (Recall · Memories · Sessions · Graph · Stats), content `max-width: 1280px`, no sticky top bar. Header carries the namespace picker, a `/health` indicator with version and db bytes, and the theme control. Recall is an asymmetric 4/8 split; the rest are single-column with bento cards where the numbers need grouping.

### D4 — Recall: the explain payload is the interface
Per hit: a stacked bar (`bm25` / `recency` / `strength`) plus the right-aligned total in mono. Budget bar `tokensUsed / budgetTokens` with a `truncated` badge and the overflow `summary` when present. The floors 013 documents as a paragraph become preset buttons — HTTP `0.72` vs agent `0.35 EN` / `0.2 CN` — so the same query visibly goes from zero hits to several, which is the divergence *felt* rather than read. Zero hits renders "nothing cleared the floor — empty is the designed answer, not a failure"; never a blank box.

### D5 — Namespace is a picker, which needs one small route
`store.distinctNamespaces()` already exists (`src/core/store/interface.ts:34`, sqlite at `sqlite.ts:306`) and is what `--all` enumerates. Add `GET /namespaces -> { namespaces }` (~12 lines, one store call) rather than a `localStorage` datalist: the read fan-out (own partition + `shared` + `default:default`) is exactly what nobody can guess on sight, and a picker of *real* partitions is how someone stops typing a namespace that has nothing in it.

### D6 — Keyboard
`/` focus search, `Esc` close drawer, `⌘`/`Ctrl`+`Enter` submit, `j`/`k` move table selection. 013 excluded shortcuts; "usable" without them means reaching for the mouse on every row.

### D7 — Destructive operations confirm; `decay` previews first
delete / supersede / `POST /decay` each confirm. `decay` reads `?full=1` first and states how many rows and by which predicates (`stats.ts` already computes the candidates: `episodic` >90d && `importance <= 0.3`, `working` >7d) before the button is live — the preview reads the same constants the prune uses, on purpose.

### D8 — Sessions timeline, with the memory calls marked
Turns grouped by role; `memory_search` / `memory_save` / `memory.recall` calls marked with their query and result, because "what did the agent recall, and when" is the question the timeline exists to answer. A memory whose `source` contains the session id renders a `from this session` chip linking to Memories, and a marked turn links back — one string match, no join table (013 D6). Read-only, env-resolved root, size-guarded: unchanged.

### D9 — Graph is framed, and it has to learn the theme
`src/ui/graph.html` is hardcoded `#09090b`/`#18181b` and its canvas draws from its own palette. v1 frames it and passes `?theme=dark|light`; `graph.js` reads that param and swaps its palette variables. Porting 255 lines of canvas to React is still not this ticket (013 D8) — but the palette has to become a variable, or the frame is a dark box sitting inside a light theme.

### D10 — State lives in the URL hash
View, query, filters, sliders and selected id go to `#/recall?q=…&k=5`. Refresh and deep links work with no router dependency (013 D3).

### D11 — Nothing invented
No token-savings chart, no fabricated latency, no confidence score the store does not hold. `textTokensEstimate` is labelled a size, never a saving (013 D7).

## Files

| file | what |
|---|---|
| `ui/package.json`, `ui/vite.config.ts`, `ui/tsconfig.json`, `ui/index.html` | toolchain: `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `typescript`, `@types/react{,-dom}`; dev proxy for the API routes to `127.0.0.1:3000`; absolute fetch paths only |
| `ui/src/{main.tsx,App.tsx,router.tsx}` | mount, shell, ~30-line `useHash()` |
| `ui/src/theme.ts`, `ui/src/styles/{tokens,base}.css` | D1 token sets, D2 bans, theme control |
| `ui/src/lib/{api,format,score,supersede}.ts` | typed fetch; relative-time / score / token formatting; supersede-chain walk both directions — the unit-tested part |
| `ui/src/components/*.tsx` | Nav, ScoreBar, BudgetBar, Histogram, DataTable, Drawer, Confirm, Badge, RangeField, Empty, Icons |
| `ui/src/views/{Recall,Memories,Sessions,Graph,Stats}.tsx` | the five views |
| `src/api/server.ts` | `GET /namespaces`; `/` serves the console (one branch, plus a "run npm run ui:build" page instead of a blank 404) |
| `scripts/copy-ui.mjs`, `package.json` | copy stays best-effort; `ui:dev` / `ui:build` / `ui:typecheck`; `files` += `dist/src/ui-next` |
| `.github/workflows/ci.yml` | install + build `ui/` so the published tarball contains a UI |
| delete `src/ui/{index.html,app.js,style.css}` | **last step**, only after the console serves those views |
| `README.md`, `CONTEXT.md`, `.gitignore` | the console, the two themes, `ui/node_modules`, `ui/dist` |

## Order

ADR-0008 → `ui/` shell + tokens + proxy + router → Recall → Memories + governance → `GET /namespaces` + Stats → Sessions view (server half exists) → Graph frame + theme handoff → root handover + delete the inspector → CI/publish wiring → tests + docs.

## Checks / Done when

- `npm test` stays green (220 today) with added cases for `GET /namespaces` and the root handover; `npm run lint` and `npm --prefix ui run typecheck` exit 0.
- `ui/src/lib/*.test.ts` cover the supersede walk in both directions and the formatters.
- `npm run build` **never fails** when `ui/node_modules` was never installed, and the packed tarball still contains `dist/src/ui-next/index.html` on the CI path.
- Manual, on the real store (`coding-agent:frank`): sliders move the budget bar; the `0.72` → `0.35` preset changes the hit count on the same query; create → pin → status → supersede → soft-delete → restore round-trips and survives a reload, independently confirmed with `ai-memory list` / `get`; a real session from `~/.pi/agent/sessions` opens, pages, and its memory calls are marked; stats match `ai-memory stats`.
- Both themes render every view; `/graph.html` follows the theme through the frame; no unstyled flash on first paint.
- `/`, `Esc`, `j`/`k`, `⌘`+`Enter` work with the mouse untouched.
- **With the network off, `/` renders fully.** (The inspector does not — that is the bug this removes.)
- The inspector is gone: `/` and `/app` both serve the console, and nothing in the repo links `src/ui/index.html`.

## Not doing

- Porting the graph to React, mobile layout, i18n, auth / multi-user / remote binding, a component / chart / icon / router / state dependency, virtualized tables, a `recall_log` table, any write to `vault/`.

## Risk

- **No fallback UI.** Deleting the inspector removes the only UI that needs no build step; a broken `ui/` build leaves `/` explaining how to build rather than showing a page. Accepted deliberately — two UIs is the failure state we are in, and the copy step stays best-effort so the *package* build never depends on the UI dev deps.
- **Two toolchains, one CI.** Root `npm ci` no longer installs everything needed to run the project end to end; the CI step is the mitigation, and `npm pack` from a laptop that never installed `ui/` deps is the hole that remains.
- **A framed graph that ignores `?theme=`** is a silent dark box in the light theme — one string in, one `if` in `graph.js`, no second source of colour.
- **pi's `.jsonl` is a format we do not own.** Contained in `src/core/sessions.ts` (013 D6), unchanged by this ticket.
