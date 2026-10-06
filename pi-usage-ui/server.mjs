// Pi usage stats + provider settings — zero-dependency server.
// node server.mjs   ->  http://127.0.0.1:8787
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = process.env.PI_AGENT_DIR || path.join(process.env.USERPROFILE || process.env.HOME, '.pi', 'agent');
const SESSIONS_DIR = process.env.PI_SESSIONS || path.join(AGENT_DIR, 'sessions');
const AUTH_FILE = path.join(AGENT_DIR, 'auth.json');
const MODELS_FILE = path.join(AGENT_DIR, 'models.json');
const SETTINGS_FILE = path.join(AGENT_DIR, 'settings.json');
const PORT = Number(process.env.PORT || 8787);

// ---------- usage scan ----------
const cache = new Map(); // file -> {mtimeMs, size, rows}

async function walk(dir) {
  const out = [];
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full));
    else if (e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

async function parseFile(file) {
  const st = await fsp.stat(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.rows;
  const rows = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const m = d?.message;
    const u = m?.usage;
    if (!u) continue;
    const c = u.cost || {};
    rows.push({
      p: m.provider || 'unknown',
      m: m.model || 'unknown',
      t: Date.parse(d.timestamp || m.timestamp || 0) || 0,
      day: String(d.timestamp || m.timestamp || '').slice(0, 10),
      i: u.input || 0, o: u.output || 0,
      cr: u.cacheRead || 0, cw: u.cacheWrite || 0, r: u.reasoning || 0,
      tt: u.totalTokens || 0, cost: c.total || 0,
    });
  }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, rows });
  return rows;
}

function blank() {
  return { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, cost: 0, msgs: 0 };
}
function add(a, r) {
  a.in += r.i; a.out += r.o; a.cacheRead += r.cr; a.cacheWrite += r.cw;
  a.reasoning += r.r; a.total += r.tt; a.cost += r.cost; a.msgs++;
}

async function stats({ force = false } = {}) {
  if (force) cache.clear();
  const files = await walk(SESSIONS_DIR);
  const rows = [];
  for (const f of files) {
    try { rows.push(...await parseFile(f)); } catch { /* unreadable file */ }
  }
  const totals = blank();
  const models = new Map();
  const providers = new Map();
  const days = new Map();
  const daysByProvider = new Map();
  for (const r of rows) {
    add(totals, r);
    const mk = r.p + '\u0000' + r.m;
    if (!models.has(mk)) models.set(mk, { ...blank(), provider: r.p, model: r.m, first: r.t, last: r.t });
    add(models.get(mk), r);
    const cur = models.get(mk);
    cur.first = Math.min(cur.first, r.t); cur.last = Math.max(cur.last, r.t);
    if (!providers.has(r.p)) providers.set(r.p, { ...blank() });
    add(providers.get(r.p), r);
    if (r.day) {
      if (!days.has(r.day)) days.set(r.day, { day: r.day, total: 0, msgs: 0 });
      days.get(r.day).total += r.tt; days.get(r.day).msgs++;
      if (!daysByProvider.has(r.p)) daysByProvider.set(r.p, new Map());
      const dp = daysByProvider.get(r.p);
      if (!dp.has(r.day)) dp.set(r.day, { day: r.day, total: 0, msgs: 0 });
      dp.get(r.day).total += r.tt; dp.get(r.day).msgs++;
    }
  }
  const sortDays = (arr) => arr.sort((a, b) => a.day.localeCompare(b.day));
  return {
    generatedAt: new Date().toISOString(),
    sessionsDir: SESSIONS_DIR,
    files: files.length,
    totals,
    rows: [...models.values()].sort((a, b) => b.total - a.total),
    providers: [...providers.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.total - a.total),
    days: sortDays([...days.values()]),
    daysByProvider: Object.fromEntries([...daysByProvider.entries()].map(([p, m]) => [p, sortDays([...m.values()])])),
  };
}

// ---------- provider settings ----------
const readJson = async (f, fallback) => { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch { return fallback; } };
const mask = (k) => (typeof k !== 'string' || !k ? '' : k.length <= 8 ? '****' : k.slice(0, 4) + '\u2026' + k.slice(-4));

