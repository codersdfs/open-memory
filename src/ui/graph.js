const svg = document.getElementById("canvas");
const side = document.getElementById("side");
const filterEl = document.getElementById("filter");
const localEl = document.getElementById("local");
const depthEl = document.getElementById("depth");
const legendEl = document.getElementById("legend");
const countEl = document.getElementById("count");

let g = { nodes: [], edges: [] };
const pos = new Map();
const view = { x: 0, y: 0, k: 1 };
let adj = new Map();      // id -> Set of neighbours, rebuilt with the data
let visible = new Set();  // ids passing the filter (+ local depth)
let focus = null;         // clicked node, the centre of the local graph
let hover = null;
const esc = (s) => String(s).replace(/[<>&]/g, "");

// --- theme -----------------------------------------------------------------
// Every colour the canvas draws with is read from the document's variables, never
// written here; graph.html owns the two value blocks. `T` is re-read by applyTheme()
// alone, which is what the frame calls over postMessage to switch theme without a
// reload — and what a `?theme=` load has already set before this file runs.
let T = { edge: "", edgeHot: "", sat: "68%", lig: "62%" };
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  T = { edge: v("--edge"), edgeHot: v("--edge-hot"), sat: v("--node-sat"), lig: v("--node-lig") };
  drawLegend();
  draw();
}
window.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg?.type === "om-theme" && (msg.theme === "dark" || msg.theme === "light")) applyTheme(msg.theme);
});
applyTheme();

// --- positions -------------------------------------------------------------
// Positions survive reload in <vault>/.positions.json — authoring state for a
// human, so it does not belong in SQLite with the memories. Keys are node ids,
// which are vault-relative paths; a stale key is ignored, never fatal.
function loadPos() {
  fetch("/positions").then((r) => (r.ok ? r.json() : {})).then((o) => {
    for (const [k, v] of Object.entries(o)) pos.set(k, v);
    layout();
  }).catch(() => {});
}
let saveT;
function savePos() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    for (const [slug, p] of pos) {
      fetch("/positions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, x: Math.round(p.x), y: Math.round(p.y) }),
      }).catch(() => {});
    }
  }, 500);
}

// --- layout ----------------------------------------------------------------
// O(n^2) repulsion, 300 ticks then stop. ponytail: no Barnes-Hut — the vault is
// small; drop in a quadtree if it ever passes ~500 nodes.
function layout() {
  if (!g.nodes.length) return;
  g.nodes.forEach((n, i) => {
    if (!pos.has(n.id)) {
      const a = (i / g.nodes.length) * Math.PI * 2;
      pos.set(n.id, { x: 200 + Math.cos(a) * 150, y: 200 + Math.sin(a) * 150 });
    }
  });
  const linked = (a, b) => adj.get(a)?.has(b) ?? false;
  for (let t = 0; t < 300; t++) {
    const p = new Map(g.nodes.map((n) => [n.id, { ...pos.get(n.id) }]));
    for (let i = 0; i < g.nodes.length; i++)
      for (let j = i + 1; j < g.nodes.length; j++) {
        const a = g.nodes[i].id, b = g.nodes[j].id;
        if (linked(a, b)) continue;
        const A = p.get(a), B = p.get(b);
        let dx = A.x - B.x, dy = A.y - B.y;
        const d2 = Math.max(dx * dx + dy * dy, 100);
        const f = 9000 / d2;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        A.x += dx * f; A.y += dy * f; B.x -= dx * f; B.y -= dy * f;
      }
    for (const e of g.edges) {
      const A = p.get(e.from), B = p.get(e.to);
      const dx = B.x - A.x, dy = B.y - A.y, d = Math.max(Math.hypot(dx, dy), 1);
      const f = (d - 90) * 0.05;
      A.x += dx / d * f; A.y += dy / d * f; B.x -= dx / d * f; B.y -= dy / d * f;
    }
    for (const n of g.nodes) {
      const p2 = p.get(n.id);
      p2.x += (200 - p2.x) * 0.02; p2.y += (200 - p2.y) * 0.02;
      pos.set(n.id, p2);
    }
  }
  savePos();
  draw();
}

