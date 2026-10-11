---
title: "CodeGraph-lite: persist in memory.db or reuse .codegraph/ index?"
label: wayfinder:research
type: research
HITL: false
blockedBy: []
blocks: [006, 007]
---

## Question

Tencent CodeGraph indexes symbols/files/calls/impact paths from the codebase. We already have `codegraph` MCP (ephemeral) + `.codegraph/` index. For solo, do we **persist** a CodeGraph asset (tables `code_files`, `code_symbols`, `code_edges` in `memory.db`) or **reuse** the existing `.codegraph/` as the durable store and treat CodeGraph as a view/tool (`/v3/tools/call` style) without adding tables?

**Research via subagent:**
- Local `.codegraph/` schema + `codegraph_explore` vs Tencent CodeGraph asset (files/symbols/calls/impact)
- Our `src/core/store/sqlite.ts:1` (node:sqlite) — cost of new tables vs zero
- Tencent's "knowledge isn't injected wholesale — it's called on demand" pattern

**Deliver:** Persist vs reuse trade table + recommendation + minimal persisted shape if persist (e.g. `file, symbol, kind, calls[]`).

---

## Research (2026-08-31)

Sources: local `codegraph status` (fresh `codegraph init C:\memory` → 28 files, 268 nodes, 622 edges, 0.75 MB `node:sqlite` WAL at `C:\memory\.codegraph\codegraph.db`), `codegraph explore` / `codegraph node` (MCP `codegraph_explore` verbatim source + blast radius; same output as explore), `src/core/store/sqlite.ts:30` (`memories` single table), Tencent README (CodeGraph files/symbols/calls/impact, knowledge on-demand via `/v3/tools/list` → `/v3/tools/call`, async `ready`).

### Evidence (solo)

- **Already have durable CodeGraph:** `.codegraph/codegraph.db` is full SQLite (WAL, `SQLite format 3`), 268 nodes (8 class, 47 method, 31 function, 12 interface…) + 622 edges; `codegraph explore "memoryService HybridRetriever"` returns 76 symbols across 21 files with blast radius (`HybridRetriever` 3 callers in `memoryService.ts`) — same as `codegraph_explore` MCP tool. `codegraph node "HybridRetriever"` → callers traced.
- **No integration cost:** `codegraph init` is one command, `sync` incremental; MCP tool already “ephemeral” only if not initialized — now durable.
- **Our `memory.db`:** 1 table `memories`, brute-force `vectorSearch` (loads all rows, cosine, sort); adding `code_*` tables would double indexing work + sync logic.

### Trade

| Option | What you build | Solo cost (code, storage, tokens) | Retrieval quality | Solo verdict |
|---|---|---|---|---|
| **Persist in `memory.db`** (`code_files`, `code_symbols`, `code_edges`) | New tables + ingest `codegraph.db` → `memory.db` snapshot + sync on `codegraph sync` + API `/codegraph/search` over `memory.db` | **High.** New schema + migration, duplicate 0.75 MB index, keep two DBs in sync, need impact-path DFS in SQL or JS. Embed code chunks separately for vector search (dim 2048) → double embed cost. | Same as reuse, but stale risk (snapshot lags `.codegraph`). No gain if you duplicate call graph faithfully. | Only if you need CodeGraph to travel with `memory.db` as single file cold-start for another machine without `.codegraph/`. |
| **Reuse `.codegraph/` as durable, view/tool (recommended)** | **Zero new tables.** Treat `.codegraph/` as the CodeGraph asset. Agent calls `codegraph_explore` / `codegraph node` on demand (Tencent’s “knowledge isn’t injected wholesale — it’s called on demand”); optional thin HTTP proxy `GET /codegraph/explore?q=…` that shells to `codegraph explore`. | **Zero.** No migration, no duplicate storage, no embed cost; uses existing 268-node index. Sync = `codegraph sync`. Storage stays `0.75 MB` `.codegraph/` + `~100k` `memory.db` separate. | **Best.** Full call graph + impact, verbatim source + blast radius in one shot (proven above). On-demand avoids Context Burning (don’t stuff code into every prompt). Matches Tencent `tools/call` pattern. | **Solo 80/20.** One command cold-start: `codegraph init ./my-repo`; inspector can show file list via `codegraph files` without new tables. |

### Recommendation

**Reuse** — no new tables in `memory.db`. CodeGraph is a **view/tool** over `.codegraph/`, not a `memories`-row asset.

- Cold-start for another repo: `codegraph init ./other-repo` (or `codegraph sync` if already), not “import code → code_rows in memory.db”.
- If you later want code snippets searchable via `HybridRetriever`, add them **lazily** as `semantic` rows with `tags: ["scope:codegraph","file:src/core/memoryService.ts"]` only when a file is manually “save to memory” — not bulk snapshot.
- Inspector “CodeGraph” tab = `codegraph files` + `codegraph explore` output, not a `SELECT * FROM code_symbols`.

**Minimal persisted shape if you ever persist** (for reference, not for v1):

```sql
CREATE TABLE code_symbols(id TEXT PK, file TEXT, symbol TEXT, kind TEXT, line INTEGER, calls TEXT); -- calls = JSON ["otherSymbol"]
CREATE TABLE code_edges(src TEXT, dst TEXT, kind TEXT); -- call/import
```

For v1: **skip it.** `.codegraph/codegraph.db` is the shape.

**Status: Researched — unblocks 007 (CodeGraph dimension) and 010 (schema task — confirms no new tables needed for CodeGraph).** `008` now front-runs; `007` still needs Wiki prototype verdict `keep graph` from 004 HITL.

