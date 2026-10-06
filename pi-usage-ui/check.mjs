// ponytail check: node check.mjs  (server must be running)
const base = process.env.BASE || 'http://127.0.0.1:8787';
const ok = (c, m) => { if (!c) { console.error('FAIL ' + m); process.exit(1); } console.log('ok   ' + m); };

const s = await (await fetch(base + '/api/stats')).json();
ok(s.totals.total > 0, 'stats totals > 0 (' + s.totals.total + ' tokens over ' + s.files + ' files)');
ok(s.rows.length > 0, 'provider/model rows: ' + s.rows.length);
ok(s.rows.every(r => r.provider && r.model && r.total >= 0), 'every row has provider+model+total');
ok(s.totals.total === s.rows.reduce((a, r) => a + r.total, 0) || s.rows.every(r => r.total > 0), 'rows sum sensibly');
ok(Array.isArray(s.days) && s.days.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d.day)), 'day buckets are ISO days: ' + s.days.length);

const g = await (await fetch(base + '/api/settings')).json();
ok(Array.isArray(g.providers) && g.providers.length > 0, 'provider settings rows: ' + g.providers.length);
const raw = JSON.stringify(g);
ok(!/"(key|access|refresh|apiKey)":"[^"]{12,}"/.test(raw), 'no raw credential in settings payload');
ok(g.providers.some(p => p.hasKey), 'at least one provider reports a stored key (masked)');

const html = await (await fetch(base + '/')).text();
ok(html.includes('/api/stats') && html.includes('/api/settings'), 'page wires both endpoints');
console.log('ALL CHECKS PASS');
