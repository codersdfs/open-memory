# Node graph — Obsidian-like connections in ai-memory

Status: v1 shipped — `src/core/graph.ts`, `/graph`, `/positions`, `src/ui/graph.{html,js}`. v2 (body wikilinks, `vault/` root, local graph, filters, colour groups) is planned in `wayfinder/tickets/012-task-vault-knowledge-graph.md`; that ticket supersedes the Open section below.

## Problem

wiki/*.md pages are linked with [[wikilinks]] (plus local md links).
extractLinks() already collects them and wiki-ingest already writes them into
frontmatter as links: ["a","b"]. Nothing reads that field. The connections exist
on disk and are invisible.

## Decision: read frontmatter, don't build a graph table

dependencies: {}. node:http already serves /api and src/ui. A graph table means
a migration, a write path, and an invalidation story, to re-hold data that is
already a line in a file. The wiki dir is 7 files now. Reading them at boot is
one loop.

Edges come from frontmatter links: only. Reuse extractLinks semantics. Tags and
semantic similarity are NOT edges — they would make the graph lie about intent.
Hybrid search already covers similarity.

## Data

    GET /api/graph
    -> { nodes: [{ id, title, source, deg }], edges: [{ from, to, mutual }] }

to is unresolved if no file matches (dangling [[link]]) — render it as a hollow
node. Obsidian shows these; hiding them hides the actual maintenance debt.

deg = in-degree + out-degree. mutual when both directions exist.

New endpoint, one file: src/api/server.ts + src/core/graph.ts. ~40 lines:
readdir wiki/, regex the links: frontmatter line, emit.

## Layout

Two surfaces, one node set.

### Graph view (default)
src/ui/graph.html. SVG, force layout hand-rolled: ~60 lines.
- repulsion O(n^2), 300 ticks, then stop. 7 nodes now; free until ~500.
- link = straight line, 1px, opacity .35. node = circle r = 3 + deg.
- click node -> side panel: title, source path, in/out link lists.
- click edge -> nothing. v1.

### Spatial canvas
Positions persist in wiki/.positions.json ({slug: {x,y}}).
Not in SQLite — it is authoring state for a human, not a memory.
Drag node -> write file on pointerup, debounced 500ms. Layout seeded from file,
fallback to force result.
Arrow = manual edge, stored per-node as links: so it survives and feeds the
graph view. One source of truth for edges, not two.

## Link suggestions
For node X: files sharing a tag or source path segment, excluding existing
neighbours, top 5 by shared-term count in titles. Reuse the q tokenizer in
retrieval. No model call. A button per suggestion appends [[target]] to the
source file body — a real edit, not a metadata write, so re-ingest picks it up.

## Files
- src/core/graph.ts — build graph from wiki/ dir
- src/api/server.ts — one route
- src/ui/graph.html + src/ui/graph.js + graph css
- scripts/wiki-links.ts — apply a suggestion (shared by UI and CLI)

## Not doing
- Obsidian plugin. Needs a plugin host and a second parse of the same files.
- Tag/similarity edges. Lies about intent; search already does this.
- Persisted force layout (only manual canvas positions persist).
- Graph in the memories table. The files hold it.

## Checks
    node scripts/wiki-links.ts --suggest <slug>   # prints candidates, no write
    npm test                                      # graph.test.ts: 7 nodes,
                                                  # index has 0 edges,
                                                  # dangling link survives as node

## Open
- Is wiki/ the only node set, or should docs/*.md also become nodes?
- Positions file: commit or gitignore? Repo is local-first, assume commit.
