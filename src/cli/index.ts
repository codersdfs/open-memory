#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs, flagBool, flagList, flagNumber, flagString, queryText } from "./args.js";
import { MemoryClient, unwrapMemory } from "./http.js";
import { allPartitions, resolveAgent, resolveRequestScope, resolveWriteKey, resolveUser, scopeOfNamespace, type MemoryScope } from "../core/scope.js";
import { resolveDbPath, resolveHome, legacyDbPath, dbExists } from "../core/dbPath.js";
import { MemoryService } from "../core/memoryService.js";
import { createEmbeddingProvider } from "../core/embedding/index.js";
import { runtimeEnv } from "../core/settings.js";
import { reembedAll } from "../core/embedding/reembed.js";
import { appVersion } from "../version.js";
import type { BriefResult, ChainView, Memory, MemoryKind, MemoryType, SearchResult } from "../core/types.js";
import type { ProjectSummary } from "../core/store/interface.js";
import type { KnowledgeIndexView, KnowledgePageView } from "../core/knowledge/view.js";
import type { SyncKnowledgeReport } from "../core/knowledge/sync.js";
import { isKind, KINDS, stripEmbedding } from "../core/types.js";
import { renderEmptySearch } from "../core/retrieval/explain.js";
import { CurationRejected, renderVerdict } from "../core/write/curation.js";

/**
 * `ai-memory` — the one command every agent uses (ADR-0007).
 *
 * Design rules:
 *  - default output is for a human, `--json` is the exact service payload;
 *  - the daemon is used when it answers, otherwise the store is opened in-process;
 *  - every subcommand is usable non-interactively, because hooks call it.
 */

const TYPES = ["episodic", "semantic", "procedural", "working"] as const;
// The same set as core/types.ts STATUSES, which is the same set the store's CHECK accepts.
const STATUSES = ["active", "draft", "archived"] as const;

const USAGE = `ai-memory — shared memory for coding agents

Usage: ai-memory <command> [options] [args]

Memory
  save <text>            --type semantic --kind decision --importance 0.5 --tags a,b --scope private|shared
  search <query>         --k 5 --threshold 0.35 --budget 800 --scope private|shared --type t --kind k --project p
  brief                  what this project already decided: conventions, decisions, gotchas, open, recent
                         --budget 600 --since 14 --project p
  get <id>               print one memory; --history walks the whole supersede chain
                         plus the write history (ADR-0045) — never part of search
  list                   --limit 20 --type t --kind k --project p --status active
  forget <id...>         soft delete (kept, restorable)
  restore <id...>        undo a forget
  supersede <id> <text>  replace one memory with a newer one
  meta <id>              --status active|draft|archived --pin 0|1
  stats                  counts per type for the resolved scope(s)
  decay                  apply lifecycle decay / pruning
  triage                 retroactive curation over the stock (ADR-0040 amendment):
                         dry-run diff by default — would archive / would demote /
                         merge candidates; --apply writes. Never deletes.
  extract <text>         pull candidate memories out of free text and save them
  reembed                rewrite every stored vector with the current embedder
  knowledge              ls | show <id> | neighbors <id> | sync | link <from> <to>
                         markdown pages as linked knowledge: --dir <vault> --depth 1 --dry-run
  project list | init | rename | forget
                         manage projects: init [slug] [--note "..."], rename <from> <to> [--merge],
                         forget <slug> [--detach] (default forget soft-deletes, restorable)

Setup & introspection
  setup                  create the memory home dir; --copy-db migrates the old store; --link registers agents
  db info                which store would be used, and why
  db compact             VACUUM the store file: give back what soft delete kept
  daemon restart         stop the running daemon and start a fresh one
  principal              the identity this machine's daemon serves (ADR-0049):
                         status (default) | recover --from-db — re-bind the user
                         segment from the store's own partitions after a lost key |
                         reveal — print the token (the console's unlock gate takes it)
  mcp                    run the MCP stdio server (agents spawn this)
  inject                 read a hook payload on stdin, print context for this turn
  agent <sub>            init | list | status | doctor | link | unlink (per-agent integration)
  agent add <id>         --mcp-file <path> [--json-path mcpServers] [--env K=V] [--instructions <f>]
  agent remove <id>      drop a declared agent (its config file stays; use agent unlink)
  agent specs            agents you declared in the memory home's agents.json
  context refresh        rewrite the managed instructions block for linked agents
  import <sub>           one-shot import from the other agents' files (see: import --help)

Global options
  --json                 machine-readable output (stable shape)
  --agent <id>           claude | codex | dsh | pi | ... (default: detect, else "default")
  --user <name>          override the shared-layer user segment
  --scope <private|shared>
  --namespace <key>      exact partition; overrides --scope
  --db <path>            store path (overrides MEMORY_DB_PATH)
  --server <url>         daemon base URL (default http://127.0.0.1:PORT)
  --no-daemon            skip the daemon and open the store in-process
  --help
`;

interface Ctx {
  json: boolean;
  argv: string[];
  out: (s: string) => void;
  err: (s: string) => void;
}

function printUsage(ctx: Ctx): void {
  ctx.out(USAGE);
}

/** Lazy service: opened in-process only when the daemon is not used. */
class Runner {
  svc: MemoryService | null = null;
  constructor(private opts: { db?: string; noDaemon: boolean; server?: string }) {}
  async service(): Promise<MemoryService> {
    if (this.svc) return this.svc;
    const s = new MemoryService({ dbPath: this.opts.db });
    await s.init();
    this.svc = s;
    return s;
  }
  client(): MemoryClient {
    return new MemoryClient(this.opts.server);
  }
  private static warnedStaleDaemon = false;

  async useDaemon(): Promise<boolean> {
    if (this.opts.noDaemon) return false;
    const health = await this.client().health();
    if (!health?.ok) return false;
    // Version, not just reachability. A daemon left running from an older install
    // answers /health happily while serving the old build — after the fix to GET
    // /memories/search, exactly that daemon made every search answer 404. Falling
    // back to the in-process store keeps the command working; the warning says why.
    const mine = await appVersion();
    if (health.version !== mine) {
      if (!Runner.warnedStaleDaemon) {
        Runner.warnedStaleDaemon = true;
        console.error(
          `ai-memory: ignoring the running daemon (version ${health.version ?? "unknown"}, this CLI is ${mine}) — ` +
          "it would serve the old code. Restart it with `ai-memory daemon restart`, or pass --no-daemon to silence this.",
        );
      }
      return false;
    }
    return true;
  }

  async close(): Promise<void> {
    if (this.svc) await this.svc.close();
  }
}

