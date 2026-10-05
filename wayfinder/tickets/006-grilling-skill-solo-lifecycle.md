---
title: "Skill solo lifecycle: trigger, version, equip without team review?"
label: wayfinder:grilling
type: grilling
HITL: true
blockedBy: [002]
blocks: [007]
---

## Question

Given the skill shape from #002, how does a solo dev's Skill actually **live**: trigger boundary (`when: fix bug?`), execution (`steps:` as prompt vs `tsx` script), versioning (`v1`, `v2` vs git), equip (how does an Agent load it — `autoInject` vs manual `memory_search type=procedural`?), and validation (no team reviewer — what replaces review?).

**Grill with domain-modeling:**
- Sharpen "Skill" vs "Procedural Memory" — is a Skill a special Procedural Memory with `resource files`, or a separate asset?
- Scenario: Agent finishes "release checklist" once → extracts Skill → next week you run `npm run seed -- --import` — does the next Agent auto-eject the Skill or do you equip manually in the Hub?
- Where does a Skill live on disk? `./skills/<slug>/SKILL.md` (Hermes) vs `memory.db` row vs both?

**Resolution = decision:** Skill file layout + equip mechanism + version rule + trigger DSL. Must fit `src/api/tool.ts:1` without Proxy.

---

## Resolution (2026-08-31) — **B — Defer Skill asset (no separate Skill)**

- **Picked B** (`no need skill`): No separate Skill table/asset for solo v1. How-to stays flat `type: procedural` (`src/core/types.ts:1`) via `memory_save` / `memory_search type=procedural` (`src/api/tool.ts:1`). `./skills/<slug>/SKILL.md` convention from ticket 002 **not adopted** for this effort — deferred.
- **Why:** Solo cost of versions/resource files/bindings/review > value for <1 user. `HybridRetriever` already covers procedural recall with `importance` + `tags`; no `skills` or `skill_bindings` table, no review queue, no File↔DB sync. `002` research kept as reference for future revival.
- **Equip:** Manual `memory_search type=procedural` or `autoInject` (which already loads `procedural` among hits) — no per-Agent binding table.
- **Status:** **Closed** — unblocks `007` (one blocker satisfied). Skill moves to **Deferred** (not out-of-scope forever), see `wayfinder/map.md:18`.

**Deferred — revive later via 002 shape if procedural extraction proves noisy.**

