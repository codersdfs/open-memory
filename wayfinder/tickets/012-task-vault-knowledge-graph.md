---
title: "Vault graph: body wikilinks, local graph, filters, colour groups"
label: wayfinder:task
type: task
HITL: false
blockedBy: []
blocks: []
---

## Question

v1 shipped (see `docs/DESIGN-node-graph.md`): `wiki/*.md` → frontmatter `links:` → `GET /graph` → force layout with pan/zoom/node-drag/position persistence. It is a real graph, but not yet a second brain: no local graph, no filter, no colour, and — measured below — **almost no edges**.

Two things block "Obsidian-like".

### 1. Edges are read from the wrong place (verified)

`parsePage()` (`src/core/graph.ts:26`) reads `links:` from frontmatter only. Probe over a 2-page vault whose body contains `[[b]]`, run with `npx tsx` and deleted afterwards:

```
BODY_WIKILINK: []  nodes=2
AFTER_ADD:     []  nodes=2      # addLink(dir,"b","a") wrote "[[a]]" into b.md body
B_MD_TAIL:     "-\n\n# b\n\n[[a]]\n"
```

So a `[[wikilink]]` written in body text — how anyone actually writes a vault — produces no edge, and `scripts/wiki-links.ts --add` appends a link the graph then cannot see. The live `wiki/` is 7 pages / 0 edges for exactly this reason. v1's acceptance test passes because it builds pages with `links:` in frontmatter: the test encodes the bug.

### 2. The view is flat

`/graph.html` renders every node, every time, in one colour. Obsidian's core loop is: click a note → see its neighbourhood; filter to what matters; colour by group.

**Task (AFK, do-not-decide):** make the graph a second brain over `vault/` markdown.

---

## Decisions

### D1 — edges: union body `[[links]]` with frontmatter `links:`

`parsePage` extracts `\[\[([^\]]+)\]\]` from the body and unions it with the frontmatter list (frontmatter stays supported — `wiki-ingest` writes it). Root fix: `--add`, hand-authored notes and re-ingest all start working, and `addLink` → `buildGraph` becomes the regression test.

### D2 — vault root: `vault/`, recursive, path-aware ids

- `vaultDir()` in `src/core/graph.ts`: `VAULT_DIR ?? WIKI_DIR ?? "vault"`. `src/api/server.ts` (`/graph`, `/positions`), `scripts/wiki-links.ts` and the default `--out` of `scripts/wiki-ingest.ts` all call it. `WIKI_DIR` keeps working — no flag day.
- `loadPages` recurses (`readdir(dir, { recursive: true })`), skips dot-dirs and `node_modules`; `id` = vault-relative path minus `.md` (`adr/0001-x`).
- Resolution: exact relative id first, then unique basename. Two files sharing a basename → the link stays dangling (documented, not guessed).
- `bare()` stops flattening ids and becomes the basename lookup key.

### D3 — node payload: folder, tags, file

`GraphNode` gains `folder` (first path segment), `tags` (frontmatter `tags:` + inline `#tag`), `file` (relative path). Same single pass over the vault, no table, no migration — `dependencies: {}` stays.

### D4 — local graph, client-side

Depth slider 1–3 plus click-to-focus. BFS lives in `graph.js`: the client already holds every node and edge, so a `/graph?depth=` endpoint would re-read the same files to answer what the browser already has. Global/local toggle returns the full set.

### D5 — filter box

One input. Tokens `tag:x`, `path:x`; anything else is a case-insensitive substring match on id/title. Non-matching nodes and their edges are hidden; positions are kept, so clearing the filter restores the layout.

### D6 — colour groups, derived

Hue = hash(folder) by default. `tag:x` overrides live in `localStorage` — UI taste, not project data. A legend lists groups with counts. No config file, no colour picker in v1.

### D7 — hover focus

Hovering a node highlights it, its neighbours and their edges; everything else fades to opacity .15 and drops its label. ~10 lines in `draw()`.

---

## Files

| file | change |
|---|---|
| `src/core/graph.ts` | body wikilinks, `vaultDir()`, recursive scan, id resolution, `folder`/`tags` on `GraphNode` (~+50 lines) |
| `src/api/server.ts` | `vaultDir()` in the two routes (2 lines) |
| `src/ui/graph.js` | local graph, filter, colour groups, hover (~+90 lines) |
| `src/ui/graph.html` | toolbar: filter input, depth slider, global/local toggle, legend (~+12 lines) |
| `scripts/wiki-links.ts` | `vaultDir()` (1 line) |
| `tests/graph.test.ts` | cases listed under Checks |

Order: D1 → D2 → D3 → D4/D5/D6/D7 → tests.

---

## Checks / Done when

- `npm test` green, with new cases: body `[[b]]` yields the edge; `addLink` then `buildGraph` yields the edge (fails today); nested `adr/x.md` gets id `adr/x`; `[[x]]` resolves across folders; an ambiguous basename stays dangling; tags parsed; `folder` = first segment.
- `npm start`, open `/graph.html`: click a node → depth 1 shows only its neighbours; `tag:wiki` filters; hover fades non-neighbours; the legend shows one group per folder.
- `VAULT_DIR=./tmp-vault npx tsx scripts/wiki-links.ts` prints the node/edge table for a nested fixture vault (no repo files touched).
- v1 behaviour kept: positions persist, zoom/pan/node-drag unchanged, `/graph` changes are additive (new fields only).

---

## Not doing

- Memory rows on the graph. Knowledge is markdown in `vault/`; `memory.db` is retrieved, not browsed.
- Note editor, markdown reader, backlinks pane (asked, not chosen this round).
- Obsidian plugin host, new dependency, framework, build step, graph table in SQLite.
- Force-layout persistence, tag/similarity edges, `--suggest` button in the UI (exists in core + CLI; wiring it is a later ticket).

---

## Risk

`id` moving from basename to path changes `.positions.json` keys. Mitigation: basename fallback keeps every existing `[[a]]` resolving, and stale position keys are ignored and re-laid-out — `wiki/.positions.json` is authoring state for a human, safe to lose.

---

## Done (2026-10-06) — D1-D7 implemented

- **core** `src/core/graph.ts`: body `[[links]]` ∪ frontmatter `links:`; `stripCode()` — code spans and fences are not links (the smoke test caught prose *documenting* `[[x]]` growing three hollow nodes); `vaultDir()`; recursive `loadPages`; path ids resolved exact-id first, then unique basename; `folder`/`tags`/`file` on nodes. Also fixed a basename-lookup bug found by the new tests.
- **wiring** `src/api/server.ts` (`/graph`, `/positions`), `scripts/wiki-links.ts`, `scripts/wiki-ingest.ts` (default `--out` = vault; skips `vault/` while collecting).
- **UI** `src/ui/graph.html` + `graph.js`: toolbar (filter, local + depth, counts, legend), client-side BFS local graph, `tag:`/`path:`/substring filter, folder colour groups with a localStorage override cycled from the legend, hover neighbour focus. Pan/zoom/node-drag/positions kept.
- **seed** `vault/{index,graph-view}.md` + `vault/adr/vault-as-knowledge-root.md`; README graph bullet corrected.
- **verified** `npm test` 201 passed (7 new graph cases); `tsc -p tsconfig.lint.json` exit 0; a real server served `/graph` with `folder`/`tags`/`file` per node and `/graph.html` 200.
- **not verified** the browser surface past HTTP 200 — no UI harness in this repo; `/graph.html` needs one manual pass (click a node → local graph, filter, legend).