function renderMemories(result: SearchResult, ctx: Ctx): void {
  if (result.memories.length === 0) {
    // ADR-0037: the reason rides on the empty result, so the CLI prints it instead of
    // the bare one-liner that taught the caller to reword and retry.
    ctx.out(renderEmptySearch(result.diagnostics));
    return;
  }
  for (const m of result.memories) {
    const score = typeof m.score === "number" ? m.score.toFixed(3) : "-";
    ctx.out(`[${m.id}] (${m.type}/${m.namespace}, score ${score})`);
    ctx.out(`  ${m.text.replace(/\s+/g, " ").trim()}`);
    if (m.explain) {
      const e = m.explain;
      const parts = ["vector", "bm25", "recency", "strength"].map(
        (k) => `${k} ${e.weighted[k as keyof typeof e.weighted].toFixed(3)}`
      );
      if (e.pinBoost) parts.push(`pin ${e.pinBoost.toFixed(3)}`);
      ctx.out(`  why: ${parts.join(" + ")} = ${e.final.toFixed(3)}`);
    }
  }
  ctx.out(`→ ${result.memories.length} memories, ${result.tokensUsed} tokens${result.truncated ? " (truncated)" : ""}`);
}

async function cmdSave(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>): Promise<number> {
  const text = queryText(a, "text") ?? a.positionals.join(" ").trim();
  if (!text) {
    ctx.err("save: text required (ai-memory save \"...\" or --text \"...\")");
    return 2;
  }
  const type = (flagString(a, "type") ?? "semantic") as MemoryType;
  if (!TYPES.includes(type)) {
    ctx.err(`save: --type must be one of ${TYPES.join(", ")}`);
    return 2;
  }
  const scope = flagString(a, "scope") as MemoryScope | undefined;
  const agent = flagString(a, "agent");
  const kindFlag = flagString(a, "kind");
  if (kindFlag !== undefined && !isKind(kindFlag)) {
    // A typo here must not become a "note" that never survives 30 days: kind decides
    // retention, so an unknown one is an error, not a hint.
    ctx.err(`save: --kind must be one of ${KINDS.join(", ")}`);
    return 2;
  }
  const projectFlag = flagString(a, "project");
  const payload = {
    text,
    type,
    kind: kindFlag,
    project: projectFlag,
    namespace: flagString(a, "namespace"),
    agent,
    scope: scope === "shared" ? ("shared" as const) : scope === "private" ? ("private" as const) : undefined,
    importance: flagNumber(a, "importance"),
    tags: flagList(a, "tags"),
    source: flagString(a, "source")
  };

  if (await r.useDaemon()) {
    const res = await r.client().post<unknown>("/memories", payload);
    if (!res.ok) {
      ctx.err(`save: ${res.error}`);
      return 1;
    }
    const mem = unwrapMemory<Memory>(res.data);
    ctx.out(ctx.json ? JSON.stringify(mem, null, 2) : `saved ${mem.id} → ${mem.namespace}`);
    return 0;
  }

  const svc = await r.service();
  let mem: Memory;
  try {
    mem = await svc.save({
      text,
      type,
      kind: kindFlag as MemoryKind | undefined,
      project: projectFlag,
      namespace: payload.namespace ?? resolveWriteKey({ agent, scope: payload.scope }),
      importance: payload.importance,
      tags: payload.tags,
      source: payload.source
    });
  } catch (e) {
    // The advice is the output: "not stored (table-row): store the fact the row
    // states, in a sentence" is a usable answer, "Error: ..." is not.
    if (e instanceof CurationRejected) {
      ctx.err(`save: ${renderVerdict(e.verdict)}`);
      return 1;
    }
    throw e;
  }
  ctx.out(ctx.json ? JSON.stringify(mem, null, 2) : `saved ${mem.id} → ${mem.namespace}`);
  return 0;
}

/**
 * Partitions for this call. `--all` means "everything this user owns", which only the
 * store can enumerate; everything else is the pure resolution. An explicit
 * `--namespace` still wins over both, and `--all` never goes through the daemon: it
 * takes one namespace per request and has no way to sweep, so it would silently
 * answer from a single partition.
 */
async function resolveNamespaces(
  r: Runner,
  a: ReturnType<typeof parseArgs>
): Promise<{ namespaces: string[]; scopes: MemoryScope[] }> {
  const namespace = flagString(a, "namespace");
  if (flagBool(a, "all") && !namespace) {
    const namespaces = await allPartitions((await r.service()).store, flagString(a, "user"));
    return { namespaces, scopes: [...new Set(namespaces.map(scopeOfNamespace))] };
  }
  // `--all` was already expanded above, where the store is reachable; the pure resolver
  // no longer takes it, because "every partition this user owns" is a fact about the
  // store and not about the request (see `resolveReadScope` in core/scope.ts).
  return resolveRequestScope({
    namespace,
    agent: flagString(a, "agent"),
    scope: flagString(a, "scope") as MemoryScope | undefined
  });
}

/**
 * Rewrite every stored vector with the configured provider.
 *
 * Deliberately outside the daemon and outside `MemoryService`: the dimension guard in
 * `MemoryService.init` refuses to serve a store whose vectors do not match the
 * provider, and this command exists to repair exactly that store. Routing it through
 * either layer would make the escape hatch unusable in the one situation it is for.
 */
async function cmdReembed(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>): Promise<number> {
  const { SqliteVectorStore } = await import("../core/store/sqlite.js");
  // Merged env, or the CLI would migrate with a different provider than the console
  // says it would.
  const embedder = createEmbeddingProvider(runtimeEnv());
  const store = new SqliteVectorStore(resolveDbPath(flagString(a, "db")));
  await store.init();
  const previousDim = await store.storedDim();
  const dryRun = flagBool(a, "dry-run");
  if (!ctx.json) {
    ctx.out(
      `provider ${embedder.name} (${embedder.dim}d); store holds ${previousDim ?? "nothing"}${
        dryRun ? " — dry run, nothing written" : ""
      }`
    );
  }
  const res = await reembedAll(store, embedder, { dryRun });
  store.close();
  if (ctx.json) {
    ctx.out(JSON.stringify({ ...res, dim: embedder.dim, previousDim }, null, 2));
  } else {
    ctx.out(
      `${res.rewritten} of ${res.scanned} vectors rewritten across ${res.partitions} partitions`
    );
    if (res.failed.length) {
      ctx.err(`${res.failed.length} failed, e.g. ${res.failed[0]!.id}: ${res.failed[0]!.error}`);
    }
  }
  return res.failed.length ? 1 : 0;
}

