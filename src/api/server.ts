import "../config.js";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, normalize } from "node:path";
import { MemoryService } from "../core/memoryService.js";
import { TYPES, STATUSES, type MemoryType, type MemoryStatus } from "../core/types.js";
import { appVersion } from "../version.js";
import { createEmbeddingProvider, EMBEDDING_PRESETS, previewEmbedding, type EmbeddingProvider } from "../core/embedding/index.js";
import { reembedAll, type ReembedResult } from "../core/embedding/reembed.js";
import { embedEnv, embeddingSource, mergeEnv, readSettings, SETTING_KEYS, settingsPath, writeSettings, type Settings } from "../core/settings.js";

// Resolved relative to this file, so the built layout must keep `src/api/` next to
// `src/ui/` — which is why the build copies the static UI into `dist/src/ui` rather
// than shipping it only at the package root. Without that copy every page 404s from
// an installed package while working fine from the repo.
const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "../ui");
const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon", ".map": "application/json"
};
/**
 * Where a built console would be (ADR-0007). Two layouts, one route:
 * `dist/src/ui-next` when the package was built (`copy-ui.mjs` puts it there), and
 * `ui/dist` when it is running from the repo after `npm --prefix ui run build`.
 * Neither existing is a normal state — it means the console was never built — and
 * that has to say so, not answer with an empty 404.
 */
