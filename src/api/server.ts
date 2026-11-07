import "../config.js";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { isIPv4 } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, normalize } from "node:path";
import { MemoryService, CurationRejected, type SaveInput } from "../core/memoryService.js";
import { stripEmbedding, TYPES, STATUSES, KINDS, type MemoryType, type MemoryKind, type MemoryStatus } from "../core/types.js";
import { isScope, resolveReadScope, resolveWriteKey } from "../core/scope.js";
import { appVersion } from "../version.js";
import { createEmbeddingProvider, EMBEDDING_PRESETS, previewEmbedding, type EmbeddingProvider } from "../core/embedding/index.js";
import { reembedAll, type ReembedResult } from "../core/embedding/reembed.js";
import {
  runtimeEnv, embeddingSource, mergeEnv, readSettings, isWritableKey, keyEffect, settingsInventory,
  adoptEnvKeys, SETTING_KEYS, WRITABLE_KEYS, settingsPath, writeSettings, type Settings,
} from "../core/settings.js";
import { envFilePath } from "../core/envFile.js";
import { validateJevKey } from "../core/judgment/judge.js";

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
// One bulk request is one transaction and one embed batch. 5k rows at ~1.1k chars is
// ~5.5 MB of text and one embed call per provider limit stayed well inside what a
// single request should hold; larger imports belong in `ai-memory import`, which can
// stream.
const BULK_LIMIT = 5000;

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

/**
 * Which partition a write lands in. An explicit `namespace` still wins. A caller naming
 * `agent`/`scope` gets that one layer through `resolveWriteKey` — never the shared one.
 * A caller naming neither keeps the v0.2.0 legacy partition. Namespace is an daemon
 * internal here, so dropping `agent`/`scope` sent every scoped write to `default:default`
 * while the daemon-less path honoured it.
 */
function createNamespace(body: Record<string, unknown>): string {
  const explicit = str(body.namespace, 200, 1);
  if (explicit) return explicit;
  const agent = str(body.agent, 200, 1) ?? undefined;
  const scope = isScope(body.scope) ? body.scope : undefined;
  return agent || scope ? resolveWriteKey({ agent, scope }) : "default:default";
}

/**
 * The partitions a read should cover. An explicit `namespaces` list still wins (the CLI
 * resolves it where the agent and user are actually known). Otherwise `agent`/`scope`/
 * `all` resolve here: a daemon that answers from its own default reports nothing found
 * for memories that are plainly there.
 *
 * Async because `all` is a question about the store, not about the request: it has to
 * enumerate the partitions that actually hold rows. Resolving it as a fixed three-name
 * list (`<agent>:<user>`, `shared:<user>`, legacy) answered `all` with a set that was
 * missing the partitions of every other agent this user owns — measured on the real
 * store it skipped the four rows in `coding-agent:frank`.
 */
async function searchScope(
  q: Record<string, unknown>,
  service: MemoryService
): Promise<{ namespace?: string; namespaces?: string[] }> {
  const listed = str(q.namespaces, 2000, 1)?.split(",").map((s) => s.trim()).filter(Boolean);
  if (listed && listed.length > 0) return { namespaces: listed };
  const explicit = str(q.namespace, 200, 1);
  if (explicit) return { namespace: explicit };
  const agent = str(q.agent, 200, 1) ?? undefined;
  const scope = isScope(q.scope) ? q.scope : undefined;
  const all = boolish(q.all);
  if (agent || scope || all) {
    const { namespaces } = await resolveReadScope({ agent, scope, all }, service.store);
    return { namespaces };
  }
  return { namespace: "default:default" };
}

/** `searchScope` says "one namespace" or "these namespaces"; the knowledge API wants one shape. */
function knowledgeScope(scope: { namespace?: string; namespaces?: string[] }): { namespace: string } | { namespaces: string[] } {
  return scope.namespaces && scope.namespaces.length > 0
    ? { namespaces: scope.namespaces }
    : { namespace: scope.namespace ?? "default:default" };
}

