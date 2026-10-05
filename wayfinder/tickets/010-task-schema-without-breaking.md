---
title: "Task: verify memory.db schema can host 4 assets without breaking retrieval"
label: wayfinder:task
type: task
HITL: false
blockedBy: [001, 003, 005, 008]
blocks: []
---

## Question

Before any migration, can the current `memory.db` (`memories` table in `src/core/store/sqlite.ts:1`) host Chat Memory layers + Skill + Wiki + CodeGraph-lite without breaking existing `memory_search`? What is the minimal additive migration?

**Task (AFK, do-not-decide):**
- Dump current `memory.db` schema (`sqlite3 memory.db .schema`).
- Prototype `ALTER TABLE memories ADD COLUMN asset_type` vs new tables `skills`, `wiki_pages`, `code_symbols` — which keeps `vectorSearch` fast (HNSW vs brute) and keeps `HybridRetriever` one-query?
- Report row counts, index choices, and a 3-line migration sketch. No decision — that lives in #001/#008.

**Done when:** A markdown note `wayfinder/tickets/010-task-schema-note.md` exists with schema diff + trade table.

---

## Done (2026-08-31)

Note created: `wayfinder/tickets/010-task-schema-note.md:1` (21 rows, 10 deleted; schema 12 cols + 4 indices; bench 2000 rows 13 ms → 11 ms with status). **Minimal migration is A: 3-line ALTER** (`visibility`/`status`/`pin`) per 008 lite; **no new tables** (`wiki_pages`/`code_symbols`) — keeps `HybridRetriever` one-query, avoids duplicate CodeGraph (005 reuse) and Wiki table (003 hybrid). No `asset_type` column (use `tags scope:*` per 001). **Closed — terminal.**