// --- colour groups ---------------------------------------------------------
// Hue is derived from the folder; saturation and lightness come from the theme, so the
// same hue stays legible on Vantablack and on Paper. A hand-set hue lives in
// localStorage under "graph.colors" ({ "folder:adr": 232 }) and a legend click cycles
// the presets. No config file, no picker. Hue degrees, not hexes: a hex would only be
// legible on the theme it was picked on.
const PRESETS = [null, 232, 160, 0, 45, 292, 199];
function colors() { try { return JSON.parse(localStorage.getItem("graph.colors") ?? "{}"); } catch { return {}; } }
function hueOf(key) { let h = 0; for (const c of key) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
const groupOf = (n) => (n.folder ? "folder:" + n.folder : "root");
function groupColor(key) {
  const custom = colors()[key];
  const hue = typeof custom === "number" ? custom : hueOf(key);
  return "hsl(" + hue + " " + T.sat + " " + T.lig + ")";
}
const colorOf = (n) => groupColor(groupOf(n));

// --- filter + local graph --------------------------------------------------
// Both are client-side: the browser already holds every node and edge, so a
// /graph?depth= endpoint would re-read the same files to answer what is here.
function matches(n) {
  const q = filterEl.value.trim().toLowerCase();
  if (!q) return true;
  return q.split(/\s+/).every((tok) => {
    if (tok.startsWith("tag:")) return n.tags.some((t) => t.toLowerCase().includes(tok.slice(4)));
    if (tok.startsWith("path:")) return (n.folder + "/" + n.id).toLowerCase().includes(tok.slice(5));
    return (n.id + " " + n.title).toLowerCase().includes(tok);
  });
}
function localSet(id, depth) {
  const seen = new Set([id]);
  let frontier = [id];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const cur of frontier) for (const nb of adj.get(cur) ?? []) if (!seen.has(nb)) { seen.add(nb); next.push(nb); }
    frontier = next;
  }
  return seen;
}
function computeVisible() {
  const ok = new Set(g.nodes.filter(matches).map((n) => n.id));
  if (localEl.checked && focus && ok.has(focus)) {
    const near = localSet(focus, Number(depthEl.value));
    visible = new Set([...ok].filter((id) => near.has(id)));
  } else {
    visible = ok;
  }
  const shown = g.edges.filter((e) => visible.has(e.from) && visible.has(e.to)).length;
  countEl.textContent = visible.size + "/" + g.nodes.length + " nodes · " + shown + " edges";
  drawLegend();
  draw();
}

function drawLegend() {
  const groups = new Map();
  for (const n of g.nodes) if (visible.has(n.id)) groups.set(groupOf(n), (groups.get(groupOf(n)) ?? 0) + 1);
  legendEl.innerHTML = [...groups].sort((a, b) => b[1] - a[1]).map(([k, c]) =>
    '<span class="chip" data-group="' + k + '" title="click to recolour"><span class="dot" style="background:' +
    groupColor(k) + '"></span>' + esc(k.replace(/^(folder|tag):/, "")) + " " + c + "</span>").join("");
}

function draw() {
  const near = hover ? new Set([hover, ...(adj.get(hover) ?? [])]) : null;
  const parts = ['<g transform="translate(' + view.x + "," + view.y + ") scale(" + view.k + ')">'];
  for (const e of g.edges) {
    if (!visible.has(e.from) || !visible.has(e.to)) continue;
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const hot = near ? near.has(e.from) && near.has(e.to) : false;
    parts.push('<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" stroke="' +
      (e.mutual ? T.edgeHot : T.edge) + '" stroke-width="' + (hot ? 2 : 1) + '" opacity="' +
      (near && !hot ? 0.1 : 0.45) + '"/>');
  }
  for (const n of g.nodes) {
    if (!visible.has(n.id)) continue;
    const p = pos.get(n.id);
    if (!p) continue;
    const dim = near ? !near.has(n.id) : false;
    const col = colorOf(n);
    const r = 4 + Math.min(n.deg, 6) + (n.id === focus ? 2 : 0);
    parts.push('<circle data-id="' + n.id + '" cx="' + p.x + '" cy="' + p.y + '" r="' + r + '" fill="' +
      (n.dangling ? "none" : col) + '" stroke="' + col + '" stroke-width="' + (n.id === focus ? 2.5 : 1.5) +
      '" opacity="' + (dim ? 0.15 : 1) + '" style="cursor:pointer"/>');
    if (!dim) parts.push('<text x="' + (p.x + r + 3) + '" y="' + (p.y + 3) + '" opacity="' +
      (n.dangling ? 0.55 : 0.9) + '">' + esc(n.title) + (n.dangling ? " ?" : "") + "</text>");
  }
  parts.push("</g>");
  svg.innerHTML = parts.join("");
}

