import "../src/config.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MemoryService } from "../src/core/memoryService.js";

const ns = process.env.NAMESPACE ?? "default:default";
const dbPath = process.env.MEMORY_DB_PATH ?? "memory.db";

function parseArgs(argv: string[]) {
  const out: { code?: string; wiki?: string; chats?: string; ns?: string; positional: string[] } = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--code" && argv[i + 1]) { out.code = argv[++i]; }
    else if (a === "--wiki" && argv[i + 1]) { out.wiki = argv[++i]; }
    else if (a === "--chats" && argv[i + 1]) { out.chats = argv[++i]; }
    else if (a === "--ns" && argv[i + 1]) { out.ns = argv[++i]; }
    else if (a === "--help") { out.positional.push(a); }
    else if (!a.startsWith("--")) out.positional.push(a);
  }
  // positional fallback: first positional as code if code not set, second as wiki, third as chats
  if (!out.code && out.positional.length >= 1 && out.positional[0] !== "--help") out.code = out.positional[0];
  // legacy: npm run cold-start -- ./my-repo ./docs ./chats.jsonl positional form
  if (!out.wiki && out.positional.length >= 2) out.wiki = out.positional[1];
  if (!out.chats && out.positional.length >= 3) out.chats = out.positional[2];
  return out;
}

async function codegraphStep(target: string) {
  const exists = await fs.stat(path.join(target, ".codegraph")).then(() => true).catch(() => false);
  const cmd = exists ? "sync" : "init";
  console.log(`codegraph ${cmd} ${target} ...`);
  const res = spawnSync("npx", ["codegraph", cmd, target], { stdio: "inherit", shell: true });
  if (res.status !== 0) {
    console.error(`codegraph ${cmd} failed (code ${res.status}) — continuing`);
    return { ok: false, nodes: 0 };
  }
  // try to read status
  const dbPathCg = path.join(target, ".codegraph", "codegraph.db");
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPathCg);
    const row = db.prepare("SELECT count(*) as c FROM nodes").get() as { c: number } | undefined;
    db.close();
    const n = row?.c ?? 0;
    console.log(`codegraph: ${n} nodes`);
    return { ok: true, nodes: n };
  } catch {
    return { ok: true, nodes: 0 };
  }
}

async function wikiStep(wikiSrc: string, effNs: string, dbPathEff: string) {
  // delegate to wiki-ingest logic inline (avoid spawn)
  const stat = await fs.stat(wikiSrc).catch(() => null);
  if (!stat) { console.warn(`wiki source not found: ${wikiSrc} — skip`); return { ok: 0, failed: 0 }; }
  // reuse script by spawning tsx wiki-ingest
  console.log(`wiki ingest ${wikiSrc} ...`);
  const res = spawnSync("npx", ["tsx", "scripts/wiki-ingest.ts", wikiSrc, "--ns", effNs], { stdio: "inherit", shell: true, env: { ...process.env, NAMESPACE: effNs, MEMORY_DB_PATH: dbPathEff } });
  if (res.status !== 0) console.warn(`wiki ingest exit ${res.status}`);
  // count wiki files
  const wikiDir = "wiki";
  const files = await fs.readdir(wikiDir).catch(() => []);
  const count = files.filter(f => f.endsWith(".md") && f !== "index.md").length;
  return { ok: count, failed: res.status !== 0 ? 1 : 0 };
}

