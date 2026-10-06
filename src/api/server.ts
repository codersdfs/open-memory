import "../config.js";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, normalize } from "node:path";
import { MemoryService } from "../core/memoryService.js";
import { TYPES, STATUSES, type MemoryType, type MemoryStatus } from "../core/types.js";
import { appVersion } from "../version.js";

// Resolved relative to this file, so the built layout must keep `src/api/` next to
// `src/ui/` — which is why the build copies the static UI into `dist/src/ui` rather
// than shipping it only at the package root. Without that copy every page 404s from
// an installed package while working fine from the repo.
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "../ui");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

/** Trust boundary: every field here comes off the wire. */
function str(v: unknown, max = 5000, min = 0): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length < min || t.length > max ? null : t;
}
function num(v: unknown, lo: number, hi: number): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
}
function enumOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return allowed.includes(v as T) ? (v as T) : undefined;
}
function boolish(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
}
const bad = (why: string) => ({ status: 400, body: { error: why } });

function parseCreate(body: Record<string, unknown>) {
  const text = str(body.text, 5000, 1);
  if (!text) return bad("text required (1-5000 chars)");
  const type = enumOf(body.type, TYPES);
  if (!type) return bad(`type must be one of ${TYPES.join("|")}`);
  return {
    data: {
      namespace: str(body.namespace, 200, 1) ?? "default:default",
      type: type as MemoryType,
      text,
      importance: num(body.importance, 0, 1),
      source: str(body.source, 200) ?? undefined,
      tags: Array.isArray(body.tags) ? body.tags.slice(0, 10).map(String) : undefined,
      supersedesId: typeof body.supersedesId === "string" ? body.supersedesId : null,
      visibility: "private" as const,
      status: enumOf(body.status, STATUSES) ?? ("active" as MemoryStatus),
      pin: (num(body.pin, 0, 1) !== undefined ? Math.round(Number(body.pin)) : 0) as 0 | 1,
    },
  };
}