const UI_NEXT_DIRS = [
  join(UI_DIR, "..", "ui-next"),
  join(UI_DIR, "..", "..", "ui", "dist"),
];
// ponytail: full-scan cap for the stats view; page per-status if the store ever outgrows it
const STATS_ROW_CAP = 20000;

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
    const base = { namespace: ns, total, byType, embedding: service.embedder.name, dim: service.embedder.dim };
    if (!boolish(q.full)) return send(res, 200, base);

    // `full=1` is additive: the numbers above keep their meaning, and the summary is
    // computed over every row in the partition, tombstones included — a stats view
    // that cannot see what was soft-deleted cannot preview what decay would take.
    const { summarize } = await import("../core/stats.js");
    const rows = (await service.list({ namespace: ns, includeDeleted: true, limit: STATS_ROW_CAP })).memories;
    const { total: _rows, byType: _byType, ...full } = summarize(rows, Date.now());
    const dbPath = (service as unknown as { dbPath?: string }).dbPath ?? null;
    return send(res, 200, { ...base, rowsScanned: _rows, ...full, dbPath, dbBytes: dbPath ? await fileSize(dbPath) : null });
  }
  if (path === "/namespaces" && method === "GET") {
    // The partitions a namespace picker has to offer. `includeDeleted` on purpose:
    // a partition holding only tombstones reads as empty everywhere else, and
    // "why is my picker missing the namespace I saved into" is the confusion this
    // route exists to remove. No query params, no writes — the store decides.
    return send(res, 200, { namespaces: await service.store.distinctNamespaces({ includeDeleted: true }) });
  }
  // The embedding switch (ticket 015, ADR-0009). The console may *write* the switch;
  // it may not *become* it: the running embedder is frozen at construction, so an
  // edit here takes effect at the next start — and the migration has to happen before
  // that start, or MemoryService.init() refuses the store and names both dims.
  if (path === "/embedding" && method === "GET") {
    return send(res, 200, await embeddingInfo(service, str(q.namespace, 200, 1) ?? "default:default"));
  }

  if (path === "/embedding" && method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { error: "malformed JSON body" });
    }
    const patch: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (typeof value !== "string") return send(res, 400, { error: key + " must be a string" });
      patch[key] = value;
    }

    // The environment wins over the file — that is the precedence, and it means a key
    // already set there makes this write a no-op. Answering "ok" while nothing moves is
    // the silent-fallback bug this project keeps writing comments about, so a shadowed
    // key is an error that names where the value actually lives.
    const shadowed = Object.keys(patch).filter((key) => (process.env[key] ?? "").trim() !== "");
    if (shadowed.length > 0) {
      return send(res, 400, {
        error:
          shadowed.join(", ") +
          " is set in the environment, which overrides settings.json — unset it (or edit .env) before switching here",
      });
    }

    // Preview first, write second: previewEmbedding is the factory's own resolution,
    // so a patch that previews cleanly cannot fail at the next start — and a rejected
    // patch leaves no file behind at all. writeSettings is what rejects secret-shaped
    // and unknown keys, and it throws before it opens anything.
    const preview = previewEmbedding(mergeEnv(process.env, { ...readSettings(), ...patch } as Settings));
    if (!preview.ok) return send(res, 400, { error: preview.error });
    try {
      await writeSettings(patch as Settings);
    } catch (e) {
      return send(res, 400, { error: e instanceof Error ? e.message : "bad settings" });
    }
    // `needsRestart` is measured, not assumed: writing the same provider the process
    // already serves with is not a reason to restart anything.
    const liveMatches =
      service.embedder.name === preview.provider &&
      service.embedder.dim === preview.dim &&
      (service.embedder.model ?? null) === preview.model;
    return send(res, 200, {
      ok: true,
      needsRestart: !liveMatches,
      target: { provider: preview.provider, dim: preview.dim, model: preview.model },
    });
  }

  if (path === "/embedding/reembed" && method === "GET") {
    return send(res, 200, reembedJob);
  }

  if (path === "/embedding/reembed" && method === "POST") {
    if (reembedJob.state === "running") return send(res, 409, { error: "a re-embed is already running" });
    let body: Record<string, unknown> = {};
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { error: "malformed JSON body" });
    }
    // Default is the dry run: the row count is the only thing standing between a click
    // and N embedding calls, so the destructive direction is the one asked for.
    const dryRun = body.dryRun !== false;
    let target: EmbeddingProvider;
    try {
      target = createEmbeddingProvider(embedEnv());
    } catch (e) {
      return send(res, 400, { error: e instanceof Error ? e.message : "embedding provider unavailable" });
    }
    startReembed(service, target, dryRun);
    return send(res, 202, reembedJob);
  }

  if (path === "/graph" && method === "GET") {
    const { loadPages, buildGraph, vaultDir } = await import("../core/graph.js");
    return send(res, 200, buildGraph(await loadPages(vaultDir())));
  }
  if (path === "/positions") {
    const { vaultDir } = await import("../core/graph.js");
    const file = join(vaultDir(), ".positions.json");
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

  // pi's own session timeline. Read-only and unindexed: the files are the source of
  // truth, and the root comes from the environment, never from the request — a
  // "which file do I read" query parameter is a path traversal with a nicer name.
  if (path === "/sessions" && method === "GET") {
    const { listSessions } = await import("../core/sessions.js");
    try {
      return send(res, 200, await listSessions({ limit: num(q.limit, 1, 500) ?? 50, offset: num(q.offset, 0, 1e6) ?? 0 }));
    } catch (e) {
      return send(res, 500, { error: e instanceof Error ? e.message : "sessions unavailable" });
    }
  }
  const sessionPath = /^\/sessions\/(.+)$/.exec(path);
  if (sessionPath && method === "GET") {
    const { readSession, SessionError } = await import("../core/sessions.js");
    let id: string;
    try {
      id = decodeURIComponent(sessionPath[1]!);
    } catch {
      return send(res, 400, { error: "malformed session id" });
    }
    try {
      return send(res, 200, await readSession(id, {
        offset: num(q.offset, 0, 1e6) ?? 0,
        limit: num(q.limit, 1, 500) ?? 200,
        maxChars: boolish(q.full) ? Number.POSITIVE_INFINITY : undefined
      }));
    } catch (e) {
      if (e instanceof SessionError) return send(res, e.code === "bad-id" ? 400 : 404, { error: e.message });
      return send(res, 500, { error: e instanceof Error ? e.message : "session unreadable" });
    }
  }

  // The console IS the UI (ADR-0008). `/` serves it, and `/app` keeps answering so
  // deep links from the pre-handover layout do not break. Both run before the
  // catch-all: a missing build must say so, never fall through to a stale page.
  if (path === "/" || path === "/app" || path.startsWith("/app/")) {
    const rel = path === "/" || path === "/app" || path === "/app/" ? "index.html" : normalize(path.slice(5)).replace(/^([/\\.])+/, "");
    const ext = rel.slice(rel.lastIndexOf("."));
    for (const dir of UI_NEXT_DIRS) {
      const file = join(dir, rel);
      if (!file.startsWith(dir)) break;
      try {
        const body = await readFile(file);
        res.writeHead(200, { "content-type": MIME[ext] ?? "text/plain" });
        res.end(body);
        return;
      } catch { /* try the next layout */ }
    }
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("console not built — run: npm --prefix ui install && npm run ui:build");
  }

  // Everything else static, over two disjoint roots: `src/ui` holds the graph page
  // the console frames, and the console build holds its own hashed `assets/`. A miss
  // in the first has to fall through to the second — without it `/assets/index-*.js`
  // answers 404 while `/` answers 200, and the console paints an empty `#root`.
  const rel = normalize(path).replace(/^([/\\.])+/, "");
  const ext = rel.slice(rel.lastIndexOf("."));
  for (const dir of [UI_DIR, ...UI_NEXT_DIRS]) {
    const file = join(dir, rel);
    if (!file.startsWith(dir)) break;
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[ext] ?? "text/plain" });
      res.end(body);
      return;
    } catch { /* try the next root */ }
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}