function panel(n) {
  const ins = g.edges.filter((e) => e.to === n.id).map((e) => e.from);
  const outs = g.edges.filter((e) => e.from === n.id).map((e) => e.to);
  const li = (a) => '<li><a data-go="' + esc(a) + '">' + esc(a) + "</a></li>";
  side.innerHTML =
    "<h2>" + esc(n.title) + "</h2>" +
    '<p class="muted">' + esc(n.file || n.source || "no file") + " · deg " + n.deg +
      (n.folder ? " · " + esc(n.folder) : "") + (n.dangling ? " · DANGLING" : "") + "</p>" +
    (n.tags.length ? n.tags.map((t) => '<span class="tag">' + esc(t) + "</span>").join("") : "") +
    "<p class='muted'>out</p><ul>" + (outs.map(li).join("") || "<li class='muted'>none</li>") + "</ul>" +
    "<p class='muted'>in</p><ul>" + (ins.map(li).join("") || "<li class='muted'>none</li>") + "</ul>" +
    (localEl.checked ? "<p class='muted'>local graph: this node ±" + depthEl.value + "</p>" : "");
}

// Panning: drag empty canvas. Node drag comes first so it wins the gesture.
let drag = null;
svg.addEventListener("pointerdown", (ev) => {
  const c = ev.target.closest("circle");
  const p = toWorld(ev);
  drag = c ? { node: c.dataset.id, dx: p.x - pos.get(c.dataset.id).x, dy: p.y - pos.get(c.dataset.id).y }
           : { pan: true, vx: view.x, vy: view.y, px: ev.clientX, py: ev.clientY };
  svg.setPointerCapture(ev.pointerId);
  if (!c) svg.classList.add("panning");
});
svg.addEventListener("pointermove", (ev) => {
  if (!drag) {
    const c = ev.target.closest("circle");
    const id = c ? c.dataset.id : null;
    if (id !== hover) { hover = id; draw(); }
    return;
  }
  if (drag.pan) { view.x = drag.vx + ev.clientX - drag.px; view.y = drag.vy + ev.clientY - drag.py; }
  else { const w = toWorld(ev); pos.set(drag.node, { x: w.x - drag.dx, y: w.y - drag.dy }); }
  draw();
});
svg.addEventListener("pointerleave", () => { if (hover) { hover = null; draw(); } });
svg.addEventListener("pointerup", () => {
  if (drag && !drag.pan) savePos();
  drag = null; svg.classList.remove("panning");
});
svg.addEventListener("click", (ev) => {
  const c = ev.target.closest("circle");
  if (!c) return;
  const n = g.nodes.find((x) => x.id === c.dataset.id);
  if (!n) return;
  focus = n.id;                      // click = centre the local graph here
  panel(n);
  computeVisible();
});
svg.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  view.k = Math.min(4, Math.max(0.2, view.k * (ev.deltaY < 0 ? 1.1 : 0.9)));
  draw();
}, { passive: false });
side.addEventListener("click", (ev) => {
  const a = ev.target.closest("[data-go]");
  if (!a) return;
  const n = g.nodes.find((x) => x.id === a.dataset.go);
  if (n) { focus = n.id; panel(n); computeVisible(); }
});
filterEl.addEventListener("input", computeVisible);
localEl.addEventListener("change", () => { depthEl.disabled = !localEl.checked; computeVisible(); });
depthEl.addEventListener("input", computeVisible);
legendEl.addEventListener("click", (ev) => {
  const chip = ev.target.closest("[data-group]");
  if (!chip) return;
  const map = colors();
  const key = chip.dataset.group;
  const next = PRESETS[(PRESETS.indexOf(map[key] ?? null) + 1) % PRESETS.length];
  if (next) map[key] = next; else delete map[key];
  localStorage.setItem("graph.colors", JSON.stringify(map));
  drawLegend();
  draw();
});
function toWorld(ev) {
  const r = svg.getBoundingClientRect();
  return { x: (ev.clientX - r.left - view.x) / view.k, y: (ev.clientY - r.top - view.y) / view.k };
}

fetch("/graph")
  .then((r) => r.json())
  .then((d) => {
    g = d;
    adj = new Map(g.nodes.map((n) => [n.id, new Set()]));
    for (const e of g.edges) { adj.get(e.from)?.add(e.to); adj.get(e.to)?.add(e.from); }
    layout();
    computeVisible();
    loadPos();
  })
  .catch(() => { side.innerHTML = "<p class='muted'>graph failed to load</p>"; });
