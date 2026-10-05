---
title: "ADR-0006: Governance-lite — status/pin/visibility (lite)"
slug: 0006-governance-lite-status-pin-visibility
source: "docs\adr\0006-governance-lite-status-pin-visibility.md"
links: []
---

# ADR-0006: Governance-lite — status/pin/visibility (lite)

- **Status:** Accepted (ticket 008, 2026-08-31) — Lite over Minimal
- **Options:** Minimal (`is_deleted`+`supersedesId`+`importance` only) vs **Lite (`visibility` always `private` + `status` active|archived|draft + `pin` 0/1)** (chosen).
- **Why lite:** Single owner still needs explicit hide (`archived` vs soft-delete) and deterministic winner for same `scope:scenario:*` trigger — `importance` overloads ranking, `pin` is explicit. `visibility='private'` keeps Tencent header parity without ACL (`team`/`restricted`/`agent` out of scope per wayfinder/map.md:37).
- **Schema:** Additive to `src/core/store/sqlite.ts:30`:
  ```sql
  ALTER TABLE memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility='private');
  ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','draft'));
  ALTER TABLE memories ADD COLUMN pin INTEGER NOT NULL DEFAULT 0;
  ```
  `version` stays via `supersedesId` chain + git sha for `./wiki/*.md`.
- **Retrieval:** `vectorSearch` filters `status='active'` by default (`pin` boosts `HybridRetriever` score or forces keep); `archived`/`draft` excluded unless `includeArchived`/`includeDraft`. `HybridRetriever` `src/core/retrieval/hybrid.ts:14` unchanged except pin weight.
- **UI:** Filter `status`, badge `private`, pin toggle in detail drawer `src/ui/app.js`.
- **Out of scope:** `team`/`restricted`/`agent`, `Owner`/`Agent` ACL, `version` int, roles — solo is one.


> Source: docs\adr\0006-governance-lite-status-pin-visibility.md