async function cmdSearch(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>): Promise<number> {
  const query = queryText(a, "query");
  if (!query) {
    ctx.err("search: query required");
    return 2;
  }
  const agent = flagString(a, "agent");
  const namespace = flagString(a, "namespace");
  const scope = flagString(a, "scope") as MemoryScope | undefined;
  const k = flagNumber(a, "k") ?? (flagNumber(a, "limit") ?? 5);
  const budgetTokens = flagNumber(a, "budget") ?? 800;
  const threshold = flagNumber(a, "threshold") ?? 0.35;
  const type = flagString(a, "type") as MemoryType | undefined;
  const kind = flagString(a, "kind") as MemoryKind | undefined;
  if (kind !== undefined && !isKind(kind)) {
    ctx.err(`search: --kind must be one of ${KINDS.join(", ")}`);
    return 2;
  }
  const project = flagString(a, "project");
  // R1: opt-in, because the default answer is meant to be read, not debugged.
  const explain = flagBool(a, "explain");

  if (!flagBool(a, "all") && (await r.useDaemon())) {
    // Resolve the partitions here, where the caller's agent and user are known, and send
    // the result: the daemon has no idea whose store this is. `agent` and `scope` used
    // to be sent instead, and the server never read them, so a bare `search` against a
    // running daemon asked about `default:default` and answered "no memories matched"
    // for rows sitting in the caller's own partition.
    const { namespaces } = await resolveNamespaces(r, a);
    const res = await r.client().get<SearchResult>(
      "/memories/search" +
        MemoryClient.query({ query, namespaces: namespaces.join(","), k, budgetTokens, threshold, type, kind, project, explain })
    );
    if (!res.ok) {
      ctx.err(`search: ${res.error}`);
      return 1;
    }
    if (ctx.json) ctx.out(JSON.stringify(res.data, null, 2));
    else renderMemories(res.data, ctx);
    return 0;
  }

  const { namespaces } = await resolveNamespaces(r, a);
  const svc = await r.service();
  const result = await svc.search({
    query,
    namespaces,
    agent: resolveAgent(agent),
    type,
    kind,
    project,
    k,
    budgetTokens,
    threshold,
    explain
  });
  if (ctx.json) ctx.out(JSON.stringify({ ...result, memories: result.memories.map(stripEmbedding) }, null, 2));
  else renderMemories(result, ctx);
  return 0;
}

async function cmdGet(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>): Promise<number> {
  const id = a.positionals[0] ?? flagString(a, "id");
  if (!id) {
    ctx.err("get: id required");
    return 2;
  }
  // P6 (ADR-0045): --history walks the whole supersede chain and prints the row's
  // write history. Explicit, never a search side effect — a chain the caller did
  // not ask for is context the caller must pay for reading.
  const history = flagBool(a, "history");
  if (await r.useDaemon()) {
    const res = await r.client().get<unknown>(`/memories/${encodeURIComponent(id)}${history ? "?drill=1" : ""}`);
    if (!res.ok) {
      ctx.err(`get: ${res.error}`);
      return 1;
    }
    if (history) {
      const view = unwrapChainView(res.data);
      if (!view.memory && view.events.length === 0) {
        ctx.err(`get: no memory ${id}`);
        return 1;
      }
      ctx.out(ctx.json ? JSON.stringify(view, null, 2) : renderChainView(view, ctx));
      return 0;
    }
    let mem: Memory;
    try {
      mem = unwrapMemory<Memory>(res.data);
    } catch {
      ctx.err(`get: no memory ${id}`);
      return 1;
    }
    ctx.out(ctx.json ? JSON.stringify(mem, null, 2) : renderOne(mem));
    return 0;
  }
  const svc = await r.service();
  if (history) {
    const view = await svc.drill(id);
    if (!view.memory && view.events.length === 0) {
      ctx.err(`get: no memory ${id}`);
      return 1;
    }
    ctx.out(ctx.json ? JSON.stringify(view, null, 2) : renderChainView(view, ctx));
    return 0;
  }
  const mem = (await svc.get(id)) ?? null;
  if (!mem) {
    ctx.err(`get: no memory ${id}`);
    return 1;
  }
  ctx.out(ctx.json ? JSON.stringify(mem, null, 2) : renderOne(mem));
  return 0;
}

/** The drill payload over the wire is the ChainView itself (no envelope to unwrap). */
function unwrapChainView(data: unknown): ChainView {
  const v = data as ChainView;
  if (!v || typeof v !== "object" || !Array.isArray(v.ancestors) || !Array.isArray(v.events)) {
    throw new Error("unexpected drill response");
  }
  return v;
}

function renderChainView(view: ChainView, ctx: Ctx): string {
  const lines: string[] = [];
  if (view.memory) lines.push(renderOne(view.memory));
  else lines.push(`${"(purged)"}: the row is gone; its history survived it (ADR-0045)`);
  const brief = (m: Memory, role: string) =>
    `${role} ${m.id} [${m.isDeleted ? "tombstone" : m.status}] ${m.text.replace(/\s+/g, " ").slice(0, 100)}${m.text.length > 100 ? "…" : ""}`;
  for (const a of view.ancestors) lines.push(`  ← ${brief(a, "superseded by this row:")}`);
  for (const s of view.successors) lines.push(`  → ${brief(s, "supersedes this row:")}`);
  if (view.events.length > 0) {
    lines.push("  events:");
    for (const e of view.events) {
      const what = [e.reason, e.model].filter(Boolean).join(" / ");
      lines.push(
        `    ${new Date(e.at).toISOString()} ${e.event}${what ? ` (${what})` : ""}${e.newValue ? ` — ${e.newValue.replace(/\s+/g, " ").slice(0, 80)}` : ""}`
      );
    }
  }
  void ctx;
  return lines.join("\n");
}

function renderOne(m: Memory): string {
  return [
    `${m.id} (${m.type}/${m.namespace})`,
    `  status: ${m.status}${m.pin ? " pinned" : ""}${m.isDeleted ? " deleted" : ""}`,
    `  importance: ${m.importance}`,
    `  tags: ${(m.tags ?? []).join(", ") || "-"}`,
    `  source: ${m.source ?? "-"}`,
    `  created: ${new Date(m.createdAt).toISOString()}`,
    `  text: ${m.text}`
  ].join("\n");
}

