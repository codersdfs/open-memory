# ADR-0005: Flat layers via tags (C) — keep 4-type, simulate L0-L3

- **Status:** Accepted (ticket 001, 2026-08-31)
- **Options:** A second axis `layer: L0..L3` alongside `type`, B replace `type` with L0-L3, **C keep flat `episodic|semantic|procedural|working` + simulate via `tags`/`importance`** (chosen).
- **Mapping:** `L0 raw ~= episodic (source:chat)`, `L1 Atom ~= semantic fact (importance>=0.7, source-linked)`, `L2 Scenario ~= semantic|procedural + tags scope:scenario:* / scope:repo:*`, `L3 Persona ~= semantic + tag scope:persona`.
- **Why C for solo:** Zero migration (`src/core/types.ts:1` + `src/core/store/sqlite.ts:1` frozen), one `HybridRetriever` query `src/core/retrieval/hybrid.ts:14` already weights `importance 0.05 + recency 0.15` + MMR + `threshold 0.72` + `budgetTokens 800` — high-importance semantic (L1/L3) naturally outranks low-importance episodic without two-phase RRF. <5k memories, no proven pollution.
- **Example:** "don't refactor auth — mobile still uses it" → `type: semantic, importance: 0.9, tags: [scope:scenario:auth, scope:repo:memory], source: chat:2026-08-31`, `working` stays throw-away (TTL <1d, not persisted).
- **Graduation path:** If layered budget or pollution proven, add non-breaking `ALTER TABLE memories ADD COLUMN layer TEXT` backfilled from `tags` + two-phase `bootstrap L2/L3 → hybrid fallback L0/L1` — no data loss.
