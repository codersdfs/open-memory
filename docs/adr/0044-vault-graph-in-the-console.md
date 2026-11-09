# ADR-0044: The vault graph moves into the console

- **Status:** Accepted (2026-11-07) — the user's verdict on D9 ("framed, not ported") was that the wiki graph "doesn't work and the interactive experience is bad". Both halves were the iframe's fault, so the fix is the port D9 avoided.
- **What was actually broken:** nothing on the wire — `/graph`, `/positions` and the static page all answered. The failure was experience: the layout centred on a hardcoded (200,200) while the canvas was viewport-sized, so a small vault read as "three dots lost in a corner"; zoom scaled about the viewport origin, so two scrolls lost the graph (no fit, no reset); `pointer capture` on the svg retargeted clicks, and the redraw was a full `innerHTML` rebuild per pointermove; a node drag POSTed *every* node's position; and the panel was mostly a plea to click a node.
- **The port:** same force layout (O(n²) repulsion + edge springs + gravity, early-exit when movement stalls) and the same authoring rules, now in `ui/src/views/Graph.tsx` against the console's own tokens — no second palette, no `postMessage` theme bridge, no double chrome. `src/ui/graph.html` stays as the standalone page (same data, still shipped); the console no longer iframes it.
- **Interaction contract, now explicit:** wheel zooms about the cursor; drag-empty = pan, tap-node = select, drag-node = move; `fit` centres the visible graph (run on load and on resize), `reset` returns to k=1; hover dims everything unconnected; the panel lists in/out edges as clickable links, tags, and a section outline via `GET /knowledge/:id`; `tag:`/`path:`/substring filters and the local-depth walk are unchanged in semantics.
- **Persistence is per-node:** a drag ends in exactly one `POST /positions` for the node that moved, only when it actually moved past 3 px — a tap never writes. The write remains authoring state in `<vault>/.positions.json`, never the store (D-geometry of ADR-0017 territory untouched).

## Consequences

- `lib/api.ts` gains `graph()`, `positions()`, `savePosition()`, `knowledgePage()` with wire citations; `Graph.tsx` is self-contained React (no new deps, no CSS keyframes).
- The iframe-era theme handshake is gone: the graph re-derives its group hues from `useTheme` directly.
- D9 is superseded for the console surface; the standalone page remains the escape hatch and keeps its own inline tokens.