async function chatsStep(chatsPath: string, effNs: string, dbPathEff: string) {
  const stat = await fs.stat(chatsPath).catch(() => null);
  if (!stat) { console.warn(`chats not found: ${chatsPath} — skip`); return { ok: 0, failed: 0, total: 0 }; }
  const raw = await fs.readFile(chatsPath, "utf8");
  let items: { type: string; text: string; importance?: number; tags?: string[]; source?: string }[] = [];
  if (chatsPath.endsWith(".jsonl")) {
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { items.push(JSON.parse(line)); } catch { console.warn(`skip invalid jsonl line: ${line.slice(0,80)}`); }
    }
  } else {
    const parsed = JSON.parse(raw);
    items = Array.isArray(parsed) ? parsed : [parsed];
  }
  const svc = new MemoryService({ dbPath: dbPathEff });
  await svc.init();
  let ok = 0, failed = 0;
  for (const it of items) {
    try {
      await svc.save({
        namespace: effNs,
        type: (it.type as never) ?? "episodic",
        text: String(it.text),
        importance: it.importance,
        tags: it.tags,
        source: it.source ?? `chat:${chatsPath}`
      });
      ok++;
    } catch (e) { failed++; console.error(`chat save failed: ${(e as Error).message}`); }
  }
  const total = (await svc.list({ namespace: effNs, limit: 1 })).total;
  svc.close();
  console.log(`chats: ${ok} ok, ${failed} failed → total ${total} memories in ${effNs}`);
  return { ok, failed, total };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.positional.includes("--help")) {
    console.log(`cold-start — 007 sync minimal (no status enum, partial success allowed)

Usage:
  npm run cold-start -- [codePath] [wikiPath] [chatsPath]
  npm run cold-start -- --code ./my-repo --wiki ./docs --chats ./chats.jsonl [--ns default:default]

Steps (sync, blocking):
  1) codegraph init/sync <code>  → .codegraph/ (reuse per 005, 292ms for 28 files)
  2) wiki ingest <wiki>          → ./wiki/*.md + semantic scope:wiki (003 hybrid)
  3) chats import <chats>        → episodic/semantic rows (001 tags scope:scenario:*)

Defaults: code=. if no flags, wiki=./docs if exists, chats=./chats.jsonl if exists.
Prints: cold-started N memories, M wiki pages, K code nodes.
`);
    process.exit(0);
  }
  const effNs = args.ns ?? ns;
  const effDb = dbPath;
  const code = args.code ?? ".";
  let wiki = args.wiki ?? "";
  if (!wiki) {
    try { await fs.stat("docs"); wiki = "docs"; } catch { wiki = ""; }
  }
  let chats = args.chats ?? "";
  if (!chats) {
    try { await fs.stat("chats.jsonl"); chats = "chats.jsonl"; } catch {
      try { await fs.stat("chats.json"); chats = "chats.json"; } catch { chats = ""; }
    }
  }

  console.log(`cold-start ns=${effNs} db=${effDb}`);
  let wikiRes = { ok: 0, failed: 0 };
  let codeRes = { ok: true, nodes: 0 };
  let chatsRes = { ok: 0, failed: 0, total: 0 };

  // 1) codegraph
  if (code) {
    try { codeRes = await codegraphStep(code); } catch (e) { console.error(`codegraph error: ${(e as Error).message}`); }
  }
  // 2) wiki
  if (wiki) {
    try { wikiRes = await wikiStep(wiki, effNs, effDb); } catch (e) { console.error(`wiki error: ${(e as Error).message}`); }
  } else console.log("wiki: skip (no source)");
  // 3) chats
  if (chats) {
    try { chatsRes = await chatsStep(chats, effNs, effDb); } catch (e) { console.error(`chats error: ${(e as Error).message}`); }
  } else console.log("chats: skip (no source)");

  // final counts from memory.db
  const svc = new MemoryService({ dbPath: effDb });
  await svc.init();
  const { total } = await svc.list({ namespace: effNs, limit: 1 });
  svc.close();

  const wikiCount = wikiRes.ok;
  const codeNodes = codeRes.nodes;
  console.log(`\ncold-started ${total} memories (${effNs}), ${wikiCount} wiki pages, ${codeNodes} code nodes — db ${effDb} ${codeRes.ok ? "" : "(codegraph failed)"}`);
}

main().catch(e => { console.error(e); process.exit(1); });
