---
title: "Wiki ingestion: Karpathy LLM-Wiki vs flat chunk RAG for solo docs?"
label: wayfinder:research
type: research
HITL: false
blockedBy: []
blocks: [004]
---

## Question

Tencent Wiki turns product docs/specs/runbooks into structured Wiki pages with a link graph (Karpathy's LLM knowledge base). Is that incremental link-graph worth the pipeline for solo, or is chunk-then-retrieve (embed doc chunks, BM25) enough for 80% value? What do we actually need to build: doc watcher + chunker, or page writer + graph updater + `ready` status?

**Research via subagent:**
- Karpathy gist `442a6bf555914893e9891c11519de94f` (incremental LLM-Wiki)
- Tencent Wiki async pipeline (processing status, link graph)
- Our `src/core/store/` + `src/ui/` — where would Wiki pages live (new `wiki_pages` table vs reuse `memories` with `type=semantic`?)

**Deliver:** Options table with solo cost (code, tokens, storage) vs retrieval quality, and a recommended page shape `{title, body, links[], source}` + ingestion trigger (import vs watch).

---

## Research (2026-08-31)

Sources: Karpathy gist `llm-wiki.md` (`https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f` raw: three layers *Raw sources → wiki → schema*, ingest touches 10-15 pages + `index.md` catalog + `log.md` + lint for contradictions/orphans, `qmd` hybrid BM25/vector at scale), Tencent README (Wiki async, `ready` status, link graph, on-demand `tools/call` not injection, inspired by Karpathy), our `src/core/store/sqlite.ts:30` (`memories` single table, no `wiki_pages`) + `src/ui/` + `HybridRetriever` one flat query.

### Options — solo cost vs quality

| Option | What you build | Solo code + tokens + storage | Retrieval quality | When it shines / fails |
|---|---|---|---|---|
| **A Full LLM-Wiki** (Karpathy faithful) | LLM owns `./wiki/*.md` + `index.md` + `log.md` + `schema` (`AGENTS.md`). Every `ingest source` → LLM reads source, writes summary, updates 10-15 entity/concept pages, cross-refs `[[links]]`, flags contradictions, lint orphans. Async `ready` per page. | **Cost:** High. Needs LLM on ingest (many calls, 10-15 file edits per source), schema co-evolution, `qmd` or `HybridRetriever` over wiki. Storage: git-tracked markdown (cheap). **Tokens:** `N sources × 15 pages × ~1k` on ingest — not in hot path but heavy on setup. | **Quality:** Highest synthesis. Wiki pre-compiles answers: contradictions flagged, cross-refs present, `index.md` gives LLM quick nav. Graph view in Obsidian. Queries read `index.md` then drill — beats per-query RAG for multi-doc synthesis. | **Solo:** Overkill for <20 docs. Worth it if you accumulate research over months (personal second brain). Risk: you pay maintenance tax you said you want to avoid. |
| **B Flat chunk RAG** (upload → embed chunks) | Split each doc into 500-token chunks, embed each, store as `semantic` rows (`tags: ["scope:wiki","source:<file>"]`), retrieve by `HybridRetriever`. No pages, no graph. | **Cost:** Low code (chunker + embed), **tokens:** `N chunks × 1 embed` on ingest, no LLM synthesis. Storage: rows in `memory.db` (`embedding TEXT JSON`, `idx_memories_ns_type`). | **Quality:** Low synthesis. Every query re-discovers fragments (Token/Context Burning), no link graph, no contradiction tracking. Works for “find this paragraph” but fails for “synthesize 5 docs”. Tencent explicitly critiques this as “△ Chunk retrieval”. | **Solo 80% for docs-as-lookup, 20% for synthesis.** Good if docs are reference manuals you rarely cross-reference. |
| **C Hybrid structured pages (recommended)** | **Disk:** `./wiki/*.md` (markdown, git) + **Index:** each page also indexed as `semantic` (`tags: ["scope:wiki","wiki:<slug>"]`, `source: raw/<file>`). Ingest = heuristic—if LLM key present, LLM writes/updates 1 page per source + 2-3 link updates; else naive: `title = filename`, `body = extract headings + summary chunk`, `links = []`. Link graph = frontmatter `links: ["other-slug"]`. `index.md` generated, not LLM-authored. | **Cost:** Medium-low. No async pipeline for v1; manual `npm run wiki:ingest ./docs/foo.md`. Code: file watcher optional, frontmatter parser, one embed per page (not per chunk). **Tokens:** 1 embed per page + optional LLM synthesis (1 call) only when you opt in. No `qmd` needed — `HybridRetriever` already covers `scope:wiki`. | **Quality:** 80/20. Pages give structure + drill-down (link pills in inspector), index search via `memory_search query scope:wiki` hits pages, still inject via `tools/call` on demand (Tencent pattern). No auto-contradiction flag, but `lint` command can list orphans/missing links heuristically. Beats flat RAG without paying full LLM-Wiki tax. | **Solo sweet spot.** Cheap to start as B, graduates page-by-page to A when you add LLM. |

### Recommendation — page shape + where it lives

**Live in two places, one source of truth:**

1. **Truth = files** `./wiki/<slug>.md` (git-tracked, Obsidian-readable) — Karpathy `wiki/` layer.
2. **Index = rows** in `memories` (`type: semantic`, `tags: ["scope:wiki","wiki:<slug>"]`) — avoids new `wiki_pages` table, reuses `src/core/store/sqlite.ts:30` + `HybridRetriever` (`tags` filter cheap). Optional: `./wiki/index.md` (generated catalog, not embedded separately).

**Page shape:**

```yaml
---
title: "Auth design"          # slug: auth-design
source: "raw/docs/auth.md"    # immutable raw source
links: ["codegraph:src/auth", "scenario:auth"]  # link graph (frontmatter)
created: 2026-08-31
---
# Auth design

Body: LLM synthesis if available, else first 800 tokens + headings.

> Source: raw/docs/auth.md
```

Stored `text` in `memories` = `title + "\n" + body` (first 2k chars for embedding), `importance: 0.7`, `tags` carries `links` for facet search. Link graph rendered as clickable pills in `src/ui/` — no graph DB for v1.

**Ingestion trigger (solo v1):**

- **Manual import:** `npm run wiki:ingest ./docs/foo.md` (or `npm run seed -- --wiki ./docs`), not a watcher. Reason: explicit control, cheap, matches 001's `scope:scenario` tag convention.
- **Async `ready` deferred:** Pages are `ready` on write; no background worker for v1. Add `status` in `008` if needed.
- **Lint:** `npm run wiki:lint` → list orphans (`links` with no target), missing `index.md` entries, stale `source` mtime.

**Unblocks 004:** Prototype `004` now builds one hard-coded `wiki/auth.md` + `scope:wiki` row + inspector tab “Wiki” with link pills — no real LLM pipeline. Graduates to full A only if you demo cross-doc synthesis value.

**Status: Researched — unblocks 004.**

