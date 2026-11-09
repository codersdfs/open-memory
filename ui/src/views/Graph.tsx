import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { GraphData, GraphNode, KnowledgePageView } from '../lib/api';
import { useTheme } from '../theme';
import { Empty } from '../components/Empty';
import { IconSearch } from '../components/Icons';

/**
 * ADR-0044 — the vault graph, in the console.
 *
 * It used to be an iframe over `src/ui/graph.html` (D9, "framed, not ported"); the seam
 * cost more than the port: a second token set to keep in step, a theme bridge, double
 * chrome — and interactions that ignored the viewport (zoom was about the origin, so two
 * scrolls lost the graph; the layout centred on a hardcoded 200,200; a drag posted every
 * node's position). This view is the same force layout and the same authoring rules —
 * positions persist to `<vault>/.positions.json` via POST /positions, one POST per drag —
 * with the interactions fixed: zoom to cursor, fit, hover highlight, a panel that shows
 * the node's edges (clickable), tag:/path:/substring filtering and local depth.
 *
 * Read-only over the vault, same as the iframe was: the only write is authoring state.
 */

interface Pt {
  x: number;
  y: number;
}

const ZOOM_MIN = 0.15;
const ZOOM_MAX = 4;
const TICKS = 300;

/** Folder hue, hand-set overrides in localStorage "graph.colors". Hue degrees, not hexes:
 *  a hex would only be legible on the theme it was picked on. */