function parseSearch(q: Record<string, unknown>) {
  const query = str(q.query, 2000, 1);
  if (!query) return bad("query required");
  return {
    data: {
      query,
      namespace: str(q.namespace, 200, 1) ?? "default:default",
      type: enumOf(q.type, TYPES),
      k: num(q.k, 1, 50) ?? 5,
      budgetTokens: num(q.budgetTokens, 10, 10000) ?? 800,
      threshold: num(q.threshold, 0, 1) ?? 0.72,
      status: enumOf(q.status, STATUSES),
      includeArchived: boolish(q.includeArchived),
      includeDraft: boolish(q.includeDraft),
      // Opt-in: four extra numbers per hit is real payload on a response whose
      // whole point is a token budget.
      explain: boolish(q.explain) === true,
    },
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export async function buildServer(opts?: { dbPath?: string; service?: MemoryService }) {
  const service = opts?.service ?? new MemoryService({ dbPath: opts?.dbPath });
  await service.init();

  const app: Server = createServer((req, res) => {
    void handle(req, res, service).catch((e) => {
      const status = e instanceof SyntaxError ? 400 : 500;
      send(res, status, { error: e instanceof Error ? e.message : String(e) });
    });
  });
  app.on("close", () => service.close());
  return { app, service };
}

function send(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

async function handle(req: IncomingMessage, res: ServerResponse, service: MemoryService) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const q = Object.fromEntries(url.searchParams);

  if (path === "/health") {
    // `version` is what lets a CLI notice a daemon left running from an older
    // install. Reachability alone is not enough: a stale daemon answers /health
    // happily while serving old routes.
    return send(res, 200, {
      ok: true,
      embedding: service.embedder.name,
      dim: service.embedder.dim,
      version: await appVersion(),
    });
  }
  if (path === "/stats" && method === "GET") {
    const ns = str(q.namespace, 200, 1) ?? "default:default";
    const total = (await service.list({ namespace: ns, limit: 1 })).total;
    const byType: Record<string, number> = {};
    for (const t of TYPES) byType[t] = (await service.list({ namespace: ns, type: t as MemoryType, limit: 1 })).total;
    return send(res, 200, { namespace: ns, total, byType, embedding: service.embedder.name, dim: service.embedder.dim });
  }
  if (path === "/graph" && method === "GET") {
    const dir = process.env.WIKI_DIR ?? "wiki";
    const { loadPages, buildGraph } = await import("../core/graph.js");
    return send(res, 200, buildGraph(await loadPages(dir)));
  }
  if (path === "/positions") {
    const file = join(process.env.WIKI_DIR ?? "wiki", ".positions.json");
    if (method === "POST") {
      const { slug, x, y } = await readJson(req);
      const id = str(slug, 200, 1);
      const nx = num(x, -1e6, 1e6), ny = num(y, -1e6, 1e6);
      if (!id || nx === undefined || ny === undefined) return send(res, 400, { error: "slug,x,y required" });
      const { readFile, writeFile } = await import("node:fs/promises");
      let all: Record<string, { x: number; y: number }> = {};
      try { all = JSON.parse(await readFile(file, "utf8")); } catch {}
      all[id] = { x: nx, y: ny };
      await writeFile(file, JSON.stringify(all), "utf8");
      return send(res, 200, { ok: true, count: Object.keys(all).length });
    }
    try {
      const { readFile } = await import("node:fs/promises");
      return send(res, 200, JSON.parse(await readFile(file, "utf8")));
    } catch { return send(res, 200, {}); }
  }
  if (path === "/decay" && method === "POST") {
    const { runDecay } = await import("../core/lifecycle/decay.js");
    return send(res, 200, { pruned: await runDecay(service.store) });
  }

  // Must precede the `/memories/:id` route below: that pattern also matches
  // "/memories/search", so a GET would be read as "fetch the memory whose id is
  // search" and answer 404 — which is exactly what `search` did whenever a
  // daemon was running, while the daemon-less path and `POST` kept working.
  if (/^\/memories\/search$/.test(path)) {
    const p = parseSearch(method === "GET" ? q : await readJson(req));
    if ("status" in p) return send(res, p.status, p.body);
    return send(res, 200, await service.search(p.data));
  }

  const mem = new RegExp("^/memories(/[^/]+)?(/supersede)?$").exec(path);
  if (mem) {
    const id = mem[1] ? decodeURIComponent(mem[1].slice(1)) : null;
    if (id && mem[2] && method === "POST") {
      const p = parseCreate(await readJson(req));
      if ("status" in p) return send(res, p.status, p.body);
      return send(res, 201, await service.supersede(id, p.data));
    }
    if (id && !mem[2] && method === "PATCH") {
      const body = await readJson(req);
      // `isDeleted` is how `restore` reaches the tombstone; without it the daemon
      // silently answered "ok" while leaving the row soft-deleted.
      const isDeleted = body.isDeleted === undefined || body.isDeleted === null ? undefined : body.isDeleted ? 1 : 0;
      const patch = {
        status: enumOf(body.status, STATUSES),
        pin: num(body.pin, 0, 1) !== undefined ? (Math.round(Number(body.pin)) as 0 | 1) : undefined,
        isDeleted,
        // Only touch visibility when the caller asked; a blanket "private" would
        // silently rewrite shared memories on any pin/status edit.
        visibility: body.visibility === undefined ? undefined : ("private" as const),
      };
      const updated = await service.updateMeta(id, patch);
      return updated ? send(res, 200, updated) : send(res, 404, { error: "not found" });
    }
    if (id && !mem[2] && method === "GET") {
      const found = await service.get(id);
      return found ? send(res, 200, found) : send(res, 404, { error: "not found" });
    }
    if (id && !mem[2] && method === "DELETE") {
      await service.delete(id);
      return send(res, 200, { ok: true });
    }
    if (!id && method === "POST") {
      const p = parseCreate(await readJson(req));
      if ("status" in p) return send(res, p.status, p.body);
      return send(res, 201, await service.save(p.data));
    }
    if (!id && method === "GET") {
      return send(res, 200, await service.list({
        namespace: str(q.namespace, 200, 1) ?? "default:default",
        type: enumOf(q.type, TYPES),
        includeDeleted: boolish(q.includeDeleted),
        status: enumOf(q.status, STATUSES),
        includeArchived: boolish(q.includeArchived),
        includeDraft: boolish(q.includeDraft),
        limit: num(q.limit, 1, 1000) ?? 50,
        offset: num(q.offset, 0, 1e9) ?? 0,
        query: str(q.q ?? q.query, 2000, 1),
      } as never));
    }
  }

  if (path === "/extract" && method === "POST") {
    const body = await readJson(req);
    const text = str(body.text ?? body.turnText, 20000, 1);
    if (!text) return send(res, 400, { error: "text required" });
    const memories = await service.extractAndSave(text, str(body.namespace, 200, 1) ?? "default:default");
    return send(res, 200, { extracted: memories.length, memories });
  }

  // static UI — everything unmatched
  const rel = path === "/" ? "index.html" : normalize(path).replace(/^([/\\.])+/, "");
  const file = join(UI_DIR, rel);
  if (!file.startsWith(UI_DIR)) return send(res, 403, { error: "forbidden" });
  const ext = rel.slice(rel.lastIndexOf("."));
  try {
    const html = await readFile(file);
    res.writeHead(200, { "content-type": MIME[ext] ?? "text/plain" });
    res.end(html);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const port = Number(process.env.PORT ?? process.env.MEMORY_PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  const { app } = await buildServer();
  // Without this, a port clash is an unhandled 'error' event: the process dies
  // silently in the background and whoever spawned it just sees a timeout.
  app.on("error", (e: NodeJS.ErrnoException) => {
    console.error(`ai-memory cannot listen on ${host}:${port} — ${e.code ?? e.message}`);
    if (e.code === "EADDRINUSE") console.error(`another instance already owns it; kill it or set PORT.`);
    process.exit(1);
  });
  app.listen(port, host, () => console.log(`ai-memory → http://${host}:${port}`));
}
