# Wayfinder Map — Solo-dev AI Memory parity with TencentDB

> Label: `wayfinder:map` · Tracker: local-markdown (`wayfinder/`). This is the index, not the store — decisions live in tickets, only gist + link here.

## Destination

**Solo-dev AI Memory that delivers 80% of TencentDB-Agent-Memory's useful value on 20% of its complexity** — a single `memory.db` (sqlite + node:sqlite) + `http://localhost:7331` + `http://localhost:3000` inspector that provides: layered Chat Memory (L0→L3), ~~a minimal Skill library~~ *(deferred per 006 → flat `procedural`)*, a Wiki for docs, and a CodeGraph-lite for code, all cold-start importable, governable (version/status), and retrievable via the existing Smart Search (hard budget) — **without** team/ACL/multi-tenant/Proxy overhead.

*Done when:* A solo dev can `npm run seed -- --import ./my-repo` (code + docs + past chats) → see 4 asset types in the inspector → `memory_search` returns layered results (L2 bootstrap, L1 fallback) within budget → `memory_save` extracts a Skill from a successful run → `autoInject` loads it next session. No second user or team needed to prove it.

## Notes

- **Domain:** AI Memory substrate (`CONTEXT.md` language: Memory, Chat Memory, Skill, Wiki, CodeGraph, Namespace, Token/Context Burning, Hard Budget). Consult `CONTEXT.md`, `docs/adr/*`, and `TencentDB-Agent-Memory` model (Chat Memory L0-L3, Skill + Wiki + CodeGraph assets, Team Memory Hub) as reference — but scope is solo.
- **Skills every session should consult:** `grill-with-docs` (+ `domain-modeling` to sharpen Skill/Wiki/CodeGraph terms), `prototype` for UI/logic artifacts, `research` for Tencent/Karpathy Wiki and CodeGraph prior art, `diagnosing-bugs` for retrieval/budget interplay.
- **Standing preferences:** Single `memory.db` file, `EMBEDDING_PROVIDER=nim` (`nvidia/nemotron-3-embed-1b` 2048d) via `.env`, explicit `memory_search` tool-first (ADR-0003), deterministic hybrid retrieval (ADR-0002), in-memory store for `vitest`. No Docker by default. Every decision must state solo-dev cost vs Tencent team cost.

## Decisions so far

- **001 C — flat 4-type + tags simulate L0-L3** — keep `episodic|semantic|procedural|working` (`CONTEXT.md`/`src/core/types.ts:1`), map `L0~=episodic`, `L1~=semantic fact`, `L2~=tags scope:scenario:*`, `L3~=tag scope:persona`; no schema change, one `HybridRetriever` call (`ADR-0005`) · [ticket 001](tickets/001-grilling-chat-memory-layers.md) · [ADR-0005](../docs/adr/0005-flat-layers-via-tags-C.md)
- **002 researched — Skill shape** — solo minimal = Hermes `SKILL.md` on disk + `procedural` index row; dropped to git/keep-merge table for 006 · [ticket 002](tickets/002-research-skill-shape.md)
- **003 researched — Wiki hybrid structured pages** — truth `./wiki/*.md` + index `semantic tags scope:wiki`, links in frontmatter, manual `wiki:ingest` (not watcher) · [ticket 003](tickets/003-research-wiki-ingestion.md)
- **004 keep graph — Wiki prototype** — 3 cards + `↗ pills` drill (`src/ui/index.html:142`/`src/ui/app.js:163`), keep graph (not flat) · [ticket 004](tickets/004-prototype-wiki-minimal.md)
- **005 researched — CodeGraph reuse** — reuse `.codegraph/` (268 nodes, 622 edges) as durable, no `code_*` tables; on-demand `codegraph_explore` (Tencent `tools/call` pattern) · [ticket 005](tickets/005-research-codegraph-lite.md)
- **006 B — defer Skill asset** — `no need skill` for solo v1; how-to stays `procedural` (`src/api/tool.ts:1`), no `skills` table, no review/binding; `002` kept as reference · [ticket 006](tickets/006-grilling-skill-solo-lifecycle.md)
- **007 sync cold-start** — one blocking `npm run cold-start [--code --wiki --chats]` (sync, no `status` enum, partial success allowed); Chat + Wiki (`./wiki/*.md` + `scope:wiki`) + CodeGraph (`.codegraph/` reuse) · [ticket 007](tickets/007-grilling-cold-start-import.md)
- **008 lite governance** — `visibility='private'` always + `status=active|archived|draft` + `pin 0/1`; version via `supersedesId` chain; `archived` excluded, `pin` boosts rank; out of scope `team`/`restricted`/ACL · [ticket 008](tickets/008-grilling-governance-lite.md) · [ADR-0006](../docs/adr/0006-governance-lite-status-pin-visibility.md)

## Not yet specified

<!-- fog of war: in-scope, dim view, not yet sharp enough to ticket. Graduates as frontier advances. -->

- *(none — all fog graduated; remaining work is implementation tickets 009/010)*

## Out of scope

<!-- ruled beyond this destination; closed, never graduates -->

- **Team/ACL/Roles** (`private`/`team`/`restricted`, System Admin vs Team Admin/Member, `agent` visibility) — team is one. Close any ticket that reintroduces multi-user ACL; reason: solo has no one to share with in this effort.
- **Multi-tenant RLS / tenant_id row isolation** (Tencent's `app.tenant_id` + `agent_id` RLS on `memory.records`) — solo uses single `namespace="default:default"`; true RLS is a later effort if multi-tenant ever needed.
- **Proxy zero-code generic interception** (point baseURL at MemoryProxy) — solo can call explicit `memory_search` tool; Proxy for all frameworks is a separate platform effort.
- **NVFP4 vs BF16 Wiki/CodeGraph hardware profiles** — solo runs on existing laptop; hardware-specific kernels are out of scope for this path.
