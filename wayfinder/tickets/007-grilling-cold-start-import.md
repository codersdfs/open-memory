---
title: "Cold-start: import codebase + docs + chats into 4 assets in one command?"
label: wayfinder:grilling
type: grilling
HITL: true
blockedBy: [001, 004, 005, 006]
blocks: []
---

## Question

Tencent's cold-start motto: "Load the save file, then get to work" — import codebases → CodeGraph, docs → Wiki, past chats → Skills/Chat Memory, then `ready`. For solo, what is the **one command** and what does it guarantee? `npm run import ./my-repo ./docs ./chats.json` → async Wiki/CodeGraph with `ready` status in inspector? What order, what budget, what failure mode (partial ready)?

**Grill:**
- What does "ready" mean per asset for solo (Wiki pages indexed, CodeGraph symbols counted, Skills extracted 0..N)?
- Scenario: Fresh laptop, clone repo, `cp .env.example .env` → `npm run cold-start` → open `http://localhost:3000` — what do you see that proves cold-start worked?
- Cross-check `scripts/seed.ts:1` (current seed) vs desired import.

**Resolution = decision:** CLI shape, asset `status` enum, async pipeline vs sync, and inspector "Knowledge Workshop" minimal view.

---

## Resolution (2026-08-31) — **Sync minimal (no async status)**

- **Picked sync** (`idk → sync`): One blocking command, not Tencent async workshop. Reason: solo cost 20% — `codegraph init` 292 ms for 28 files (0.75 MB, 268 nodes/622 edges) + Wiki 1 embed/page (003 hybrid) + Chat bulk save (seed 8 rows) — all <5 s, no worker queue, no polling. Async badge graduates only if monorepo >10k files.
- **Scope (3 assets, not 4):** Chat Memory (chats → `episodic`+`semantic` tags `scope:scenario:*` per 001), Wiki (docs → `./wiki/*.md` + `semantic scope:wiki` per 003, frontmatter `links`), CodeGraph (codebase → `.codegraph/` reuse per 005). Skill deferred per 006.
- **CLI shape:**
  ```
  npm run cold-start -- [path] [--code ./my-repo --wiki ./docs --chats ./chats.jsonl]
  # defaults: --code .  (runs codegraph init . if missing, else codegraph sync)
  #           --wiki ./docs  (each .md → ./wiki/<slug>.md + memories row tags scope:wiki)
  #           --chats ./chats.jsonl  (each line {type,text,importance,tags} → memory.save)
  # prints: cold-started 12 memories (default:default), 3 wiki pages, 268 code nodes (or errors per asset)
  # partial failure: exit 0 + report "wiki: 2 ok, 1 failed: EACCES" — no rollback, solo re-runs flagged file
  ```
  Implemented as `scripts/cold-start.ts` (wraps `src/core/memoryService.ts:1` + `codegraph` CLI + wiki ingester). Existing `scripts/seed.ts:1` stays demo seed; cold-start reuses its `svc.save` loop.
- **What `ready` means (solo):** All sync — `ready` = command exited + files exist + rows counted. No `status` enum, no async column. Future graduation adds `status: ready|processing` only if async needed.
- **Proof on fresh laptop** (`cp .env.example .env && npm run cold-start && npm run dev` → `http://localhost:3000`): header `N memories · 2048d · default:default` (`src/ui/app.js:42` stats), Wiki prototype tab shows 3 cards with `↗ pills` + `source: raw/...`, CodeGraph status line `Files: 28 Nodes: 268` (from `codegraph status` — to be added as footer stat). All visible, no `processing` badge.
- **Status:** **Closed** — unblocks none (terminal). Next: `008` governance-lite can now add `status` only if async graduates; `010` schema task confirms no new CodeGraph/Wiki pages tables (reuse per 003/005), only optional `./wiki/*.md` files.

