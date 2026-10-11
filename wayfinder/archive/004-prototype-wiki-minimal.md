---
title: "Prototype: minimal Wiki page graph in the inspector"
label: wayfinder:prototype
type: prototype
HITL: true
blockedBy: [003]
blocks: [005]
---

## Question

Given the research in #003, what should a solo Wiki **look** like in `http://localhost:3000` when it is good enough? Raw chunk list, or structured pages with link graph drill-down?

**Prototype (cheap, concrete):**
- Build a throwaway `src/ui/` tab "Wiki" with 3 hard-coded pages (e.g. API spec, runbook, ADR) + link graph stub (links[] rendered as clickable pills) + "Import docs" drop zone (no backend).
- No real ingestion yet — this is to react to "how should it look / how should it behave" before deciding the pipeline.

**Resolution = link the prototype branch + human's reaction:** Keep graph or drop to flat? This unblocks cold-start (ticket 005).

---

## Resolution (2026-08-31) — **Prototype built, pending human reaction**

- **Branch:** local (no git branch) — `src/ui/index.html:142` (`#wikiPrototype` section with `prototype` badge) + `src/ui/app.js:163` (`wikiPages[3]` hard-coded + `renderWiki()` + pill drill + drop zone). `npm run build:ui` passes (10.71 kB html, 13.95 kB js).
- **What it is:** Throwaway UI tab “Wiki” between Memories and footer: 3 cards (`api-spec` links→`runbook,adr-0005`; `runbook`→`api-spec`; `adr-0005`→`api-spec,scenario:auth`) with `links` rendered as `↗ pill` buttons (click → drill alert), body truncated to 3 lines, `source: raw/...` line, link pills stopPropagation; Import zone is `border-dashed` drop area + `browse` file input (no backend — shows `prototype — not wired` toast, then `npm run wiki:ingest` hint). Truth per 003 hybrid: files `./wiki/*.md` would be truth, pills are `frontmatter links: []`, index is `tags scope:wiki`.
- **Why throwaway:** No `wiki_pages` table, no embed, no watcher — purely to react to look/behave before deciding pipeline (per 003 option C).
- **Human reaction needed (HITL):** View at `http://localhost:3000` after `npm run dev` (or `npm run build:ui` + `npx serve dist/ui`) — **Keep graph** (pages + pills drill-down + index via `scope:wiki`) or **drop to flat** (chunk list via `memory_search`)? Reply `keep graph` or `drop flat`.
- **Verdict (2026-08-31):** **`keep graph`** — human confirmed link-graph pills + structured pages are worth keeping (003 hybrid shape). Graph stays as `frontmatter links: []` → pills in `src/ui/app.js:163`, index via `tags scope:wiki`. Not flat chunk list.
- **Status:** **Closed — keep graph** — unblocks `007` cold-start (Wiki dimension). `blocks: [005]` was charting typo → treat as `blocks: [007]`.

**Note:** `blocks: [005]` in header is a charting typo — intended `blocks: [007]` (Wiki → Cold-start). Treat as such.