/** Where each provider's credential is read from. NIM answers to two names. */
const KEY_ENVS = ["NVIDIA_API_KEY", "NIM_API_KEY", "OPENAI_API_KEY"] as const;
const NIM_KEY_ALIASES = ["NVIDIA_API_KEY", "NIM_API_KEY"] as const;

function keyPresent(name: string): boolean {
  return (process.env[name] ?? "").trim() !== "";
}

interface EmbeddingJob {
  state: "idle" | "running" | "done" | "error";
  dryRun: boolean;
  scanned: number;
  rewritten: number;
  done: number;
  total: number;
  failed: { id: string; error: string }[];
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

const IDLE_JOB: EmbeddingJob = {
  state: "idle", dryRun: true, scanned: 0, rewritten: 0, done: 0, total: 0,
  failed: [], startedAt: null, finishedAt: null, error: null,
};
// ponytail: one job for the process. Two migrations of one store is not a state worth
// modelling — the second request is a 409 until the first finishes.
let reembedJob: EmbeddingJob = { ...IDLE_JOB };

/**
 * Migrate every stored vector to `target`, in this process, reporting through
 * GET /embedding/reembed.
 *
 * Deliberately not awaited by the route: `scanned` is every row in every partition, and
 * with a remote provider that is one HTTP call per row. The live embedder is untouched,
 * so the caller must restart afterwards for search to see the new space — which is why
 * a finished job is never rendered as a success banner.
 */
function startReembed(service: MemoryService, target: EmbeddingProvider, dryRun: boolean): void {
  reembedJob = { ...IDLE_JOB, state: "running", dryRun, startedAt: Date.now() };
  void (async () => {
    try {
      const res: ReembedResult = await reembedAll(service.store, target, {
        dryRun,
        onProgress: (done, total) => {
          reembedJob.done = done;
          reembedJob.total = total;
        },
      });
      reembedJob = {
        ...reembedJob,
        state: "done",
        scanned: res.scanned,
        rewritten: res.rewritten,
        failed: res.failed,
        done: res.scanned,
        total: res.scanned,
        finishedAt: Date.now(),
      };
    } catch (e) {
      reembedJob = {
        ...reembedJob,
        state: "error",
        error: e instanceof Error ? e.message : "re-embed failed",
        finishedAt: Date.now(),
      };
    }
  })();
}

/**
 * What is live, what a restart would use, and how many rows the live provider cannot
 * read.
 *
 * `unreadable` is the number this route exists for. A row whose width is not the live
 * dim is skipped by a search rather than fatal, and the startup guard only ever compares
 * against the first row — so a partly-migrated store answers quietly with fewer rows and
 * nothing else in the API can see it.
 */
async function embeddingInfo(service: MemoryService, namespace: string) {
  const live = {
    provider: service.embedder.name,
    dim: service.embedder.dim,
    model: service.embedder.model ?? null,
    source: embeddingSource(),
  };
  const preview = previewEmbedding(embedEnv());
  const target = preview.ok ? { provider: preview.provider, dim: preview.dim, model: preview.model } : null;
  const needsRestart =
    target === null ||
    target.provider !== live.provider ||
    target.dim !== live.dim ||
    target.model !== live.model;

  const rows = (await service.list({ namespace, includeDeleted: true, limit: STATS_ROW_CAP })).memories;
  const { summarize } = await import("../core/stats.js");
  const byVectorDim = summarize(rows, Date.now()).byVectorDim;
  // A width of 0 is a row with no vector at all: search cannot use it either, so it
  // counts here rather than being quietly excluded.
  const unreadable = Object.entries(byVectorDim).reduce(
    (n, [width, count]) => (width === String(live.dim) ? n : n + count),
    0,
  );

  return {
    live,
    target,
    needsRestart,
    // Additive to the documented shape: a broken settings file has to be able to say
    // *why*, and `target: null` alone cannot.
    targetError: preview.ok ? null : preview.error,
    presets: EMBEDDING_PRESETS.map((p) =>
      p.keyEnv === "NVIDIA_API_KEY"
        ? { ...p, keyEnv: NIM_KEY_ALIASES.find(keyPresent) ?? "NVIDIA_API_KEY" }
        : p,
    ),
    keys: KEY_ENVS.map((env) => ({ env, present: keyPresent(env) })),
    // Keys a write would be overridden on. The console cannot make the switch where
    // one of these is set, and saying so beats a control that silently does nothing.
    shadowed: SETTING_KEYS.filter(keyPresent),
    settingsPath: settingsPath(),
    stored: { byVectorDim, unreadable },
    reembed: reembedJob,
    namespace,
  };
}
async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
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