async function settings() {
  const auth = await readJson(AUTH_FILE, {});
  const models = await readJson(MODELS_FILE, {});
  const prefs = await readJson(SETTINGS_FILE, {});
  const provs = models.providers || {};
  const ids = [...new Set([...Object.keys(auth), ...Object.keys(provs)])].sort();
  return {
    defaults: { provider: prefs.defaultProvider || null, model: prefs.defaultModel || null, thinking: prefs.defaultThinkingLevel || null },
    authFile: AUTH_FILE, modelsFile: MODELS_FILE, settingsFile: SETTINGS_FILE,
    providers: ids.map((id) => {
      const a = auth[id] || {};
      const p = provs[id] || {};
      const inlineKey = typeof p.apiKey === 'string' && p.apiKey;
      const authKey = typeof a.key === 'string' ? a.key : (typeof a.access === 'string' ? a.access : '');
      const source = inlineKey ? 'models.json' : a.key ? 'auth.json' : a.access ? 'auth.json (oauth)' : (a.type === 'oauth' ? 'oauth' : 'none');
      return {
        id,
        baseUrl: p.baseUrl || '',
        api: p.api || '',
        modelCount: Array.isArray(p.models) ? p.models.length : 0,
        models: (p.models || []).map((x) => x.id).slice(0, 200),
        keySource: source,
        keyMasked: mask(inlineKey || authKey),
        hasKey: Boolean(inlineKey || authKey),
        isDefault: prefs.defaultProvider === id,
      };
    }),
  };
}

async function writeSettings(body) {
  const { provider, apiKey, baseUrl, defaultModel } = body || {};
  if (!provider) throw new Error('provider required');
  const changed = [];
  if (typeof baseUrl === 'string' && baseUrl.trim()) {
    const models = await readJson(MODELS_FILE, { providers: {} });
    models.providers = models.providers || {};
    models.providers[provider] = models.providers[provider] || {};
    await fsp.copyFile(MODELS_FILE, MODELS_FILE + '.bak').catch(() => {});
    models.providers[provider].baseUrl = baseUrl.trim();
    await fsp.writeFile(MODELS_FILE, JSON.stringify(models, null, 2));
    changed.push('models.json:baseUrl');
  }
  if (typeof apiKey === 'string' && apiKey.trim()) {
    const auth = await readJson(AUTH_FILE, {});
    await fsp.copyFile(AUTH_FILE, AUTH_FILE + '.bak').catch(() => {});
    auth[provider] = { type: 'api_key', ...(auth[provider] || {}), key: apiKey.trim() };
    await fsp.writeFile(AUTH_FILE, JSON.stringify(auth, null, 2));
    changed.push('auth.json:apiKey');
  }
  if (typeof defaultModel === 'string' && defaultModel.trim()) {
    const prefs = await readJson(SETTINGS_FILE, {});
    await fsp.copyFile(SETTINGS_FILE, SETTINGS_FILE + '.bak').catch(() => {});
    prefs.defaultProvider = provider;
    prefs.defaultModel = defaultModel.trim();
    await fsp.writeFile(SETTINGS_FILE, JSON.stringify(prefs, null, 2));
    changed.push('settings.json:default');
  }
  return changed;
}

// ---------- http ----------
const json = (res, code, data) => { const b = JSON.stringify(data); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/stats') return json(res, 200, await stats({ force: url.searchParams.get('refresh') === '1' }));
    if (url.pathname === '/api/settings' && req.method === 'GET') return json(res, 200, await settings());
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e5) throw new Error('body too large'); }
      return json(res, 200, { ok: true, changed: await writeSettings(JSON.parse(raw || '{}')) });
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await fsp.readFile(path.join(HERE, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('pi usage ui: http://127.0.0.1:' + PORT);
  console.log('sessions:  ' + SESSIONS_DIR);
  stats().then((s) => console.log('warm: ' + s.files + ' files, ' + s.rows.length + ' provider/model rows, ' + s.totals.msgs + ' responses')).catch((e) => console.error(e));
});
