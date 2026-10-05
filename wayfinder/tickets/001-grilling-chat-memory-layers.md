---
title: "Chat Memory: keep flat 4-type or adopt Tencent L0-L3 layering?"
label: wayfinder:grilling
type: grilling
HITL: true
blockedBy: []
blocks: [003, 007]
---

## Question

Tencent Chat Memory grows in layers: L0 Conversation (raw, verifiable) → L1 Atom (facts/preferences extracted) → L2 Scenario (project/context blocks) → L3 Persona (long-term profile). Generation and retrieval are layered: bootstrap L2/L3 (quick context), fallback to L1/L0 via BM25+vector+RRF with item/char/timeout budgets. Our substrate today is flat: `Memory {type: episodic|semantic|procedural|working}` in one table, hybrid+MMR+hard budget (`src/core/retrieval/hybrid.ts:14`). Do we **(A)** add L0-L3 as a second axis (keep 4-type + layers), **(B)** replace 4-type with L0-L3, or **(C)** keep flat and simulate layers via `importance`+`tags`? The answer fixes `memory.records` vs `chat_memory` schema, how `save`/`search` behave, and what the inspector shows.

**Grill one at a time, with domain-modeling:**
- Sharpen "Atom" vs "Semantic Memory" (our glossary) — are they the same? What does "Scenario" mean for solo (a repo? a feature?)?
- Scenario: User says "don't refactor auth — mobile still uses it" → which layer stores it for retrieval next week?
- Cross-check code: `src/core/types.ts:1` vs Tencent's async L0→L1 pipeline.

**Resolution = decision:** Pick A/B/C + layer names + where each layer is written/read + budget per layer. Link an ADR sketch if the schema changes.

**Out of scope to avoid here:** Skill/Wiki/CodeGraph layering — this ticket is Chat Memory only.

---

## Resolution (2026-08-31) — **C**

- **Picked C** (`use ours`): keep `episodic|semantic|procedural|working`, simulate Tencent layers via `tags`+`importance` — no `layer` column. Mapping documented in `CONTEXT.md: Layer (solo alias)` and `docs/adr/0005-flat-layers-via-tags-C.md:1`.
- **Why:** Solo needs 0 migration and one flat `HybridRetriever` (`src/core/retrieval/hybrid.ts:14`). High `importance 0.9` semantic (L1/L3) already outranks episodic with `threshold 0.72` + `budget 800`; MMR prevents duplication. Evidence: <5k memories, no pollution proven. Graduates to `A` via `ADD COLUMN layer TEXT` backfilled from `tags` if needed.
- **Example:** `don't refactor auth` → `semantic, importance 0.9, tags [scope:scenario:auth, scope:repo:memory]`.
- **Status:** **Closed** — unblocks `009` (`blockedBy [001]` now satisfied) and partially `003`/`007`.