async function cmdList(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>): Promise<number> {
  const namespace = flagString(a, "namespace");
  const agent = flagString(a, "agent");
  const scope = flagString(a, "scope") as MemoryScope | undefined;
  const limit = flagNumber(a, "limit") ?? 20;
  const type = flagString(a, "type") as MemoryType | undefined;
  const kind = flagString(a, "kind");
  const project = flagString(a, "project");
  const status = flagString(a, "status");

  if (!flagBool(a, "all") && (await r.useDaemon())) {
    const res = await r.client().get<{ memories: Memory[]; total: number }>(
      "/memories" +
        MemoryClient.query({ namespace, agent, scope, limit, type, kind, project, status })
    );
    if (!res.ok) {
      ctx.err(`list: ${res.error}`);
      return 1;
    }
    if (ctx.json) ctx.out(JSON.stringify(res.data, null, 2));
    else {
      for (const m of res.data.memories) ctx.out(`[${m.id}] (${m.type}/${m.namespace}) ${m.text.replace(/\s+/g, " ").slice(0, 120)}`);
      ctx.out(`→ ${res.data.memories.length} of ${res.data.total}`);
    }
    return 0;
  }

  const { namespaces } = await resolveNamespaces(r, a);
  const svc = await r.service();
  const all: Memory[] = [];
  let total = 0;
  for (const ns of namespaces) {
    const page = await svc.list({ namespace: ns, type, kind, project, limit, status: status as never });
    all.push(...page.memories);
    total += page.total;
  }
  if (ctx.json) ctx.out(JSON.stringify({ memories: all.map(stripEmbedding), total, scopes: namespaces }, null, 2));
  else {
    for (const m of all) ctx.out(`[${m.id}] (${m.type}/${m.namespace}) ${m.text.replace(/\s+/g, " ").slice(0, 120)}`);
    ctx.out(`→ ${all.length} of ${total}`);
  }
  return 0;
}

async function cmdForget(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>, restore = false): Promise<number> {
  const ids = [...a.positionals, ...(flagString(a, "id") ? [flagString(a, "id")!] : [])].filter(Boolean);
  if (ids.length === 0) {
    ctx.err(`${restore ? "restore" : "forget"}: at least one id required`);
    return 2;
  }
  const daemon = await r.useDaemon();
  const svc = daemon ? null : await r.service();
  let failed = 0;
  for (const id of ids) {
    if (daemon) {
      const res = restore
        ? await r.client().patch<unknown>(`/memories/${encodeURIComponent(id)}`, { isDeleted: 0 })
        : await r.client().del<unknown>(`/memories/${encodeURIComponent(id)}`);
      if (!res.ok) {
        ctx.err(`${restore ? "restore" : "forget"} ${id}: ${res.error}`);
        failed++;
      } else if (!ctx.json) ctx.out(`${restore ? "restored" : "forgot"} ${id}`);
    } else {
      try {
        if (restore) await svc!.updateMeta(id, { isDeleted: 0 });
        else await svc!.delete(id);
        if (!ctx.json) ctx.out(`${restore ? "restored" : "forgot"} ${id}`);
      } catch (err) {
        ctx.err(`${restore ? "restore" : "forget"} ${id}: ${(err as Error).message}`);
        failed++;
      }
    }
  }
  if (ctx.json) ctx.out(JSON.stringify({ ok: failed === 0, ids, failed }));
  return failed === 0 ? 0 : 1;
}

async function cmdSupersede(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>): Promise<number> {
  const id = a.positionals[0];
  const text = a.positionals.slice(1).join(" ").trim() || flagString(a, "text");
  if (!id || !text) {
    ctx.err("supersede: usage ai-memory supersede <id> <new text>");
    return 2;
  }
  const type = (flagString(a, "type") ?? "semantic") as MemoryType;
  if (await r.useDaemon()) {
    const res = await r.client().post<unknown>(`/memories/${encodeURIComponent(id)}/supersede`, { text, type, agent: flagString(a, "agent"), scope: flagString(a, "scope") });
    if (!res.ok) {
      ctx.err(`supersede: ${res.error}`);
      return 1;
    }
    const superseded = unwrapMemory<Memory>(res.data);
    ctx.out(ctx.json ? JSON.stringify(superseded, null, 2) : `superseded ${id} → ${superseded.id}`);
    return 0;
  }
  const svc = await r.service();
  const old = await svc.get(id);
  if (!old) {
    ctx.err(`supersede: no memory ${id}`);
    return 1;
  }
  const created = await svc.supersede(id, {
    namespace: old.namespace,
    type,
    text,
    tags: old.tags,
    source: old.source,
    importance: old.importance
  });
  ctx.out(ctx.json ? JSON.stringify(created, null, 2) : `superseded ${id} → ${created.id}`);
  return 0;
}

async function cmdMeta(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>): Promise<number> {
  const id = a.positionals[0];
  if (!id) {
    ctx.err("meta: id required");
    return 2;
  }
  const status = flagString(a, "status");
  if (status && !STATUSES.includes(status as never)) {
    ctx.err(`meta: --status must be one of ${STATUSES.join(", ")}`);
    return 2;
  }
  const pin = flagNumber(a, "pin");
  const patch: Record<string, unknown> = {};
  if (status) patch.status = status;
  if (pin !== undefined) patch.pin = pin ? 1 : 0;

  if (await r.useDaemon()) {
    const res = await r.client().patch<unknown>(`/memories/${encodeURIComponent(id)}`, patch);
    if (!res.ok) {
      ctx.err(`meta: ${res.error}`);
      return 1;
    }
    ctx.out(ctx.json ? JSON.stringify(unwrapMemory<Memory>(res.data), null, 2) : `updated ${id}`);
    return 0;
  }
  const svc = await r.service();
  const updated = await svc.updateMeta(id, patch as { status?: string; pin?: number });
  if (!updated) {
    ctx.err(`meta: no memory ${id}`);
    return 1;
  }
  ctx.out(ctx.json ? JSON.stringify(updated, null, 2) : `updated ${id}`);
  return 0;
}