const PRESETS: readonly (number | null)[] = [null, 232, 160, 0, 45, 292, 199];
function colorMap(): Record<string, number | null> {
  try {
    return JSON.parse(localStorage.getItem('graph.colors') ?? '{}') as Record<string, number | null>;
  } catch {
    return {};
  }
}
function hueOf(key: string): number {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
const groupOf = (n: GraphNode) => (n.folder !== '' ? `folder:${n.folder}` : 'root');

export default function GraphView({ namespace: _namespace }: { namespace: string }) {
  const { resolved } = useTheme();
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [localMode, setLocalMode] = useState(false);
  const [depth, setDepth] = useState(1);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [page, setPage] = useState<KnowledgePageView | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [, bump] = useState(0); // position edits re-render the SVG without touching `data`

  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const posRef = useRef<Map<string, Pt>>(new Map());
  const viewRef = useRef<Pt & { k: number }>({ x: 0, y: 0, k: 1 });
  const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const dragRef = useRef<
    { kind: 'node'; id: string; dx: number; dy: number; px: number; py: number; moved: boolean } | { kind: 'pan'; px: number; py: number; moved: boolean } | null
  >(null);

  // Group hues re-derive per theme: the same hue reads differently on graphite vs paper.
  const sat = resolved === 'dark' ? '50%' : '46%';
  const lig = resolved === 'dark' ? '60%' : '40%';

  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    if (data === null) return m;
    for (const n of data.nodes) m.set(n.id, new Set());
    for (const e of data.edges) {
      m.get(e.from)?.add(e.to);
      m.get(e.to)?.add(e.from);
    }
    return m;
  }, [data]);

  /** The visible set: filter tokens (AND), then the local walk around the focused node. */
  const visible = useMemo(() => {
    if (data === null) return new Set<string>();
    const q = filter.trim().toLowerCase();
    const ok = data.nodes.filter((n) => {
      if (q === '') return true;
      return q.split(/\s+/).every((tok) => {
        if (tok.startsWith('tag:')) return n.tags.some((t) => t.toLowerCase().includes(tok.slice(4)));
        if (tok.startsWith('path:')) return `${n.folder}/${n.id}`.toLowerCase().includes(tok.slice(5));
        return `${n.id} ${n.title}`.toLowerCase().includes(tok);
      });
    });
    let ids = ok.map((n) => n.id);
    if (localMode && focusId !== null && ids.includes(focusId)) {
      const seen = new Set([focusId]);
      let frontier = [focusId];
      for (let d = 0; d < depth; d++) {
        const next: string[] = [];
        for (const cur of frontier) {
          for (const nb of adj.get(cur) ?? []) {
            if (!seen.has(nb)) {
              seen.add(nb);
              next.push(nb);
            }
          }
        }
        frontier = next;
      }
      ids = ids.filter((id) => seen.has(id));
    }
    return new Set(ids);
  }, [data, filter, localMode, focusId, depth, adj]);

  const shownEdges = useMemo(
    () => (data === null ? [] : data.edges.filter((e) => visible.has(e.from) && visible.has(e.to))),
    [data, visible],
  );

  const applyTransform = useCallback(() => {
    const g = gRef.current;
    const v = viewRef.current;
    if (g !== null) g.setAttribute('transform', `translate(${v.x},${v.y}) scale(${v.k})`);
  }, []);

  /** Centre the visible graph in the viewport — the fix for "three dots lost in a corner". */
  const fit = useCallback(() => {
    const { w, h } = sizeRef.current;
    if (w === 0 || h === 0 || posRef.current.size === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of posRef.current.values()) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const bw = Math.max(maxX - minX, 1);
    const bh = Math.max(maxY - minY, 1);
    const k = Math.min(Math.min((w - 80) / bw, (h - 80) / bh), 1.8);
    viewRef.current = {
      k,
      x: (w - k * (minX + maxX)) / 2,
      y: (h - k * (minY + maxY)) / 2,
    };
    applyTransform();
  }, [applyTransform]);

  const layout = useCallback(() => {
    const nodes = data?.nodes ?? [];
    if (nodes.length === 0) return;
    const { w, h } = sizeRef.current;
    const cx = Math.max(w / 2, 300);
    const cy = Math.max(h / 2, 220);
    nodes.forEach((n, i) => {
      if (!posRef.current.has(n.id)) {
        const a = (i / nodes.length) * Math.PI * 2;
        posRef.current.set(n.id, { x: cx + Math.cos(a) * 150, y: cy + Math.sin(a) * 150 });
      }
    });
    const linked = (a: string, b: string) => adj.get(a)?.has(b) ?? false;
    const p = new Map<string, Pt>();
    for (let t = 0; t < TICKS; t++) {
      p.clear();
      for (const n of nodes) p.set(n.id, { ...(posRef.current.get(n.id) as Pt) });
      let moved = 0;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]!.id, b = nodes[j]!.id;
          if (linked(a, b)) continue;
          const A = p.get(a) as Pt, B = p.get(b) as Pt;
          let dx = A.x - B.x, dy = A.y - B.y;
          const d2 = Math.max(dx * dx + dy * dy, 100);
          const d = Math.sqrt(d2);
          const f = 9000 / d2;
          dx /= d; dy /= d;
          A.x += dx * f; A.y += dy * f; B.x -= dx * f; B.y -= dy * f;
          moved += f;
        }
      }
      for (const e of data?.edges ?? []) {
        const A = p.get(e.from), B = p.get(e.to);
        if (A === undefined || B === undefined) continue;
        const dx = B.x - A.x, dy = B.y - A.y;
        const d = Math.max(Math.hypot(dx, dy), 1);
        const f = (d - 110) * 0.05;
        A.x += (dx / d) * f; A.y += (dy / d) * f; B.x -= (dx / d) * f; B.y -= (dy / d) * f;
        moved += Math.abs(f);
      }
      for (const n of nodes) {
        const pt = p.get(n.id) as Pt;
        pt.x += (cx - pt.x) * 0.02;
        pt.y += (cy - pt.y) * 0.02;
        posRef.current.set(n.id, pt);
      }
      if (moved < 0.4) break;
    }
    bump((n) => n + 1);
    fit();
  }, [data, adj, fit]);

  // Load graph + authored positions together, then lay out against the measured stage.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    Promise.all([api.graph().catch((e: unknown) => { throw e; }), api.positions().catch(() => ({}))])
      .then(([g, positions]) => {
        if (!live) return;
        setData(g);
        posRef.current = new Map(Object.entries(positions ?? {}));
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (data !== null && sizeRef.current.w > 0) layout();
    // Layout runs once per dataset (and once the stage is measurable); drags own positions after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, sizeRef.current.w, sizeRef.current.h]);

  // Stage measurement + refit.
  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      const first = sizeRef.current.w === 0;
      sizeRef.current = { w: r.width, h: r.height };
      if (first) layout();
      else fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout, fit]);

  // Wheel zoom must be non-passive to preventDefault; and it must zoom about the cursor —
  // the iframe version zoomed about the origin, which is how a graph got lost in two scrolls.
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = svg.getBoundingClientRect();
      const cx = ev.clientX - r.left;
      const cy = ev.clientY - r.top;
      const v = viewRef.current;
      const f = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.k * f));
      const real = k / v.k;
      viewRef.current = { k, x: cx - (cx - v.x) * real, y: cy - (cy - v.y) * real };
      applyTransform();
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [applyTransform]);

  const nodeById = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of data?.nodes ?? []) m.set(n.id, n);
    return m;
  }, [data]);

  const select = useCallback((id: string | null) => {
    setFocusId(id);
    setPage(null);
    if (id !== null && (nodeById.get(id)?.file ?? '') === '') {
      // Dangling node — nothing on disk to read, but the panel still shows its edges.
    }
  }, [nodeById]);

  function readPage(id: string): void {
    setPageLoading(true);
    api
      .knowledgePage(id)
      .then((p) => setPage(p))
      .catch(() => setPage(null))
      .finally(() => setPageLoading(false));
  }

  function onPointerDown(ev: React.PointerEvent<SVGSVGElement>): void {
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const target = ev.target as Element;
    const circle = target.closest('circle[data-id]');
    const id = circle?.getAttribute('data-id') ?? null;
    const v = viewRef.current;
    if (id !== null) {
      const p = posRef.current.get(id);
      if (p === undefined) return;
      dragRef.current = {
        kind: 'node',
        id,
        dx: (ev.clientX - rect.left - v.x) / v.k - p.x,
        dy: (ev.clientY - rect.top - v.y) / v.k - p.y,
        px: ev.clientX,
        py: ev.clientY,
        moved: false,
      };
    } else {
      dragRef.current = { kind: 'pan', px: ev.clientX, py: ev.clientY, moved: false };
    }
    svgRef.current?.setPointerCapture(ev.pointerId);
  }

  function onPointerMove(ev: React.PointerEvent<SVGSVGElement>): void {
    const drag = dragRef.current;
    if (drag === null) return;
    // A tap selects; only movement past 3px counts as a drag — pointer capture retargets
    // the browser's click, so selection has to ride the pointer events themselves.
    if (drag.kind === 'node' && !drag.moved) {
      const dxTotal = ev.clientX - drag.px;
      const dyTotal = ev.clientY - drag.py;
      if (dxTotal * dxTotal + dyTotal * dyTotal > 9) drag.moved = true;
    } else if (drag.kind === 'pan') {
      const dxTotal = ev.clientX - drag.px;
      const dyTotal = ev.clientY - drag.py;
      if (dxTotal * dxTotal + dyTotal * dyTotal > 9) drag.moved = true;
    }
    if (drag.kind === 'pan') {
      if (!drag.moved) return;
      viewRef.current = {
        ...viewRef.current,
        x: viewRef.current.x + (ev.clientX - drag.px),
        y: viewRef.current.y + (ev.clientY - drag.py),
      };
      drag.px = ev.clientX;
      drag.py = ev.clientY;
      applyTransform();
      return;
    }
    if (!drag.moved) return;
    const rect = svgRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    if (rect === undefined) return;
    posRef.current.set(drag.id, {
      x: (ev.clientX - rect.left - v.x) / v.k - drag.dx,
      y: (ev.clientY - rect.top - v.y) / v.k - drag.dy,
    });
    bump((n) => n + 1);
  }

  function onPointerUp(): void {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag === null) return;
    // Tap (no movement) = select. Drag = persist, one POST for the one node that moved —
    // the iframe version re-posted every node on every drag.
    if (drag.kind === 'node') {
      if (!drag.moved) {
        select(drag.id);
        return;
      }
      const p = posRef.current.get(drag.id);
      if (p !== undefined) void api.savePosition(drag.id, p.x, p.y).catch(() => {});
    }
  }

  if (loading) {
    return (
      <div className="card" style={{ padding: 28, textAlign: 'center', fontSize: 13, color: 'var(--dim)' }}>
        reading vault…
      </div>
    );
  }
  if (error !== null) {
    return (
      <div role="alert" className="mono" style={{ fontSize: 12, color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>
        {error}
      </div>
    );
  }
  if (data === null || data.nodes.length === 0) {
    return <Empty title="the vault holds no pages" body="write markdown into vault/ (links [[like this]] become edges), then reload." />;
  }

  const focus = focusId !== null ? (nodeById.get(focusId) ?? null) : null;
  const near = hoverId !== null ? new Set([hoverId, ...(adj.get(hoverId) ?? [])]) : null;
  const groups = new Map<string, number>();
  for (const n of data.nodes) if (visible.has(n.id)) groups.set(groupOf(n), (groups.get(groupOf(n)) ?? 0) + 1);
  const colors = colorMap();
  const groupColor = (key: string) => {
    const custom = colors[key];
    const hue = typeof custom === 'number' ? custom : hueOf(key);
    return `hsl(${hue} ${sat} ${lig})`;
  };
  const showLabels = visible.size <= 80 || hoverId !== null || focusId !== null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: 'calc(100vh - 240px)', minHeight: 480 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Graph</div>
          <div className="mono" style={{ marginTop: 3, fontSize: 11, color: 'var(--faint)' }}>
            vault/ links, read-only · drag a node to author its place · one POST per drag
          </div>
        </div>
        <span className="spacer" style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={fit}>fit</button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            viewRef.current = { x: 0, y: 0, k: 1 };
            applyTransform();
          }}
        >
          reset
        </button>
        <a className="btn" href="graph.html" target="_blank" rel="noreferrer" title="the standalone page, same data">
          standalone
        </a>
      </div>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div className="search-hero" style={{ height: 32, borderRadius: 'var(--radius-sm)', flex: '0 1 280px' }}>
          <IconSearch size={13} />
          <input
            value={filter}
            spellCheck={false}
            aria-label="Filter nodes"
            placeholder="tag:x · path:x · substring"
            onChange={(e) => setFilter(e.currentTarget.value)}
          />
        </div>
        <button
          type="button"
          className="pill"
          aria-pressed={localMode}
          onClick={() => setLocalMode(!localMode)}
          title="show only the focused node's neighbourhood"
        >
          local
        </button>
        <label className="row" style={{ gap: 6, fontSize: 11, color: 'var(--dim)' }}>
          depth
          <input
            type="range"
            min={1}
            max={3}
            value={depth}
            disabled={!localMode}
            onChange={(e) => setDepth(Number(e.currentTarget.value))}
            style={{ width: 80, accentColor: 'var(--accent)' }}
          />
        </label>
        <span className="legend">
          <span>
            {visible.size}/{data.nodes.length} nodes · {shownEdges.length} edges
          </span>
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {[...groups.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => (
            <button
              key={key}
              type="button"
              className="chip"
              style={{ cursor: 'pointer' }}
              title="click to recolour this group"
              onClick={() => {
                const map = colorMap();
                const next = PRESETS[(PRESETS.indexOf(map[key] ?? null) + 1) % PRESETS.length];
                if (next === null || next === undefined) delete map[key];
                else map[key] = next;
                localStorage.setItem('graph.colors', JSON.stringify(map));
                bump((n) => n + 1);
              }}
            >
              <span className="tdot" style={{ background: groupColor(key) }} aria-hidden="true" />
              {key.replace(/^(folder|tag):/, '')} {count}
            </button>
          ))}
        </div>
      </div>

      <div ref={wrapRef} style={{ flex: '1 1 auto', minHeight: 0, display: 'grid', gridTemplateColumns: '1fr 300px', border: '1px solid var(--hairline)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
        <svg
          ref={svgRef}
          role="img"
          aria-label="Vault link graph"
          style={{ display: 'block', width: '100%', height: '100%', background: 'var(--bg)', cursor: 'grab', touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => {
            dragRef.current = null;
            setHoverId(null);
          }}
        >
          <g ref={gRef}>
            {shownEdges.map((e, i) => {
              const a = posRef.current.get(e.from);
              const b = posRef.current.get(e.to);
              if (a === undefined || b === undefined) return null;
              const hot = near !== null && near.has(e.from) && near.has(e.to);
              const mutual = e.mutual;
              return (
                <line
                  key={`${e.from}->${e.to}:${i}`}
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={hot || mutual ? 'var(--fg)' : 'var(--hairline-strong)'}
                  strokeWidth={hot ? 1.8 : mutual ? 1.4 : 1}
                  opacity={near !== null && !hot ? 0.12 : mutual ? 0.7 : 0.5}
                />
              );
            })}
            {data.nodes.map((n) => {
              if (!visible.has(n.id)) return null;
              const p = posRef.current.get(n.id);
              if (p === undefined) return null;
              const dim = near !== null && !near.has(n.id);
              const col = groupColor(groupOf(n));
              const r = 5 + Math.min(n.deg, 6) + (n.id === focusId ? 2 : 0);
              const hot = n.id === focusId || n.id === hoverId || (near !== null && near.has(n.id));
              const label = dim ? null : showLabels || hot ? n.title : null;
              return (
                <g key={n.id}>
                  <circle
                    data-id={n.id}
                    cx={p.x} cy={p.y} r={r}
                    fill={n.dangling ? 'var(--bg)' : col}
                    stroke={col}
                    strokeWidth={n.id === focusId ? 2.5 : 1.4}
                    strokeDasharray={n.dangling ? '2 2' : undefined}
                    opacity={dim ? 0.18 : 1}
                    style={{ cursor: 'pointer' }}
                    onPointerEnter={() => setHoverId(n.id)}
                  />
                  {label !== null ? (
                    <text
                      x={p.x + r + 4}
                      y={p.y + 3.5}
                      opacity={n.dangling ? 0.55 : 0.9}
                      style={{ fontSize: 10, fill: 'var(--dim)', pointerEvents: 'none', userSelect: 'none' }}
                    >
                      {n.title}
                      {n.dangling ? ' ?' : ''}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>

        <aside style={{ borderLeft: '1px solid var(--hairline)', background: 'var(--panel)', padding: 14, overflow: 'auto', minWidth: 0 }}>
          {focus === null ? (
            <div style={{ fontSize: 12, color: 'var(--faint)', lineHeight: 1.7 }}>
              click a node to inspect it — its links are listed and clickable, and the
              {' '}<span className="mono">local</span> toggle walks depth from here.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>{focus.title}</div>
                <div className="legend" style={{ marginTop: 4 }}>
                  <span>{focus.file === '' ? 'dangling target' : focus.file}</span>
                  <span>deg {focus.deg}</span>
                  {focus.folder !== '' ? <span>{focus.folder}</span> : null}
                </div>
              </div>
              {focus.tags.length > 0 ? (
                <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                  {focus.tags.slice(0, 8).map((t) => (
                    <span key={t} className="chip">{t}</span>
                  ))}
                </div>
              ) : null}
              <EdgeList caption="out" ids={(data?.edges ?? []).filter((e) => e.from === focus.id).map((e) => e.to)} onPick={select} />
              <EdgeList caption="in" ids={(data?.edges ?? []).filter((e) => e.to === focus.id).map((e) => e.from)} onPick={select} />
              <button type="button" className="ghost" style={{ alignSelf: 'flex-start' }} onClick={() => readPage(focus.id)}>
                {pageLoading ? 'reading…' : 'section outline →'}
              </button>
              {page !== null && page.id === focus.id ? (
                page.sections.length === 0 ? (
                  <div className="legend"><span>no headings — sync knowledge after editing the file</span></div>
                ) : (
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {page.sections.map((s) => (
                      <li key={s.key} className="mono" style={{ fontSize: 11, color: 'var(--dim)', overflowWrap: 'anywhere' }}>
                        {s.heading} <span style={{ color: 'var(--faint)' }}>· {s.chars}c</span>
                      </li>
                    ))}
                  </ul>
                )
              ) : null}
              <button type="button" className="ghost" style={{ alignSelf: 'flex-start' }} onClick={() => select(null)}>
                clear focus
              </button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function EdgeList({ caption, ids, onPick }: { caption: string; ids: string[]; onPick: (id: string) => void }) {
  return (
    <div>
      <div className="legend" style={{ marginBottom: 4 }}>
        <span>{caption}</span>
      </div>
      {ids.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--faint)' }}>none</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {ids.map((id) => (
            <button key={id} type="button" className="ghost" style={{ justifyContent: 'flex-start', fontSize: 11, overflowWrap: 'anywhere' }} onClick={() => onPick(id)}>
              {id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
