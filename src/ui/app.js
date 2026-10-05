const API = ""; // same-origin: node:http serves both /api and the UI

const els = {
  ns: document.getElementById("namespaceInput"),
  refresh: document.getElementById("refreshBtn"),
  stats: document.getElementById("statsLine"),
  q: document.getElementById("qInput"),
  typeFilter: document.getElementById("typeFilter"),
  searchBtn: document.getElementById("searchBtn"),
  k: document.getElementById("kInput"), kVal: document.getElementById("kVal"),
  th: document.getElementById("thInput"), thVal: document.getElementById("thVal"),
  budget: document.getElementById("budgetInput"), budgetVal: document.getElementById("budgetVal"),
  budgetBar: document.getElementById("budgetBar"), budgetFill: document.getElementById("budgetFill"), budgetLabel: document.getElementById("budgetLabel"),
  results: document.getElementById("searchResults"), summary: document.getElementById("summaryLine"),
  createType: document.getElementById("createType"), createText: document.getElementById("createText"),
  createImp: document.getElementById("createImportance"), createTags: document.getElementById("createTags"),
  createBtn: document.getElementById("createBtn"), createMsg: document.getElementById("createMsg"),
  extractText: document.getElementById("extractText"), extractBtn: document.getElementById("extractBtn"), extractMsg: document.getElementById("extractMsg"),
  decayBtn: document.getElementById("decayBtn"), exportBtn: document.getElementById("exportBtn"),
  listType: document.getElementById("listType"), listStatus: document.getElementById("listStatus"), listQuery: document.getElementById("listQuery"), includeDeleted: document.getElementById("includeDeleted"),
  table: document.getElementById("memTable"), total: document.getElementById("totalCount"),
  prev: document.getElementById("prevPage"), next: document.getElementById("nextPage"), pageInfo: document.getElementById("pageInfo"),
  detail: document.getElementById("detail"), detailClose: document.getElementById("detailClose"),
  detailId: document.getElementById("detailId"), detailText: document.getElementById("detailText"),
  detailType: document.getElementById("detailType"), detailImp: document.getElementById("detailImp"),
  detailTags: document.getElementById("detailTags"), detailSource: document.getElementById("detailSource"),
  detailVis: document.getElementById("detailVis"), detailStatus: document.getElementById("detailStatus"), detailPinBadge: document.getElementById("detailPinBadge"),
  detailStatusSel: document.getElementById("detailStatusSel"),
  detailSup: document.getElementById("detailSup"), detailDim: document.getElementById("detailDim"),
  detailDelete: document.getElementById("detailDelete"), detailPin: document.getElementById("detailPin"), detailSupBtn: document.getElementById("detailSupersedeBtn"),
  chain: document.getElementById("chainView"),
};

let page = 0, pageSize = 20, selectedId = null;