async function cmdStats(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>): Promise<number> {
  const namespace = flagString(a, "namespace");
  const agent = flagString(a, "agent");
  const scope = flagString(a, "scope") as MemoryScope | undefined;
  const { namespaces, scopes } = await resolveNamespaces(r, a);

  if (!flagBool(a, "all") && (await r.useDaemon())) {
    const res = await r.client().get<Record<string, unknown>>(
      "/stats" + MemoryClient.query({ namespace: namespaces[0], agent, scope })
    );
    if (!res.ok) {
      ctx.err(`stats: ${res.error}`);
      return 1;
    }
    ctx.out(ctx.json ? JSON.stringify({ ...res.data, scopes }, null, 2) : `stats: ${JSON.stringify(res.data)}`);
    return 0;
  }

  const svc = await r.service();
  const perScope: Record<string, unknown> = {};
  for (const ns of namespaces) {
    const byType: Record<string, number> = {};
    for (const t of TYPES) byType[t] = (await svc.list({ namespace: ns, type: t, limit: 1 })).total;
    const total = (await svc.list({ namespace: ns, limit: 1 })).total;
    perScope[ns] = { total, byType };
  }
  const payload = { scopes: namespaces, perScope, embedding: svc.embedder.name, dim: svc.embedder.dim };
  if (ctx.json) ctx.out(JSON.stringify(payload, null, 2));
  else {
    for (const ns of namespaces) {
      const s = perScope[ns] as { total: number; byType: Record<string, number> };
      ctx.out(`${ns}: ${s.total} memories — ${Object.entries(s.byType).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    }
    ctx.out(`embedding: ${svc.embedder.name} (${svc.embedder.dim}d)`);
  }
  return 0;
}

async function cmdBrief(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>): Promise<number> {
  const project = flagString(a, "project");
  const budgetTokens = flagNumber(a, "budget") ?? 600;
  const sinceDays = flagNumber(a, "since") ?? 14;
  const { namespaces } = await resolveNamespaces(r, a);

  if (!flagBool(a, "all") && (await r.useDaemon())) {
    const res = await r.client().get<BriefResult>(
      "/brief" +
        MemoryClient.query({ namespaces: namespaces.join(","), project, budgetTokens, sinceDays })
    );
    if (!res.ok) {
      // A daemon started before this route existed answers 404 "not found". Falling back
      // to an in-process read is right here: a brief is read-only and cheap, and refusing
      // to print one until the operator restarts a daemon is a worse failure.
      if (!/not found/i.test(res.error)) {
        ctx.err(`brief: ${res.error}`);
        return 1;
      }
    } else {
      if (ctx.json) ctx.out(JSON.stringify(res.data, null, 2));
      else {
        ctx.out(res.data.text);
        ctx.out(`\n→ ${res.data.tokensUsed}/${res.data.budgetTokens} tokens across ${namespaces.join(", ")}`);
      }
      return 0;
    }
  }

  const svc = await r.service();
  const brief = await svc.brief({
    namespaces,
    project,
    budgetTokens,
    sinceMs: sinceDays * 24 * 60 * 60 * 1000
  });
  if (ctx.json) ctx.out(JSON.stringify(brief, null, 2));
  else {
    ctx.out(brief.text);
    ctx.out(`\n→ ${brief.tokensUsed}/${brief.budgetTokens} tokens across ${namespaces.join(", ")}`);
  }
  return 0;
}

async function cmdDecay(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>): Promise<number> {
  if (await r.useDaemon()) {
    const res = await r.client().post<unknown>("/decay", {});
    if (!res.ok) {
      ctx.err(`decay: ${res.error}`);
      return 1;
    }
    ctx.out(ctx.json ? JSON.stringify(res.data, null, 2) : `decay: ${JSON.stringify(res.data)}`);
    return 0;
  }
  const svc = await r.service();
  const { runDecay } = await import("../core/lifecycle/decay.js");
  // Number-shaped return kept for scripts; the default pass archives rather than deletes.
  const affected = await runDecay(svc.store as never);
  ctx.out(ctx.json ? JSON.stringify({ affected }, null, 2) : `decay: ${affected} row(s) archived or pruned`);
  return 0;
}

/**
 * `ai-memory triage` — the retroactive half of the write contract (ADR-0040
 * amendment 2026-11-08, P3 of the memory-systems research). Diff first: the
 * default run writes nothing, `--apply` is the only mode that touches rows, and
 * nothing here can hard-delete — junk leaves the pools by a status flip.
 *
 * In-process only, like `reembed` and `db compact`: there is no daemon route for
 * it, and a whole-store sweep belongs to the operator's process. The daemon caveat
 * is printed after an apply because the cache noteChange expired lives in *this*
 * process, not the daemon's.
 */
async function cmdTriage(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>): Promise<number> {
  const svc = await r.service();
  const { runTriage, renderTriageReport } = await import("../core/lifecycle/triage.js");
  const report = await runTriage(svc.store as never, { apply: flagBool(a, "apply") === true });
  if (ctx.json) {
    ctx.out(JSON.stringify(report, null, 2));
  } else {
    ctx.out(renderTriageReport(report));
    if (report.applied && report.archives.length + report.demotions.length > 0) {
      ctx.err(
        "note: a daemon serving this store keeps its own decoded partitions — restart it " +
        "(`ai-memory daemon restart`) so it serves the triaged rows, not cached ones."
      );
    }
  }
  return 0;
}

async function cmdExtract(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>): Promise<number> {
  const text = queryText(a, "text") ?? a.positionals.join(" ").trim();
  if (!text) {
    ctx.err("extract: text required");
    return 2;
  }
  const agent = flagString(a, "agent");
  const namespace = flagString(a, "namespace") ?? resolveWriteKey({ agent, scope: flagString(a, "scope") as MemoryScope | undefined });
  if (await r.useDaemon()) {
    const res = await r.client().post<{ extracted: number; rejected: number; memories: Memory[] }>("/extract", { text, namespace });
    if (!res.ok) {
      ctx.err(`extract: ${res.error}`);
      return 1;
    }
    const rejected = res.data.rejected ?? 0;
    ctx.out(ctx.json ? JSON.stringify(res.data, null, 2) : `extracted ${res.data.extracted}${rejected ? `, rejected ${rejected}` : ""}`);
    return 0;
  }
  const svc = await r.service();
  const { memories, rejected } = await svc.extractAndSave(text, namespace);
  const out = { extracted: memories.length, rejected, memories };
  ctx.out(ctx.json ? JSON.stringify(out, null, 2) : `extracted ${memories.length}${rejected ? `, rejected ${rejected}` : ""}`);
  return 0;
}

async function cmdSetup(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>): Promise<number> {
  const home = resolveHome(flagString(a, "home"));
  const target = resolveDbPath(flagString(a, "db"));
  const legacy = legacyDbPath();
  const steps: string[] = [];

  const { mkdirSync, copyFileSync } = await import("node:fs");
  mkdirSync(home, { recursive: true });
  steps.push(`home: ${home}`);

  if (dbExists(target)) {
    steps.push(`store already exists: ${target} (left untouched)`);
  } else if (flagBool(a, "copy-db") && dbExists(legacy)) {
    copyFileSync(legacy, target);
    steps.push(`copied legacy store: ${legacy} → ${target}`);
  } else {
    steps.push(`store will be created on first write: ${target}`);
  }

  steps.push("next: ai-memory agent link --write   (registers MCP + context for each agent)");
  ctx.out(ctx.json ? JSON.stringify({ home, dbPath: target, legacy: dbExists(legacy) ? legacy : null, steps }, null, 2) : steps.join("\n"));

  if (flagBool(a, "link")) {
    // The store is set up; linking is the step everyone forgets. The one command that
    // exists to set this up can also do it — dry run unless --write, like `agent link`.
    const { runAgentCommand } = await import("../adapters/cli.js");
    return await runAgentCommand(["link"], { write: flagBool(a, "write") }, ctx);
  }
  return 0;
}

async function cmdKnowledge(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>): Promise<number> {
  const which = a.positionals[0] ?? "ls";
  const id = a.positionals[1];
  const { namespaces } = await resolveNamespaces(r, a);
  const onDaemon = !flagBool(a, "all") && (await r.useDaemon());

  if (which === "sync") {
    const dir = flagString(a, "dir");
    const dryRun = flagBool(a, "dry-run");
    if (onDaemon) {
      const res = await r.client().post<SyncKnowledgeReport>("/knowledge/sync", { dir, dryRun });
      if (res.ok) {
        printSync(ctx, res.data);
        return 0;
      }
      // A daemon older than this route answers 404; syncing in-process is safe (the
      // write path is the same code) and beats telling the operator to restart.
      if (!/not found/i.test(res.error)) {
        ctx.err(`knowledge sync: ${res.error}`);
        return 1;
      }
    }
    const svc = await r.service();
    printSync(ctx, await svc.syncKnowledge({ dir, dryRun }));
    return 0;
  }

  const query = MemoryClient.query({ namespaces: namespaces.join(",") });
  if (which === "ls") {
    const index = onDaemon
      ? await r.client().get<KnowledgeIndexView>(`/knowledge${query}`)
      : null;
    if (index && !index.ok && !/not found/i.test(index.error)) {
      ctx.err(`knowledge: ${index.error}`);
      return 1;
    }
    if (index?.ok) return printIndex(ctx, index.data);
    return printIndex(ctx, await (await r.service()).knowledge({ namespaces }));
  }

  if (which === "show" || which === "neighbors") {
    if (!id) {
      ctx.err(`knowledge ${which}: page id required`);
      return 2;
    }
    const path = which === "show" ? `/knowledge/${encodeURIComponent(id)}` : `/knowledge/${encodeURIComponent(id)}/neighbors${query}`;
    const res = onDaemon ? await r.client().get<KnowledgePageView | { id: string; neighbors: KnowledgePageView[] }>(path) : null;
    if (res && !res.ok && !/not found/i.test(res.error)) {
      ctx.err(`knowledge ${which}: ${res.error}`);
      return 1;
    }
    if (res?.ok) {
      if (which === "show") return printPage(ctx, res.data as KnowledgePageView);
      const n = res.data as { id: string; neighbors: KnowledgePageView[] };
      return printNeighbors(ctx, n.id, n.neighbors);
    }
    const svc = await r.service();
    if (which === "show") {
      const page = await svc.knowledgePage({ namespaces, id });
      if (!page) {
        ctx.err(`knowledge show: unknown page "${id}"`);
        return 1;
      }
      return printPage(ctx, page);
    }
    const result = await svc.knowledgeNeighbors({ namespaces, id, depth: flagNumber(a, "depth") ?? 1 });
    return printNeighbors(ctx, result.id, result.neighbors);
  }

  if (which === "link") {
    const to = a.positionals[2];
    if (!id || !to) {
      ctx.err("knowledge link: <from> <to> required");
      return 2;
    }
    const { addLink } = await import("../core/graph.js");
    const { vaultDir } = await import("../core/graph.js");
    const file = await addLink(flagString(a, "dir") ?? vaultDir(), id, to);
    // The file is the truth, so re-index rather than writing a row by hand.
    const svc = await r.service();
    const report = await svc.syncKnowledge({ dir: flagString(a, "dir") });
    if (ctx.json) ctx.out(JSON.stringify({ linked: file, report }, null, 2));
    else {
      ctx.out(`linked ${id} → ${to} in ${file}`);
      printSync(ctx, report);
    }
    return 0;
  }

  ctx.err(`knowledge: unknown subcommand "${which}" (expected: ls | show | neighbors | sync | link)`);
  return 2;
}

function printSync(ctx: Ctx, report: SyncKnowledgeReport): void {
  if (ctx.json) {
    ctx.out(JSON.stringify(report, null, 2));
    return;
  }
  const head = report.dryRun ? "dry run — nothing written" : "synced";
  ctx.out(
    `${head}: ${report.pages} page(s), ${report.sections} section(s) → ` +
      `${report.inserted} new, ${report.updated} updated, ${report.unchanged} unchanged, ` +
      `${report.removed} removed, ${report.adopted} adopted, ${report.dangling} dangling link(s)`
  );
}

function printIndex(ctx: Ctx, index: KnowledgeIndexView): number {
  if (ctx.json) {
    ctx.out(JSON.stringify(index, null, 2));
    return 0;
  }
  if (index.pages.length === 0) {
    ctx.out("no knowledge pages indexed — run: ai-memory knowledge sync");
    return 0;
  }
  for (const page of index.pages) {
    ctx.out(`- ${page.id}  ${page.title}  (${page.sections} sections, ${page.links}→ ${page.backlinks}←)`);
  }
  if (index.dangling.length > 0) {
    ctx.out(`dangling: ${index.dangling.map((e) => `${e.from}→${e.target}`).join(", ")}`);
  }
  return 0;
}

function printPage(ctx: Ctx, page: KnowledgePageView): number {
  if (ctx.json) {
    ctx.out(JSON.stringify(page, null, 2));
    return 0;
  }
  ctx.out(`${page.id}  ${page.title}${page.project ? `  [${page.project}]` : ""}`);
  for (const section of page.sections) {
    ctx.out(`  ${section.key}${section.heading ? `  ${section.heading}` : ""}  (${section.chars} chars)`);
  }
  if (page.links.length > 0) ctx.out(`links:     ${page.links.map((e) => e.target).join(", ")}`);
  if (page.backlinks.length > 0) ctx.out(`backlinks: ${page.backlinks.map((e) => e.from).join(", ")}`);
  return 0;
}

function printNeighbors(ctx: Ctx, id: string, neighbors: KnowledgePageView[]): number {
  if (ctx.json) {
    ctx.out(JSON.stringify({ id, neighbors }, null, 2));
    return 0;
  }
  if (neighbors.length === 0) ctx.out(`${id} has no neighbours`);
  else for (const page of neighbors) ctx.out(`- ${page.id}  ${page.title}`);
  return 0;
}

/**
 * `ai-memory project` — explicit management for the dimension ADR-0020 added.
 *
 * A project comes into existence on its first write and dies when its rows do;
 * these subcommands only make that lifecycle visible and reversible. Cross-partition
 * by nature (a project spans every agent that wrote into it), so unlike the row
 * commands there is no `--all` question here: the answer is always the whole store.
 */
async function cmdProject(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>): Promise<number> {
  const sub = a.positionals[0] ?? "list";
  const onDaemon = await r.useDaemon();
  // A daemon older than these routes answers 404 "not found"; the version gate above
  // already sends a stale daemon to the in-process path, so reaching a 404 here means
  // the daemon answered for a build that had the route gap — falling through to the
  // same code in-process is what `knowledge sync` does, for the same reason.
  const daemonMiss = (error: string): boolean => /not found/i.test(error);

  if (sub === "list" || sub === "ls") {
    if (onDaemon) {
      const res = await r.client().get<{ projects: ProjectSummary[] }>("/projects");
      if (res.ok) return printProjects(ctx, res.data.projects);
      if (!daemonMiss(res.error)) {
        ctx.err(`project list: ${res.error}`);
        return 1;
      }
    }
    const svc = await r.service();
    return printProjects(ctx, await svc.listProjects());
  }

  if (sub === "init" || sub === "create") {
    const slug = a.positionals[1] ?? flagString(a, "project");
    const note = flagString(a, "note");
    if (onDaemon) {
      const res = await r.client().post<{ project: string; created: boolean; rows: number }>("/projects", {
        project: slug,
        note,
        agent: flagString(a, "agent"),
        user: flagString(a, "user")
      });
      if (res.ok) return printInit(ctx, res.data);
      if (!daemonMiss(res.error)) {
        ctx.err(`project init: ${res.error}`);
        return 1;
      }
    }
    const svc = await r.service();
    const out = await svc.initProject({ project: slug, note, agent: flagString(a, "agent"), user: flagString(a, "user") });
    return printInit(ctx, out);
  }

  if (sub === "rename" || sub === "mv") {
    const from = a.positionals[1] ?? flagString(a, "from");
    const to = a.positionals[2] ?? flagString(a, "to");
    if (!from || !to) {
      ctx.err("rename: usage ai-memory project rename <from> <to> [--merge]");
      return 2;
    }
    const merge = flagBool(a, "merge");
    if (onDaemon) {
      const res = await r.client().post<{ renamed: number; project: string }>(
        `/projects/${encodeURIComponent(from)}/rename`,
        { to, merge }
      );
      if (res.ok) return printRename(ctx, res.data, from);
      if (!daemonMiss(res.error)) {
        ctx.err(`project rename: ${res.error}`);
        return 1;
      }
    }
    const svc = await r.service();
    const out = await svc.renameProject(from, to, { merge });
    return printRename(ctx, out, from);
  }

  if (sub === "forget" || sub === "rm" || sub === "drop") {
    const slug = a.positionals[1] ?? flagString(a, "project");
    if (!slug) {
      ctx.err("forget: usage ai-memory project forget <slug> [--detach]");
      return 2;
    }
    const mode = flagBool(a, "detach") ? "detach" : "delete";
    if (onDaemon) {
      const res = await r.client().del<{ detached: number; deleted: number; project: string }>(
        `/projects/${encodeURIComponent(slug)}?mode=${mode}`
      );
      if (res.ok) return printForget(ctx, res.data, mode);
      if (!daemonMiss(res.error)) {
        ctx.err(`project forget: ${res.error}`);
        return 1;
      }
    }
    const svc = await r.service();
    const out = await svc.forgetProject(slug, { mode });
    return printForget(ctx, out, mode);
  }

  ctx.err(`project: unknown subcommand "${sub}" (expected: list | init | rename | forget)`);
  return 2;
}

function printProjects(ctx: Ctx, projects: ProjectSummary[]): number {
  if (ctx.json) {
    ctx.out(JSON.stringify({ projects }, null, 2));
    return 0;
  }
  if (projects.length === 0) {
    ctx.out("no projects yet — run: ai-memory project init");
    return 0;
  }
  for (const p of projects) {
    const kinds = Object.entries(p.byKind)
      .map(([kind, n]) => `${kind} ${n}`)
      .join(", ");
    const last = p.lastActivityAt > 0 ? new Date(p.lastActivityAt).toISOString().slice(0, 10) : "-";
    ctx.out(`- ${p.project ?? "(unscoped)"}  ${p.rows} row(s)${kinds ? `  (${kinds})` : ""}  last ${last}`);
  }
  return 0;
}

function printInit(ctx: Ctx, out: { project: string; created: boolean; rows: number }): number {
  if (ctx.json) {
    ctx.out(JSON.stringify(out, null, 2));
    return 0;
  }
  ctx.out(
    out.created
      ? `initialized ${out.project} (marker row in the shared layer)`
      : `${out.project} already exists (${out.rows} row(s))`
  );
  return 0;
}

function printRename(ctx: Ctx, out: { renamed: number; project: string }, from: string): number {
  if (ctx.json) {
    ctx.out(JSON.stringify({ ...out, from }, null, 2));
    return 0;
  }
  ctx.out(out.renamed === 0 ? `nothing to rename: ${from} = ${out.project}` : `renamed ${out.renamed} row(s): ${from} → ${out.project}`);
  return 0;
}

function printForget(ctx: Ctx, out: { detached: number; deleted: number }, mode: "detach" | "delete"): number {
  if (ctx.json) {
    ctx.out(JSON.stringify(out, null, 2));
    return 0;
  }
  if (mode === "detach") {
    ctx.out(`detached ${out.detached} row(s) to unscoped`);
  } else {
    ctx.out(`soft-deleted ${out.deleted} row(s) (restorable with: ai-memory restore <id>)`);
  }
  return 0;
}

async function cmdDb(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>): Promise<number> {
  const which = a.positionals[0] ?? "info";
  if (which === "compact") {
    // Reclaims what deletes leave behind. Runs in-process rather than through the
    // daemon: VACUUM needs the file to itself for a moment, and a daemon that keeps
    // serving rows while the file is rewritten is a lock, not a feature.
    const { SqliteVectorStore } = await import("../core/store/sqlite.js");
    const store = new SqliteVectorStore(flagString(a, "db") ?? resolveDbPath());
    await store.init();
    try {
      // `--purge <days>` is the destructive half and is opt-in: soft delete is an
      // audit trail, so removing tombstones needs an explicit age. VACUUM alone only
      // gives back the pages already on the freelist.
      const purgeDays = flagNumber(a, "purge");
      let purged: number | null = null;
      if (purgeDays !== undefined && purgeDays !== null) {
        purged = await store.purgeDeleted!({ olderThanMs: Math.max(0, purgeDays) * 86400000 });
      }
      const report = await store.compact!();
      const saved = report.bytesBefore - report.bytesAfter;
      if (ctx.json) ctx.out(JSON.stringify({ ...report, purged }, null, 2));
      else {
        if (purged !== null) ctx.out(`purged: ${purged} tombstone(s)`);
        ctx.out(`compacted: ${report.bytesBefore} -> ${report.bytesAfter} bytes (${saved >= 0 ? "-" : "+"}${Math.abs(saved)})`);
      }
      return 0;
    } finally {
      store.close();
    }
  }
  if (which !== "info") {
    ctx.err(`db: unknown subcommand "${which}" (expected: info | compact)`);
    return 2;
  }
  const explicit = flagString(a, "db");
  const target = resolveDbPath(explicit);
  const source = explicit
    ? "--db"
    : process.env.MEMORY_DB_PATH
      ? "MEMORY_DB_PATH"
      : process.env.AI_MEMORY_DB
        ? "AI_MEMORY_DB"
        : process.env.AI_MEMORY_HOME
          ? "AI_MEMORY_HOME"
          : "default (~/.ai-memory)";
  const legacy = legacyDbPath();
  const info = {
    dbPath: target,
    resolvedFrom: source,
    exists: dbExists(target),
    legacyInRepo: dbExists(legacy) ? legacy : null,
    legacyHint: !dbExists(target) && dbExists(legacy) ? "run: ai-memory setup --copy-db" : null,
    agent: resolveAgent(flagString(a, "agent")),
    user: resolveUser(flagString(a, "user")),
    server: r.client().url
  };
  if (ctx.json) ctx.out(JSON.stringify(info, null, 2));
  else {
    ctx.out(`store:    ${info.dbPath}${info.exists ? "" : " (not created yet)"}`);
    ctx.out(`from:     ${info.resolvedFrom}`);
    ctx.out(`agent:    ${info.agent}   user: ${info.user}`);
    ctx.out(`daemon:   ${info.server}`);
    if (info.legacyInRepo) ctx.out(`legacy:   ${info.legacyInRepo}`);
    if (info.legacyHint) ctx.out(`hint:     ${info.legacyHint}`);
  }
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const ctx: Ctx = {
    json: false,
    argv,
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n")
  };
  const a = parseArgs(argv);
  ctx.json = flagBool(a, "json");

  if (flagBool(a, "help") || a.command === "help" || a.command === "") {
    printUsage(ctx);
    return a.command === "" && !flagBool(a, "help") ? 2 : 0;
  }
  if (flagBool(a, "version") || a.command === "version") {
    ctx.out(await appVersion());
    return 0;
  }

  const runner = new Runner({ db: flagString(a, "db"), noDaemon: flagBool(a, "no-daemon"), server: flagString(a, "server") });

  try {
    switch (a.command) {
      case "save":
      case "remember":
        return await cmdSave(runner, ctx, a);
      case "search":
      case "recall":
        return await cmdSearch(runner, ctx, a);
      case "get":
      case "show":
        return await cmdGet(runner, ctx, a);
      case "list":
      case "ls":
        return await cmdList(runner, ctx, a);
      case "forget":
      case "rm":
        return await cmdForget(runner, ctx, a, false);
      case "restore":
        return await cmdForget(runner, ctx, a, true);
      case "supersede":
        return await cmdSupersede(runner, ctx, a);
      case "meta":
        return await cmdMeta(runner, ctx, a);
      case "brief":
        return await cmdBrief(runner, ctx, a);
      case "knowledge":
        return await cmdKnowledge(runner, ctx, a);
      case "project":
      case "projects":
        return await cmdProject(runner, ctx, a);
      case "stats":
        return await cmdStats(runner, ctx, a);
      case "decay":
        return await cmdDecay(runner, ctx, a);
      case "triage":
        return await cmdTriage(runner, ctx, a);
      case "extract":
        return await cmdExtract(runner, ctx, a);
      case "reembed":
        return await cmdReembed(runner, ctx, a);
      case "setup":
        return await cmdSetup(runner, ctx, a);
      case "db":
        return await cmdDb(runner, ctx, a);
      case "daemon": {
        const { runDaemonCommand } = await import("./daemon.js");
        return await runDaemonCommand(a.positionals, ctx);
      }
      case "principal": {
        const { runPrincipalCommand } = await import("./principal.js");
        return await runPrincipalCommand(a.positionals, a.flags, ctx);
      }
      case "mcp": {
        const { runMcpServer } = await import("../mcp/server.js");
        await runMcpServer({
          db: flagString(a, "db"),
          agent: flagString(a, "agent"),
          scope: flagString(a, "scope") as MemoryScope | undefined,
          server: flagString(a, "server"),
          noDaemon: flagBool(a, "no-daemon")
        });
        return 0;
      }
      case "inject": {
        const { runInject } = await import("../adapters/inject.js");
        return await runInject({
          agent: flagString(a, "agent"),
          mode: flagString(a, "mode"),
          db: flagString(a, "db"),
          server: flagString(a, "server"),
          noDaemon: flagBool(a, "no-daemon"),
          json: ctx.json
        });
      }
      case "agent": {
        const { runAgentCommand } = await import("../adapters/cli.js");
        return await runAgentCommand(a.positionals, a.flags, ctx);
      }
      case "context": {
        const { runContextCommand } = await import("../adapters/cli.js");
        return await runContextCommand(a.positionals, a.flags, ctx);
      }
      case "import": {
        const { runImportCommand } = await import("../migrate/cli.js");
        return await runImportCommand(a.positionals, a.flags, ctx);
      }
      default:
        ctx.err(`ai-memory: unknown command "${a.command}"\n`);
        printUsage(ctx);
        return 2;
    }
  } catch (err) {
    ctx.err(`ai-memory: ${(err as Error).message}`);
    return 1;
  } finally {
    await runner.close();
  }
}

// A global install puts a symlink in bin/ on POSIX, and Node resolves `import.meta.url` to
// the real file, so the two have to be compared as real paths. Comparing the literal
// `argv[1]` against it meant the guard never matched when the command was run the way a
// user runs it — a symlinked `open-memory version` printed nothing and exited 0.
const entryPath = process.argv[1];
let isMain = false;
try {
  isMain = entryPath !== undefined && import.meta.url === pathToFileURL(realpathSync(entryPath)).href;
} catch {
  // `argv[1]` is not a path (node -e, a REPL); there is nothing to compare against.
}
if (isMain || process.env.AI_MEMORY_CLI_FORCE_MAIN === "1") {
  main().then((code) => {
    process.exitCode = code;
  });
}
