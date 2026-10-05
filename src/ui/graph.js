const svg = document.getElementById("canvas");
const side = document.getElementById("side");
let g = { nodes: [], edges: [] }, pos = new Map(), view = { x: 0, y: 0, k: 1 };

// Positions survive reload in wiki/.positions.json — it is authoring state for
// a human, so it does not belong in SQLite with the memories.
function loadPos() {
  fetch("/positions").then((r) => r.ok ? r.json() : {}).then((o) => {
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

// O(n^2) repulsion, 300 ticks then stop. ponytail: no Barnes-Hut — the wiki is
// 7 files; add a quadtree if it ever passes ~500 nodes.
function layout() {
  if (!g.nodes.length) return;
  g.nodes.forEach((n, i) => {
    if (!pos.has(n.id)) {
      const a = (i / g.nodes.length) * Math.PI * 2;
      pos.set(n.id, { x: 200 + Math.cos(a) * 150, y: 200 + Math.sin(a) * 150 });
    }
  });
  const linked = (a, b) => g.edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
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

function draw() {
  const S = svg.innerHTML =
    '<g transform="translate(' + view.x + "," + view.y + ") scale(" + view.k + ')">' +
    g.edges.map((e) => {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) return "";
      return '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y +
        '" stroke="' + (e.mutual ? "#6366f1" : "#3f3f46") + '" stroke-width="1" opacity=".45"/>';
    }).join("") +
    g.nodes.map((n) => {
      const p = pos.get(n.id);
      if (!p) return "";
      const r = 4 + Math.min(n.deg, 6);
      return '<circle data-id="' + n.id + '" cx="' + p.x + '" cy="' + p.y + '" r="' + r +
        '" fill="' + (n.dangling ? "none" : "#818cf8") + '" stroke="#818cf8" stroke-width="1.5" style="cursor:pointer"/>' +
        '<text x="' + (p.x + r + 3) + '" y="' + (p.y + 3) + '">' + n.title.replace(/[<>&]/g, "") + "</text>";
    }).join("") + "</g>";
  svg.innerHTML = S;
}

function panel(n) {
  const ins = g.edges.filter((e) => e.to === n.id).map((e) => e.from);
  const outs = g.edges.filter((e) => e.from === n.id).map((e) => e.to);
  const li = (a) => "<li><a data-go=\"" + a + "\">" + a + "</a></li>";
  side.innerHTML =
    "<h2>" + n.title + "</h2>" +
    '<p class="muted">' + (n.source || "no source") + " · deg " + n.deg + (n.dangling ? " · DANGLING" : "") + "</p>" +
    "<p class='muted'>out</p><ul>" + (outs.map(li).join("") || "<li class='muted'>none</li>") + "</ul>" +
    "<p class='muted'>in</p><ul>" + (ins.map(li).join("") || "<li class='muted'>none</li>") + "</ul>";
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
  if (!drag) return;
  if (drag.pan) { view.x = drag.vx + ev.clientX - drag.px; view.y = drag.vy + ev.clientY - drag.py; }
  else { const w = toWorld(ev); pos.set(drag.node, { x: w.x - drag.dx, y: w.y - drag.dy }); }
  draw();
});
svg.addEventListener("pointerup", () => {
  if (drag && !drag.pan) savePos();
  drag = null; svg.classList.remove("panning");
});
svg.addEventListener("click", (ev) => {
  const c = ev.target.closest("circle");
  if (c) panel(g.nodes.find((n) => n.id === c.dataset.id));
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
  if (n) panel(n);
});
function toWorld(ev) {
  const r = svg.getBoundingClientRect();
  return { x: (ev.clientX - r.left - view.x) / view.k, y: (ev.clientY - r.top - view.y) / view.k };
}

fetch("/graph")
  .then((r) => r.json())
  .then((d) => { g = d; layout(); loadPos(); })
  .catch(() => { side.innerHTML = "<p class='muted'>graph failed to load</p>"; });