function ns() { return els.ns.value.trim() || "default:default"; }
async function jfetch(url, opts) {
  const r = await fetch(API + url, { headers: { "Content-Type": "application/json" }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ? JSON.stringify(j.error) : r.statusText);
  return j;
}

async function loadStats() {
  try {
    const s = await jfetch(`/stats?namespace=${encodeURIComponent(ns())}`);
    els.stats.textContent = `${s.total} memories · ${s.embedding} ${s.dim}d · ${ns()}`;
  } catch (e) { els.stats.textContent = String(e); }
}

async function loadList() {
  const params = new URLSearchParams({ namespace: ns(), limit: String(pageSize), offset: String(page * pageSize) });
  if (els.listType.value) params.set("type", els.listType.value);
  if (els.listStatus.value && els.listStatus.value !== "all") params.set("status", els.listStatus.value);
  else if (els.listStatus.value === "all") { params.set("includeArchived", "true"); params.set("includeDraft", "true"); }
  if (els.listQuery.value) params.set("q", els.listQuery.value);
  if (els.includeDeleted.checked) params.set("includeDeleted", "true");
  const { memories, total } = await jfetch(`/memories?${params}`);
  els.total.textContent = `(${total})`;
  els.pageInfo.textContent = `page ${page + 1} · ${total} total`;
  els.table.innerHTML = memories.map(m => `
    <tr class="border-b border-zinc-800 hover:bg-zinc-800/50 cursor-pointer ${m.isDeleted ? "opacity-40" : ""} ${m.status !== 'active' ? "opacity-60" : ""}" data-id="${m.id}">
      <td class="px-3 py-2"><span class="px-1.5 py-0.5 rounded text-[10px] ${badge(m.type)}">${m.type}</span> ${m.pin ? '<span class="ml-1 text-amber-400">📌</span>' : ''} ${m.status !== 'active' ? `<span class="ml-1 text-[9px] px-1 rounded bg-zinc-800 text-zinc-400">${m.status}</span>` : ''}</td>
      <td class="px-3 py-2 max-w-[420px] truncate" title="${esc(m.text)}">${esc(m.text.slice(0,120))}${m.text.length>120?"…":""} ${m.isDeleted?'<span class=text-red-400>· deleted</span>':''} ${m.supersedesId?'<span class=text-amber-400>· supersedes</span>':''}</td>
      <td class="px-3 py-2">${m.importance.toFixed(2)}</td>
      <td class="px-3 py-2 text-zinc-500">${new Date(m.createdAt).toLocaleString()}</td>
      <td class="px-3 py-2"><button class="viewBtn text-indigo-400 hover:underline" data-id="${m.id}">view</button></td>
    </tr>`).join("") || `<tr><td colspan=5 class="px-3 py-8 text-center text-zinc-500">no memories — create one or run seed</td></tr>`;
  els.table.querySelectorAll("tr[data-id]").forEach(tr => tr.addEventListener("click", () => openDetail(tr.dataset.id)));
}

function badge(t){ return {episodic:"bg-sky-900/40 text-sky-300 border border-sky-800", semantic:"bg-emerald-900/40 text-emerald-300 border border-emerald-800", procedural:"bg-violet-900/40 text-violet-300 border border-violet-800", working:"bg-amber-900/40 text-amber-300 border border-amber-800"}[t]||"bg-zinc-800"; }
function esc(s){ return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

async function openDetail(id){
  selectedId = id;
  const m = await jfetch(`/memories/${id}`);
  els.detail.classList.remove("hidden");
  els.detailId.textContent = m.id;
  els.detailText.textContent = m.text;
  els.detailType.textContent = m.type;
  els.detailImp.textContent = String(m.importance);
  els.detailTags.textContent = (m.tags||[]).join(", ") || "—";
  els.detailSource.textContent = m.source || "—";
  els.detailVis.textContent = m.visibility || "private";
  els.detailStatus.textContent = m.status || "active";
  els.detailStatusSel.value = m.status || "active";
  els.detailPin.textContent = m.pin ? "Unpin" : "Pin";
  els.detailPinBadge.classList.toggle("hidden", !m.pin);
  els.detailSup.textContent = m.supersedesId || "—";
  els.detailDim.textContent = String(m.embedding.length);
  // chain: walk supersedes
  let chain = [];
  let cur = m;
  while (cur.supersedesId) {
    try { cur = await jfetch(`/memories/${cur.supersedesId}`); chain.push(cur); } catch { break; }
  }
  els.chain.innerHTML = chain.length ? `<div class="text-zinc-500 mb-1">Supersede chain (${chain.length}):</div>` + chain.map(c => `<div class="pl-3 border-l border-zinc-700 py-1"><span class="text-zinc-500">${c.id.slice(0,8)}</span> ${esc(c.text.slice(0,80))} <span class="text-zinc-600">${c.isDeleted?"· deleted":""}</span></div>`).join("") : `<span class="text-zinc-600">no supersede chain</span>`;
}

async function doSearch(){
  const body = { query: els.q.value.trim(), namespace: ns(), k: Number(els.k.value), budgetTokens: Number(els.budget.value), threshold: Number(els.th.value) };
  if (!body.query) { els.results.innerHTML = `<p class="text-zinc-500">enter a query</p>`; return; }
  if (els.typeFilter.value) body.type = els.typeFilter.value;
  els.searchBtn.textContent = "Searching…";
  try {
    const r = await jfetch(`/memories/search`, { method:"POST", body: JSON.stringify(body) });
    const pct = Math.min(100, (r.tokensUsed / body.budgetTokens) * 100);
    els.budgetBar.classList.remove("hidden");
    els.budgetFill.style.width = pct + "%";
    els.budgetFill.className = "h-full transition-all " + (r.truncated ? "bg-amber-500" : pct>90 ? "bg-amber-500" : "bg-emerald-500");
    els.budgetLabel.textContent = `${r.tokensUsed} / ${body.budgetTokens} tokens · ${r.memories.length} memories · score threshold ${body.threshold}${r.truncated?" · truncated (summary added)":""}`;
    els.results.innerHTML = r.memories.length ? r.memories.map(m => `
      <div class="bg-zinc-950 border border-zinc-800 rounded p-3">
        <div class="flex justify-between text-xs text-zinc-500"><span class="px-1.5 py-0.5 rounded ${badge(m.type)}">${m.type}</span><span>score ${m.score.toFixed(3)} · vec ${m.vectorScore.toFixed(2)} · bm25 ${m.bm25Score.toFixed(2)} · recency ${m.recencyScore.toFixed(2)} · ${m.tokens} tok</span></div>
        <p class="mt-2 text-sm">${esc(m.text)}</p>
        <div class="text-xs text-zinc-600 mt-1">${m.id.slice(0,8)} · imp ${m.importance}</div>
      </div>`).join("") : `<p class="text-zinc-500">no memories above threshold ${body.threshold} — try lowering threshold (prevents context burn)</p>`;
    if (r.summary) { els.summary.textContent = "Overflow summary: " + r.summary; els.summary.classList.remove("hidden"); } else els.summary.classList.add("hidden");
    els.summary.classList.remove("hidden");
  } catch (e) { els.results.innerHTML = `<p class="text-red-400">${esc(String(e))}</p>`; }
  finally { els.searchBtn.textContent = "Search (POST /memories/search)"; }
}

// create
els.createBtn.onclick = async () => {
  const text = els.createText.value.trim(); if (!text) return;
  const body = { namespace: ns(), type: els.createType.value, text, importance: Number(els.createImp.value), tags: els.createTags.value.split(",").map(s=>s.trim()).filter(Boolean) };
  els.createMsg.textContent = "saving…";
  try { const m = await jfetch(`/memories`, { method:"POST", body: JSON.stringify(body) }); els.createMsg.textContent = `saved ${m.id.slice(0,8)}`; els.createText.value=""; await loadList(); await loadStats(); } catch (e){ els.createMsg.textContent = String(e); }
};
els.extractBtn.onclick = async () => {
  const text = els.extractText.value.trim(); if (!text) return;
  els.extractMsg.textContent = "extracting…";
  try { const r = await jfetch(`/extract`, { method:"POST", body: JSON.stringify({ text, namespace: ns() }) }); els.extractMsg.textContent = `extracted ${r.extracted}`; els.extractText.value=""; await loadList(); await loadStats(); } catch(e){ els.extractMsg.textContent = String(e); }
};
els.decayBtn.onclick = async () => { const r = await jfetch(`/decay`, { method:"POST" }); alert(`pruned ${r.pruned}`); await loadList(); };
els.exportBtn.onclick = async () => {
  const { memories } = await jfetch(`/memories?namespace=${encodeURIComponent(ns())}&limit=1000`);
  const blob = new Blob([JSON.stringify(memories, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob); const a=document.createElement("a"); a.href=url; a.download=`memories-${ns()}.json`; a.click(); URL.revokeObjectURL(url);
};
els.detailClose.onclick = () => els.detail.classList.add("hidden");
els.detailDelete.onclick = async () => { if (!selectedId) return; await jfetch(`/memories/${selectedId}`, { method:"DELETE" }); els.detail.classList.add("hidden"); await loadList(); };
els.detailPin.onclick = async () => {
  if (!selectedId) return;
  const cur = await jfetch(`/memories/${selectedId}`);
  const nextPin = cur.pin ? 0 : 1;
  await jfetch(`/memories/${selectedId}`, { method:"PATCH", body: JSON.stringify({ pin: nextPin }) });
  await openDetail(selectedId); await loadList();
};
els.detailStatusSel.onchange = async () => {
  if (!selectedId) return;
  await jfetch(`/memories/${selectedId}`, { method:"PATCH", body: JSON.stringify({ status: els.detailStatusSel.value }) });
  await openDetail(selectedId); await loadList();
};
els.detailSupBtn.onclick = async () => {
  if (!selectedId) return;
  const text = prompt("New text to supersede with:");
  if (!text) return;
  const cur = await jfetch(`/memories/${selectedId}`);
  const body = { namespace: cur.namespace, type: cur.type, text, importance: cur.importance, tags: cur.tags };
  await jfetch(`/memories/${selectedId}/supersede`, { method:"POST", body: JSON.stringify(body) });
  els.detail.classList.add("hidden"); await loadList();
};

// filters
els.k.oninput = () => els.kVal.textContent = els.k.value;
els.th.oninput = () => els.thVal.textContent = Number(els.th.value).toFixed(2);
els.budget.oninput = () => els.budgetVal.textContent = els.budget.value;
els.searchBtn.onclick = doSearch;
els.q.addEventListener("keydown", e=>{ if(e.key==="Enter") doSearch(); });
els.refresh.onclick = async ()=>{ await loadStats(); await loadList(); };
els.listType.onchange = ()=>{ page=0; loadList(); };
els.listStatus.onchange = ()=>{ page=0; loadList(); };
els.listQuery.oninput = ()=>{ page=0; loadList(); };
els.includeDeleted.onchange = ()=>{ page=0; loadList(); };
els.prev.onclick = ()=>{ if(page>0){ page--; loadList(); } };
els.next.onclick = ()=>{ page++; loadList(); };
els.ns.addEventListener("change", async ()=>{ page=0; await loadStats(); await loadList(); });

// --- Prototype 004: Wiki page graph (throwaway, no backend) ---
const wikiPages = [
  { slug: "api-spec", title: "API spec", source: "raw/docs/api.md", links: ["runbook", "adr-0005"], body: "Endpoints: POST /memories, POST /memories/search (k, budgetTokens, threshold), GET /memories, POST /extract. Tool: memory_search. Hybrid 0.6vec+0.2bm25+0.15recency+0.05importance → MMR → hard budget 800." },
  { slug: "runbook", title: "Runbook", source: "raw/docs/runbook.md", links: ["api-spec"], body: "On call: check memory.db size, run /decay for episodic >90d importance<0.3, re-embed after provider swap (dim mismatch → clear). Seed: npm run seed. Env: EMBEDDING_PROVIDER=nim, NIM_BASE_URL." },
  { slug: "adr-0005", title: "ADR-0005 Flat layers via tags", source: "docs/adr/0005-flat-layers-via-tags-C.md", links: ["api-spec", "scenario:auth"], body: "Decision C: keep episodic|semantic|procedural|working, simulate L0~episodic, L1~semantic fact, L2~scope:scenario:*, L3~scope:persona via tags+importance. No layer column; graduates via ADD COLUMN layer." }
];
function renderWiki() {
  const grid = document.getElementById("wikiGrid");
  if (!grid) return;
  grid.innerHTML = wikiPages.map(p => `
    <div class="bg-zinc-950 border border-zinc-800 rounded p-4 hover:border-zinc-700 cursor-pointer" data-wiki="${p.slug}">
      <div class="flex justify-between items-start"><h4 class="font-medium text-sm">${p.title}</h4><span class="text-[10px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-400">${p.slug}</span></div>
      <p class="text-xs text-zinc-400 mt-1">source: ${p.source}</p>
      <p class="text-sm mt-2 line-clamp-3">${p.body}</p>
      <div class="mt-3 flex flex-wrap gap-1.5">${p.links.map(l => `<button data-link="${l}" class="wikiLink text-[11px] px-2 py-0.5 rounded-full bg-indigo-900/30 border border-indigo-800 text-indigo-300 hover:bg-indigo-900/50">↗ ${l}</button>`).join("")}</div>
    </div>`).join("");
  grid.querySelectorAll("[data-wiki]").forEach(el => el.addEventListener("click", e => {
    if (e.target.closest(".wikiLink")) return;
    const slug = el.getAttribute("data-wiki");
    const pg = wikiPages.find(x=>x.slug===slug);
    alert(`${pg.title} (${pg.slug})\n\n${pg.body}\n\nlinks: ${pg.links.join(", ")}\n\n→ prototype: would drill via /v3/tools/call or memory_search scope:wiki`);
  }));
  grid.querySelectorAll(".wikiLink").forEach(btn => btn.addEventListener("click", e => {
    e.stopPropagation();
    const link = btn.getAttribute("data-link");
    const target = wikiPages.find(x=>x.slug===link);
    if (target) { alert(`Link drill → ${target.title}\n\n${target.body.slice(0,200)}…\n\n(003 hybrid: pages linked via frontmatter links: ["${link}"])`); }
    else { alert(`Link → ${link}\n\n(003 hybrid: external link — e.g. CodeGraph src/auth or tag scope:${link})\n\nPrototype: would call memory_search tags:${link}`); }
  }));
  const drop = document.getElementById("wikiImport");
  const msg = document.getElementById("wikiImportMsg");
  const file = document.getElementById("wikiFile");
  if (drop && msg) {
    ["dragenter","dragover"].forEach(ev=> drop.addEventListener(ev, e=>{ e.preventDefault(); drop.classList.add("border-indigo-600","bg-zinc-900"); }));
    ["dragleave","drop"].forEach(ev=> drop.addEventListener(ev, e=>{ e.preventDefault(); drop.classList.remove("border-indigo-600","bg-zinc-900"); }));
    drop.addEventListener("drop", e=>{
      const names = [...(e.dataTransfer?.files||[])].map(f=>f.name).join(", ") || "files";
      msg.textContent = `Dropped ${names} — prototype (no backend). Wire to npm run wiki:ingest when ready.`;
      msg.className = "text-xs text-amber-400 mt-2";
      setTimeout(()=>{ msg.textContent = "Ingest trigger: npm run wiki:ingest ./docs/foo.md (003)"; msg.className="text-xs text-zinc-500 mt-2"; }, 3500);
    });
    file?.addEventListener("change", e=>{
      const names = [...(e.target.files||[])].map(f=>f.name).join(", ");
      if (names) { msg.textContent = `Selected ${names} — prototype (no backend)`; msg.className="text-xs text-amber-400 mt-2"; }
    });
  }
}
renderWiki();

// init
loadStats(); loadList();
