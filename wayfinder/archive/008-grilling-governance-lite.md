---
title: "Governance-lite: version/status/private for solo without ACL?"
label: wayfinder:grilling
type: grilling
HITL: true
blockedBy: [001, 006]
blocks: []
---

## Question

Tencent governance has `version`, `status`, `visibility` (`private`/`team`/`restricted`), `Owner`, `Agent` ACL. Solo needs no ACL, but still needs "who can use it, which version is valid" (ADR-0001 len). What is the **lite** model: keep `is_deleted`+`supersedesId` plus add `status=active|archived|draft` + `pin` + `version` (git sha or int)? Or is `importance` + `is_deleted` enough?

**Grill with domain-modeling:**
- Is "Visibility" a leaked team term for solo? Propose solo canonical: `Scope: private` (only) + `Status`.
- Scenario: Two Skills with same trigger — which wins? Does `version` + `updatedAt` decide, or explicit `pin`?
- Inspector: What does "Manage ownership, versions, status" look like with one owner?

**Resolution = decision:** Columns to add to `memory.db` (if any) + inspector controls + what stays out of scope (ACL).

---

## Resolution (2026-08-31) — **Lite (A + Lite)**

- **Picked A** (`visibility` keep always `private`) + **Lite** (`status`+`pin`+`visibility`). Keeps Tencent header (`private`) for parity, drops `team`/`restricted`/`agent`.
- **Columns to add** (additive, non-breaking, on top of `src/core/store/sqlite.ts:30` `is_deleted, supersedes_id, importance`):
  ```sql
  ALTER TABLE memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility='private');
  ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','draft'));
  ALTER TABLE memories ADD COLUMN pin INTEGER NOT NULL DEFAULT 0 CHECK(pin IN (0,1));
  -- version stays via supersedesId chain (ADR-0001), not a new column; git sha is version for files
  ```
  `visibility` always `private` (solo canonical), `status` drives retrieval (`archived` excluded from `vectorSearch` unless `includeArchived:true`, `draft` hidden from `autoInject`), `pin` boosts Hybrid rank (or forces `score=1` in `src/core/retrieval/hybrid.ts:53` when `pin=1`).
- **Inspector:** list filter `status: active|archived|draft|all`, badge `private` (dim), `pin` toggle button in detail drawer (`src/ui/app.js:128`); “Manage ownership, versions, status” → owner is `default:default` (implicit), versions via **Supersede chain** + `pin`, status via dropdown.
- **Out of scope:** `team`/`restricted`/`agent` visibility, `Owner`/`Agent` ACL bindings, `version` int, Team Admin roles — per `wayfinder/map.md:37` out of scope (team is one). Revisit only if multi-tenant graduates.
- **Why lite not minimal:** Minimal (`importance`+`is_deleted` only) would overload `importance` for “keep but hide”; `status=archived` is explicit, `pin` solves same-trigger race without bumping `importance` to 1. `007` sync’s “no status” is superseded here — 007 counted `ready` only, this adds governance.
- **Status:** **Closed** — unblocks `010` schema task (now `blockedBy [001,003,005,008]` all satisfied). Migration sketch handed to `010`.

