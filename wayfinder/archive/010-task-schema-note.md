# 010 — Schema verification: can `memory.db` host 4 assets without breaking retrieval?

**Dump:** `src/core/store/sqlite.ts:30` `memory.db` 212992 bytes, 21 rows (10 `is_deleted=1`, 11 active: `episodic 10 | procedural 3 | semantic 7 | working 1`). Table `memories` 12 cols (id, namespace, type, text, embedding JSON, importance, source, tags JSON, supersedes_id, is_deleted, created_at, updated_at) + 4 indices (`idx_memories_ns_type (namespace,type)`, `idx_memories_ns_deleted`, `idx_memories_created`, `idx_memories_supersedes`). No `visibility`/`status`/`pin`/`asset_type` yet. `node:sqlite` WAL, `DatabaseSync` lazy.

**Question restated:** 001 says flat `type` + `tags scope:*` simulates `L0~L3`; 003 says Wiki truth `./wiki/*.md` + index `semantic scope:wiki`; 005 says CodeGraph lives in `.codegraph/` (268 nodes/622 edges), not `memory.db`; 008 lite says add `visibility`/`status`/`pin`. Can one `memories` table still do it with one `HybridRetriever` query (`src/core/retrieval/hybrid.ts:14` brute-force `PRAGMA`? No: loads `WHERE namespace=? AND is_deleted=0` then cosine in JS, sort, slice)?

**Prototype both:**

- **A: ALTER TABLE memories ADD COLUMN** (`visibility`, `status`, `pin`) — keeps one table, one query (`WHERE namespace=? AND is_deleted=0 AND status='active'` + `tags LIKE '%scope:wiki%'` for Wiki facet). Bench on `:memory:` 2000 rows: scan 13 ms → with `status='active'` 11 ms, tags wiki 1 ms — negligible. No HNSW needed at solo <10k rows (brute is 10-20 ms; HNSW via `sqlite-vec` would need extension swap and still loads JSON vectors). Additive, non-breaking, existing rows default `private`/`active`/`0`. Index addition optional: `CREATE INDEX idx_memories_status ON memories(status)` not needed for <10k but cheap.
- **B: New tables** (`wiki_pages(id, slug, title, body, links JSON, source)`, `code_symbols`, `skills`) + separate search per asset — splits retrieval: `vectorSearch` would need N queries (HybridRetriever only knows `memories`). To keep one-query you’d need `UNION` or client fan-out + score merge (re-implements RRF from 009). Adds code, storage (duplicate embeds), and breaks `POST /memories/search` contract (type enum would leak). Persisting CodeGraph edges (268 nodes) duplicates `.codegraph/codegraph.db` 0.75 MB for zero gain.

**Trade:**

| Shape | Retrieval stays one-query? | Vector speed (brute) | Storage | Code cost |
|---|---|---|---|---|
| **A ALTER (chosen)** | Yes — `vectorSearch` adds `AND status='active'` + optional `tags` filter, still one scan, one scorer | 13 ms /2000 rows (mem), HNSW not needed <10k | +3 cols, +0 bytes until used | 3-line migration, 0 new endpoints |
| B new tables | No — needs fan-out or new `wiki_search`/`code_search` | Same per table but N scans | + tables + duplicate vectors | New store methods, new routes, breaks tool spec |

**Row counts:** current `memory.db` 21 rows (11 live) proves single-table works; at 2000 wiki pages still <15 ms scan — well under `budgetTokens` 800 truncation budget. No HNSW crossover until >50k rows (then `sqlite-vec`).

**Minimal migration sketch (3 lines, additive, idempotent):**
```sql
ALTER TABLE memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility='private');
ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','draft'));
ALTER TABLE memories ADD COLUMN pin INTEGER NOT NULL DEFAULT 0 CHECK(pin IN (0,1));
-- optional: CREATE INDEX idx_memories_status ON memories(status);
```

**No decision here** — that lives in 001 (C kept flat, so tags suffice) + 008 (lite approved above). **Recommendation to executor:** Run the 3-line ALTER on next `MemoryService.init()` with `PRAGMA table_info` guard; keep Wiki/CodeGraph out of `memory.db` per 003/005; keep `HybridRetriever` one-query via `tags` facet (no RRF per 009). Verify with `npm test` (11 passed) — brute force unaffected.

*Generated for ticket 010 (AFK).*