function parseCreate(body: Record<string, unknown>) {  const text = str(body.text, 5000, 1);
  if (!text) return bad("text required (1-5000 chars)");
  const type = enumOf(body.type, TYPES);
  if (!type) return bad(`type must be one of ${TYPES.join("|")}`);
  return {
    data: {
      namespace: createNamespace(body),
      type: type as MemoryType,
      text,
      // ADR-0020/0021. Omitted means "let the store decide": project falls back to the
      // repository the server runs in, kind to the wording. An explicit null project is
      // a real value (unscoped), so it must survive as null rather than be dropped.
      project: body.project === undefined ? undefined : body.project === null ? null : String(body.project),
      kind: enumOf(body.kind, KINDS) as MemoryKind | undefined,
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

async function parseSearch(q: Record<string, unknown>, service: MemoryService) {
  const query = str(q.query, 2000, 1);
  if (!query) return bad("query required");
  return {
    data: {
      query,
      // Overrides `namespace`, and resolves `agent`/`scope`/`all` when it is absent.
      ...(await searchScope(q, service)),
      type: enumOf(q.type, TYPES),
      project: q.project === undefined ? undefined : q.project === null ? null : String(q.project),
      kind: enumOf(q.kind, KINDS) as MemoryKind | undefined,
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

export async function buildServer(opts?: { dbPath?: string; service?: MemoryService; onShutdown?: () => void }) {
  const service = opts?.service ?? new MemoryService({ dbPath: opts?.dbPath });
  await service.init();

  // How the process stops, as a callback because a test has to prove the route reached
  // it without the runner dying. The default is the real thing: drop the listener first,
  // then the process — `daemon restart` polls /health after asking, so a port still held
  // open would read as a daemon that never stopped.
  const shutdown = opts?.onShutdown ?? (() => {
    app.close();
    process.exit(0);
  });

  const app: Server = createServer((req, res) => {
    void handle(req, res, service, shutdown).catch((e) => {
      const status = e instanceof SyntaxError ? 400 : 500;
      send(res, status, { error: e instanceof Error ? e.message : String(e) });
    });
  });
  app.on("close", () => service.close());
  return { app, service };
}

/**
 * HTTP responses carry no vectors unless asked (`?embedding=1`).
 *
 * A 384-float embedding is ~9 kB per memory and a search returns five of them — for a
 * payload whose point is text, a score and a token budget. Both consumers inside this
 * repo already discard the field after receiving it (the MCP tools and the CLI), so
 * stripping here removes bytes nothing was reading. The flag exists because whoever
 * does want raw vectors should not have to open the store to get them.
 */
function wantsEmbedding(query: Record<string, string | undefined>): boolean {
  return boolish(query.embedding) === true;
}

function send(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

async function handle(req: IncomingMessage, res: ServerResponse, service: MemoryService, shutdown: () => void) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const q = Object.fromEntries(url.searchParams);

  // `/admin/shutdown` has to answer a stranger as if the route were not there, and that
  // answer has to come before the Origin tier: tier A's 403 would confirm the route exists.
  // Its `Origin` is still checked below — this only settles the peer, which decides between
  // a 404 and a gate that says something.
  if (path === "/admin/shutdown" && method === "POST" && !isLoopbackAddress(req.socket.remoteAddress)) {
    return notFound(res);
  }

  // Tier A of the mutation gate, before any route looks at the request (see
  // `foreignOriginProblem` for why only `Origin` and not the content type is global).
  if (method === "POST" || method === "PATCH" || method === "DELETE") {
    const foreign = foreignOriginProblem(req);
    if (foreign) return send(res, foreign.status, { error: foreign.error });
  }

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
    const refused = notJsonProblem(req);
    if (refused) return send(res, refused.status, { error: refused.error });
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

    // This route writes the embedding switch and nothing else. `writeSettings` accepts
    // the console's credentials too, so the scope is stated here: a patch key this route
    // does not own is a 400 naming it, never a write into settings.json.
    const outside = Object.keys(patch).filter((key) => !(SETTING_KEYS as readonly string[]).includes(key));
    if (outside.length > 0) {
      // One key reads as a sentence; more than one has to agree with its verb.
      const named =
        outside.length === 1
          ? `${outside[0]} is not an embedding setting`
          : `${outside.join(", ")} are not embedding settings`;
      return send(res, 400, { error: `${named} — this route writes only: ${SETTING_KEYS.join(", ")}` });
    }

    // Everything after this route's own scope guard — the shadowed check, validation of
    // what the patch touches, the write — is the sequence `/settings` uses too, so it is
    // one function. A copy is how the two routes would start disagreeing about which
    // patch was validated. `alwaysPreview` because this route's answer *is* the target:
    // a patch of judge or extractor knobs still may not be saved before the switch it sits
    // in is known to build, or this route answers 400 for a patch it already wrote.
    const guarded = await guardSettingsWrite(patch, { alwaysPreview: true });
    if (!guarded.ok) return send(res, guarded.status, { error: guarded.error });

    // `alwaysPreview` is what makes this a target rather than a null: the guard previewed
    // the switch before it wrote anything.
    const preview = guarded.preview;
    // `needsRestart` is measured, not assumed: writing the same provider the process
    // already serves with is not a reason to restart anything.
    return send(res, 200, {
      ok: true,
      needsRestart: !runsOnTarget(service.embedder, preview),
      target: { provider: preview.provider, dim: preview.dim, model: preview.model },
    });
  }

  // The console's own settings surface: the inventory it renders, and the writes it makes.
  if (path === "/settings" && method === "GET") {
    return send(res, 200, {
      entries: settingsInventory(),
      settingsPath: settingsPath(),
      // The file adopt reads and comments out. The daemon does not read it: `config.ts`
      // calls `process.loadEnvFile()` with no argument, which loads `.env` from the cwd
      // only. So an `MEMORY_ENV_FILE` that names anything else makes this field name a file
      // nothing loads — it must point at the file the daemon actually reads, or adopt
      // moves keys the running process never saw.
      envPath: envFilePath(),
      // Measured the way /embedding measures it: is there a difference between what this
      // process serves and what the next start would build?
      restartRequired: restartPending(service),
    });
  }

  if (path === "/settings" && method === "POST") {
    const refused = notJsonProblem(req);
    if (refused) return send(res, refused.status, { error: refused.error });
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
    // This route writes both whitelists and nothing else. `writeSettings` would reject the
    // rest anyway, but a 400 that names the key and the list is the only version the
    // console can show as a sentence.
    const outside = Object.keys(patch).filter((key) => !isWritableKey(key));
    if (outside.length > 0) {
      const named =
        outside.length === 1 ? `${outside[0]} is not a settings key` : `${outside.join(", ")} are not settings keys`;
      return send(res, 400, { error: `${named} — this route writes only: ${WRITABLE_KEYS.join(", ")}` });
    }

    // Nothing to save is not a write: `writeSettings({})` would rewrite settings.json for a
    // patch that changes nothing, and report a restart the request did not ask for.
    if (Object.keys(patch).length === 0) return send(res, 200, { saved: [], restartRequired: false });

    const guarded = await guardSettingsWrite(patch);
    if (!guarded.ok) return send(res, guarded.status, { error: guarded.error });
    return send(res, 200, { saved: Object.keys(patch), restartRequired: restartPending(service) });
  }

  // Adopt: the environment wins the merge, so a key sitting in `.env` shadows every write
  // above. This is how the user gets out of that without hand-editing — the values move
  // into settings.json and their `.env` lines are commented out, never deleted.
  if (path === "/settings/adopt-env" && method === "POST") {
    const refused = notJsonProblem(req);
    if (refused) return send(res, refused.status, { error: refused.error });
    try {
      return send(res, 200, await adoptEnvKeys());
    } catch (e) {
      return send(res, 400, { error: e instanceof Error ? e.message : "could not adopt .env" });
    }
  }

  // The restart at the end of every "restart required" (the CLI's `daemon restart`). The
  // console is a localhost surface and this stops the process, so a caller that is not on
  // the loopback address is answered as if the route were not there: a 403 would confirm
  // it is, and this is not a route to advertise.
  if (path === "/admin/shutdown" && method === "POST") {
    // The peer is settled above, before the Origin tier, so a non-loopback caller is 404 by
    // now. A loopback peer is still only half the question: a page open in the user's own
    // browser is one too. Its `Origin` was already refused above if it named another
    // machine; what is left is this route's own JSON requirement (tier B).
    const refused = notJsonProblem(req);
    if (refused) return send(res, refused.status, { error: refused.error });
    res.writeHead(204);
    res.end();
    // `finish`, not the end of this function: the 204 has to leave before the listener
    // carrying it goes away.
    res.on("finish", shutdown);
    return;
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
      target = createEmbeddingProvider(runtimeEnv());
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
    const { runDecayDetailed } = await import("../core/lifecycle/decay.js");
    // Since v0.4 the default pass archives, so the response has to name both halves;
    // `pruned` alone used to mean "rows removed" and now means "rows hard-deleted".
    const report = await runDecayDetailed(service.store);
    return send(res, 200, { ...report, affected: report.archived + report.pruned });
  }

  if (path === "/compact" && method === "POST") {
    // Soft delete keeps the bytes: this is the operator's one lever that gives them
    // back. Optional on the store, so a store without a file to rewrite answers 501
    // rather than pretending it reclaimed nothing.
    if (!service.store.compact) return send(res, 501, { error: "this store cannot compact" });
    return send(res, 200, await service.store.compact());
  }

  // Project brief (ADR-0022). GET for a shell one-liner, POST for a caller that wants
  // to pass a project explicitly; both resolve partitions exactly like `/memories/search`,
  // so `agent`/`scope`/`all` mean what they mean everywhere else.
  if (path === "/brief" && (method === "GET" || method === "POST")) {
    const body = method === "POST" ? await readJson(req) : {};
    const qq: Record<string, unknown> = { ...q, ...body };
    const scope = await searchScope(qq, service);
    const sinceDays = num(qq.sinceDays, 1, 3650);
    const brief = await service.brief({
      ...(scope.namespaces ? { namespaces: scope.namespaces } : { namespace: scope.namespace }),
      project: qq.project === undefined ? undefined : qq.project === null ? null : String(qq.project),
      budgetTokens: num(qq.budgetTokens, 60, 10000),
      sinceMs: sinceDays === undefined ? undefined : sinceDays * 86_400_000
    });
    return send(res, 200, brief);
  }

  // Project management (ADR-0042). Reads are one GROUP BY over the dimension; the
  // writes are bulk statements over the `project` column. Slugs travel URL-encoded,
  // and every write normalizes through the same `normalizeProject` a memory write
  // uses, so the CLI, the console and MCP cannot disagree about what a slug is.
  if (path === "/projects" && method === "GET") {
    return send(res, 200, { projects: await service.listProjects() });
  }
  if (path === "/projects" && method === "POST") {
    const refused = notJsonProblem(req);
    if (refused) return send(res, refused.status, { error: refused.error });
    const body = await readJson(req);
    // Omitted resolves like a write (env, then the git root); explicit null stays
    // unaccepted here — initializing "unscoped" is not a project.
    const project = body.project === undefined ? undefined : String(body.project);
    const note = body.note === undefined ? undefined : String(body.note);
    try {
      const out = await service.initProject({
        project,
        note,
        agent: str(body.agent, 200, 1) ?? undefined,
        user: str(body.user, 200, 1) ?? undefined
      });
      return send(res, out.created ? 201 : 200, out);
    } catch (e) {
      return send(res, 400, { error: e instanceof Error ? e.message : "init failed" });
    }
  }
  const projectRename = /^\/projects\/([^/]+)\/rename$/.exec(path);
  if (projectRename && method === "POST") {
    const refused = notJsonProblem(req);
    if (refused) return send(res, refused.status, { error: refused.error });
    const body = await readJson(req);
    const to = str(body.to, 200, 1);
    if (!to) return send(res, 400, { error: "to required (the new project slug)" });
    try {
      return send(res, 200, await service.renameProject(decodeURIComponent(projectRename[1]!), to, { merge: body.merge === true }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "rename failed";
      return send(res, /unknown project/.test(msg) ? 404 : 400, { error: msg });
    }
  }
  const projectForget = /^\/projects\/([^/]+)$/.exec(path);
  if (projectForget && method === "DELETE") {
    // Default is the reversible direction, exactly like `DELETE /memories/:id`.
    const mode = q.mode === "detach" ? "detach" : "delete";
    try {
      return send(res, 200, await service.forgetProject(decodeURIComponent(projectForget[1]!), { mode }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "forget failed";
      return send(res, /unknown project/.test(msg) ? 404 : 400, { error: msg });
    }
  }

  // Knowledge index (ADR-0023). `sync` is the only writer: it re-reads the vault and
  // reconciles one row per section. Everything else reads the index, not the files.
  if (path === "/knowledge/sync" && method === "POST") {
    const body = await readJson(req);
    const report = await service.syncKnowledge({
      dir: body.dir === undefined ? undefined : String(body.dir),
      dryRun: body.dryRun === true
    });
    return send(res, 200, report);
  }
  if (path === "/knowledge" && method === "GET") {
    return send(res, 200, await service.knowledge(knowledgeScope(await searchScope(q, service))));
  }
  const knowledgeDetail = path.match(/^\/knowledge\/([^/]+)(\/neighbors)?$/);
  if (knowledgeDetail && method === "GET") {
    const id = decodeURIComponent(knowledgeDetail[1]!);
    const opts = knowledgeScope(await searchScope(q, service));
    if (knowledgeDetail[2]) {
      const depth = num(q.depth, 1, 3) ?? 1;
      return send(res, 200, await service.knowledgeNeighbors({ ...opts, id, depth }));
    }
    const page = await service.knowledgePage({ ...opts, id });
    if (!page) return send(res, 404, { error: `unknown knowledge page: ${id}` });
    return send(res, 200, page);
  }

  // Must precede the `/memories/:id` route below: that pattern also matches
  // "/memories/search", so a GET would be read as "fetch the memory whose id is
  // search" and answer 404 — which is exactly what `search` did whenever a
  // daemon was running, while the daemon-less path and `POST` kept working.
  if (/^\/memories\/search$/.test(path)) {
    const p = await parseSearch(method === "GET" ? q : await readJson(req), service);
    if ("status" in p) return send(res, p.status, p.body);
    const result = await service.search(p.data);
    return send(res, 200, wantsEmbedding(q) ? result : { ...result, memories: result.memories.map(stripEmbedding) });
  }

  // Bulk write (ADR-0018). One HTTP round trip, one embed batch, one transaction:
  // importing 10k rows through `POST /memories` is 10k round trips and 10k commits.
  // Before the `/memories/:id` pattern, for the same reason `/memories/search` is.
  if (/^\/memories\/bulk$/.test(path) && method === "POST") {
    const body = await readJson(req);
    const items = Array.isArray(body.items) ? body.items : null;
    if (!items) return send(res, 400, { error: "items must be an array" });
    if (items.length > BULK_LIMIT) return send(res, 413, { error: `too many items (max ${BULK_LIMIT} per request)` });
    const parsed: SaveInput[] = [];
    for (let i = 0; i < items.length; i++) {
      const p = parseCreate(items[i]);
      // A bad row fails the request by index rather than being skipped: a partial
      // import that reports success is how a re-run ends up with duplicates.
      if ("status" in p) return send(res, p.status, { ...p.body, index: i });
      parsed.push(p.data);
    }
    // The bulk gate (ADR-0018 amendment, 2026-11-07): curation runs on every item at
    // zero network cost and rejected or folded rows come back per row in
    // `skipDetails` — `raw: true` excuses every reject except `secret` and except
    // empty text, and skips demotion; exact duplicates fold on every path.
    const { memories, skipped, skipDetails } = await service.saveMany(parsed, {
      reconcile: body.reconcile === true,
      raw: body.raw === true
    });
    return send(res, 201, { saved: memories.length, ids: memories.map((m) => m.id), skipped, skipDetails });
  }

  const mem = new RegExp("^/memories(/[^/]+)?(/supersede)?$").exec(path);
  if (mem) {
    const id = mem[1] ? decodeURIComponent(mem[1].slice(1)) : null;
    if (id && mem[2] && method === "POST") {
      const body = await readJson(req);
      const p = parseCreate(body);
      if ("status" in p) return send(res, p.status, p.body);
      // A replacement belongs in the partition of the memory it replaces. Over the daemon
      // the CLI sends no namespace, so the create default moved the new row out of the
      // partition the old one lived in, while the in-process path kept it.
      if (!str(body.namespace, 200, 1) && !str(body.agent, 200, 1) && !isScope(body.scope)) {
        const old = await service.get(id);
        if (old) p.data.namespace = old.namespace;
      }
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
      if (!found) return send(res, 404, { error: "not found" });
      return send(res, 200, wantsEmbedding(q) ? found : stripEmbedding(found));
    }
    if (id && !mem[2] && method === "DELETE") {
      await service.delete(id);
      return send(res, 200, { ok: true });
    }
    if (!id && method === "POST") {
      const p = parseCreate(await readJson(req));
      if ("status" in p) return send(res, p.status, p.body);
      try {
        return send(res, 201, await service.save(p.data));
      } catch (e) {
        // A curated rejection is a verdict, not a crash: 422 with the class and the
        // one next move, so a client that sent a table row learns to send the fact.
        if (e instanceof CurationRejected) return send(res, 422, { error: e.message, curation: e.verdict });
        throw e;
      }
    }
    if (!id && method === "GET") {
      const listed = await service.list({
        namespace: str(q.namespace, 200, 1) ?? "default:default",
        type: enumOf(q.type, TYPES),
        project: q.project === undefined ? undefined : q.project === null ? null : String(q.project),
        kind: enumOf(q.kind, KINDS),
        includeDeleted: boolish(q.includeDeleted),
        status: enumOf(q.status, STATUSES),
        includeArchived: boolish(q.includeArchived),
        includeDraft: boolish(q.includeDraft),
        limit: num(q.limit, 1, 1000) ?? 50,
        offset: num(q.offset, 0, 1e9) ?? 0,
        query: str(q.q ?? q.query, 2000, 1),
      } as never);
      return send(res, 200, wantsEmbedding(q) ? listed : { ...listed, memories: listed.memories.map(stripEmbedding) });
    }
  }

  if (path === "/extract" && method === "POST") {
    const body = await readJson(req);
    const text = str(body.text ?? body.turnText, 20000, 1);
    if (!text) return send(res, 400, { error: "text required" });
    const { memories, rejected } = await service.extractAndSave(text, str(body.namespace, 200, 1) ?? "default:default");
    return send(res, 200, { extracted: memories.length, rejected, memories });
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
  notFound(res);
}

/** Where each provider's credential is read from. NIM answers to two names. */
const KEY_ENVS = ["NVIDIA_API_KEY", "NIM_API_KEY", "OPENAI_API_KEY"] as const;
const NIM_KEY_ALIASES = ["NVIDIA_API_KEY", "NIM_API_KEY"] as const;

function keyPresent(name: string): boolean {
  return (process.env[name] ?? "").trim() !== "";
}

/** What a configuration resolves to — the `ok` branch of `previewEmbedding`. */
type EmbeddingTarget = Extract<ReturnType<typeof previewEmbedding>, { ok: true }>;

/**
 * Whether saving this key changes what the embedder would be built from. The provider
 * credentials count: `resolveEmbedding` reads them, so a patch carrying one is a change to
 * the switch even though the key itself takes effect immediately everywhere else.
 */
function changesEmbedder(key: string): boolean {
  return (isWritableKey(key) && keyEffect(key) === "restart") || (KEY_ENVS as readonly string[]).includes(key);
}

/** Whether the live embedder already is what `target` describes — the only thing that makes a restart pointless. */
function runsOnTarget(embedder: EmbeddingProvider, target: EmbeddingTarget): boolean {
  return (
    embedder.name === target.provider &&
    embedder.dim === target.dim &&
    (embedder.model ?? null) === target.model
  );
}

/** Is there a difference between what this process serves and what the next start would build? */
function restartPending(service: MemoryService): boolean {
  const preview = previewEmbedding(runtimeEnv());
  return !preview.ok || !runsOnTarget(service.embedder, preview);
}

/**
 * The one path from an HTTP body to settings.json, shared by `/embedding` and `/settings`.
 *
 * Order is the whole point. Shadowed first: the environment wins the merge, so a key
 * already set there makes the write a no-op, and answering "ok" while nothing moved is the
 * silent failure this project keeps writing comments about. Then validation of exactly what
 * the patch touches, then the write — which is never reached by a patch that failed, so a
 * rejected patch leaves both files as they were.
 *
 * `preview` is null when the patch asks nothing of the embedder: the preview exists to
 * prove the switch being written can be built, and a judge knob must stay savable while the
 * embedding configuration is mid-repair. `alwaysPreview` is the exception, and `/embedding`
 * is why: its answer is the target itself, so it holds a preview before it writes whatever
 * keys the patch names.
 */
async function guardSettingsWrite(
  patch: Record<string, string>,
  opts: { alwaysPreview: true },
): Promise<{ ok: true; preview: EmbeddingTarget } | { ok: false; status: number; error: string }>;
async function guardSettingsWrite(
  patch: Record<string, string>,
): Promise<{ ok: true; preview: EmbeddingTarget | null } | { ok: false; status: number; error: string }>;
async function guardSettingsWrite(
  patch: Record<string, string>,
  opts: { alwaysPreview?: boolean } = {},
): Promise<{ ok: true; preview: EmbeddingTarget | null } | { ok: false; status: number; error: string }> {
  const keys = Object.keys(patch);

  // `keyPresent` is the same predicate `GET /embedding` reports as `shadowed`, so the
  // button the panel disables and the write this refuses cannot disagree.
  const shadowed = keys.filter(keyPresent);
  if (shadowed.length > 0) {
    const named = shadowed.length === 1 ? `${shadowed[0]} is` : `${shadowed.join(", ")} are`;
    return {
      ok: false,
      status: 400,
      error: `${named} set in the environment, which overrides settings.json — unset it (or edit .env) before saving here`,
    };
  }

  // Preview first, write second: previewEmbedding is the factory's own resolution, so a
  // patch that previews cleanly cannot fail at the next start.
  let preview: EmbeddingTarget | null = null;
  if (opts.alwaysPreview || keys.some(changesEmbedder)) {
    const candidate = previewEmbedding(mergeEnv(process.env, { ...readSettings(), ...patch } as Settings));
    if (!candidate.ok) return { ok: false, status: 400, error: candidate.error };
    preview = candidate;
  }

  // A stored-but-broken judge key is the quietest failure here: the judge fails open, so
  // every memory would be stored unjudged and nothing would say why. One real call with the
  // candidate key is the only point where the user can be told. An empty value clears the
  // key instead, which has nothing to validate.
  const candidateKey = patch.JEV_API_KEY;
  if (candidateKey !== undefined && candidateKey !== "") {
    const verdict = await validateJevKey(candidateKey);
    if (!verdict.ok) {
      return { ok: false, status: 400, error: `JEV_API_KEY not saved — ${verdict.error ?? "the endpoint rejected it"}` };
    }
  }

  try {
    await writeSettings(patch as Settings);
  } catch (e) {
    return { ok: false, status: 400, error: e instanceof Error ? e.message : "bad settings" };
  }
  return { ok: true, preview };
}

/**
 * Whether a host names this machine. `remoteAddress` is the only thing that can say for a
 * peer: the console has no auth, so `/admin/shutdown` may act for the loopback interface and
 * nobody else. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is what a dual-stack listener reports
 * for a v4 connection; an `Origin` header spells the same machine as a bare `localhost` or
 * as a bracketed `[::1]`.
 *
 * A v4 host only counts as a dotted quad: `/^127\./` also accepted `127.0.0.1.evil.example`,
 * a name a stranger can register and point at itself, which handed the gate back to the page
 * it exists to stop. `isIPv4` parses all four octets, so a `127.` prefix with anything but
 * three octets — or an octet above 255 — is not loopback.
 */
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const mapped = address.startsWith("::ffff:") ? address.slice(7) : address;
  const host = (mapped.startsWith("[") && mapped.endsWith("]") ? mapped.slice(1, -1) : mapped).toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  return isIPv4(host) && host.startsWith("127.");
}

/**
 * The two tiers of the mutation gate, and why there are two.
 *
 * A page in the user's own browser reaches this listener as a loopback peer too, and a
 * bodyless or form-shaped POST is a "simple request": no preflight, so the server sees it
 * before that page has earned anything. What such a page cannot do is lie about `Origin` —
 * a browser attaches it to every cross-origin mutation — so tier A checks exactly that, on
 * every POST/PATCH/DELETE, before any handler runs.
 *
 * Tier A does not require a content type, and deliberately so: the CLI, the pi extension,
 * hooks and adapters send neither an `Origin` nor always a JSON content type, so a global
 * 415 would break clients that are not browsers while stopping nothing a browser can do.
 * The JSON requirement is tier B, and it stays only on the console's own write routes
 * (`/settings`, `/settings/adopt-env`, `/admin/shutdown`, `/embedding`), whose only client
 * is the console and always speaks JSON. An absent `Origin` (curl, the CLI, a test) stays
 * valid, and neither refusal echoes what it rejected.
 */
function foreignOriginProblem(req: IncomingMessage): { status: number; error: string } | null {
  const origin = req.headers.origin;
  if (origin === undefined) return null;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return { status: 403, error: "origin not allowed" };
  }
  return isLoopbackAddress(host) ? null : { status: 403, error: "origin not allowed" };
}

/** Tier B: the console's write routes have no client that speaks anything but JSON. */
function notJsonProblem(req: IncomingMessage): { status: number; error: string } | null {
  const type = String(req.headers["content-type"] ?? "").toLowerCase();
  return type.startsWith("application/json") ? null : { status: 415, error: "content-type must be application/json" };
}

/** The 404 every miss gets — including a route that exists only for the loopback address. */
function notFound(res: ServerResponse) {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
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
  const preview = previewEmbedding(runtimeEnv());
  const target = preview.ok ? { provider: preview.provider, dim: preview.dim, model: preview.model } : null;
  const needsRestart = !preview.ok || !runsOnTarget(service.embedder, preview);

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

// Same real-path comparison as the CLI: a symlinked entry point is how a global install
// reaches this file, and Node resolves `import.meta.url` through the link.
const entry = process.argv[1];
let runsAsMain = false;
try {
  runsAsMain = entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href;
} catch {
  // no usable argv[1] — imported by a test or a runner, which is not the main case.
}
if (runsAsMain) {
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
