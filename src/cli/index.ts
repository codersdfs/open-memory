#!/usr/bin/env node
import { parseArgs, flagBool, flagList, flagNumber, flagString, queryText } from "./args.js";
import { MemoryClient, unwrapMemory } from "./http.js";
import { resolveAgent, resolveRequestScope, resolveWriteKey, resolveUser, type MemoryScope } from "../core/scope.js";
import { resolveDbPath, resolveHome, legacyDbPath, dbExists } from "../core/dbPath.js";
import { MemoryService } from "../core/memoryService.js";
import type { Memory, MemoryType, SearchResult } from "../core/types.js";

/**
 * `ai-memory` — the one command every agent uses (ADR-0007).
 *
 * Design rules:
 *  - default output is for a human, `--json` is the exact service payload;
 *  - the daemon is used when it answers, otherwise the store is opened in-process;
 *  - every subcommand is usable non-interactively, because hooks call it.
 */

const TYPES = ["episodic", "semantic", "procedural", "working"] as const;
const STATUSES = ["active", "draft", "archived", "superseded"] as const;

const USAGE = `ai-memory — shared memory for coding agents

Usage: ai-memory <command> [options] [args]

Memory
  save <text>            --type semantic --importance 0.5 --tags a,b --scope private|shared
  search <query>         --k 5 --threshold 0.35 --budget 800 --scope private|shared --type t
  get <id>               print one memory
  list                   --limit 20 --type t --status active
  forget <id...>         soft delete (kept, restorable)
  restore <id...>        undo a forget
  supersede <id> <text>  replace one memory with a newer one
  meta <id>              --status active|draft|archived|superseded --pin 0|1
  stats                  counts per type for the resolved scope(s)
  decay                  apply lifecycle decay / pruning
  extract <text>         pull candidate memories out of free text and save them

Setup & introspection
  setup                  create the memory home dir; --copy-db to migrate the old store
  db info                which store would be used, and why
  mcp                    run the MCP stdio server (agents spawn this)
  inject                 read a hook payload on stdin, print context for this turn
  agent <sub>            init | list | doctor | link | unlink (per-agent integration)
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
  async useDaemon(): Promise<boolean> {
    if (this.opts.noDaemon) return false;
    return this.client().healthy();
  }
  async close(): Promise<void> {
    if (this.svc) await this.svc.close();
  }
}

function stripEmbedding(m: Memory): Omit<Memory, "embedding"> {
  const { embedding: _drop, ...rest } = m;
  return rest;
}

function renderMemories(result: SearchResult, ctx: Ctx): void {
  if (result.memories.length === 0) {
    ctx.out("no memories matched");
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
  const payload = {
    text,
    type,
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
  const mem = await svc.save({
    text,
    type,
    namespace: payload.namespace ?? resolveWriteKey({ agent, scope: payload.scope }),
    importance: payload.importance,
    tags: payload.tags,
    source: payload.source
  });
  ctx.out(ctx.json ? JSON.stringify(mem, null, 2) : `saved ${mem.id} → ${mem.namespace}`);
  return 0;
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
  // R1: opt-in, because the default answer is meant to be read, not debugged.
  const explain = flagBool(a, "explain");

  if (await r.useDaemon()) {
    const res = await r.client().get<SearchResult>(
      "/memories/search" +
        MemoryClient.query({ query, namespace, agent, scope, k, budgetTokens, threshold, type, explain, all: flagBool(a, "all") })
    );
    if (!res.ok) {
      ctx.err(`search: ${res.error}`);
      return 1;
    }
    if (ctx.json) ctx.out(JSON.stringify(res.data, null, 2));
    else renderMemories(res.data, ctx);
    return 0;
  }

  const { namespaces } = resolveRequestScope({ namespace, agent, scope, all: flagBool(a, "all") });
  const svc = await r.service();
  const result = await svc.search({
    query,
    namespaces,
    agent: resolveAgent(agent),
    type,
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
  if (await r.useDaemon()) {
    const res = await r.client().get<unknown>(`/memories/${encodeURIComponent(id)}`);
    if (!res.ok) {
      ctx.err(`get: ${res.error}`);
      return 1;
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
  const mem = (await svc.get(id)) ?? null;
  if (!mem) {
    ctx.err(`get: no memory ${id}`);
    return 1;
  }
  ctx.out(ctx.json ? JSON.stringify(mem, null, 2) : renderOne(mem));
  return 0;
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
  const status = flagString(a, "status");

  if (await r.useDaemon()) {
    const res = await r.client().get<{ memories: Memory[]; total: number }>(
      "/memories" +
        MemoryClient.query({ namespace, agent, scope, limit, type, status, all: flagBool(a, "all") })
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

  const { namespaces } = resolveRequestScope({ namespace, agent, scope, all: flagBool(a, "all") });
  const svc = await r.service();
  const all: Memory[] = [];
  let total = 0;
  for (const ns of namespaces) {
    const page = await svc.list({ namespace: ns, type, limit, status: status as never });
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
  const { namespaces, scopes } = resolveRequestScope({ namespace, agent, scope, all: flagBool(a, "all") });

  if (await r.useDaemon()) {
    const res = await r.client().get<Record<string, unknown>>(
      "/stats" + MemoryClient.query({ namespace: namespaces[0], agent, scope, all: flagBool(a, "all") })
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
  const result = await runDecay(svc.store as never);
  ctx.out(ctx.json ? JSON.stringify(result, null, 2) : `decay: ${JSON.stringify(result)}`);
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
    const res = await r.client().post<{ extracted: number; memories: Memory[] }>("/extract", { text, namespace });
    if (!res.ok) {
      ctx.err(`extract: ${res.error}`);
      return 1;
    }
    ctx.out(ctx.json ? JSON.stringify(res.data, null, 2) : `extracted ${res.data.extracted}`);
    return 0;
  }
  const svc = await r.service();
  const memories = await svc.extractAndSave(text, namespace);
  ctx.out(ctx.json ? JSON.stringify({ extracted: memories.length, memories }, null, 2) : `extracted ${memories.length}`);
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
  return 0;
}

async function cmdDb(r: Runner, ctx: Ctx, a: ReturnType<typeof parseArgs>): Promise<number> {
  const which = a.positionals[0] ?? "info";
  if (which !== "info") {
    ctx.err(`db: unknown subcommand "${which}" (expected: info)`);
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
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version: string };
    ctx.out(pkg.version);
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
      case "stats":
        return await cmdStats(runner, ctx, a);
      case "decay":
        return await cmdDecay(runner, ctx, a);
      case "extract":
        return await cmdExtract(runner, ctx, a);
      case "setup":
        return await cmdSetup(runner, ctx, a);
      case "db":
        return await cmdDb(runner, ctx, a);
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

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain || process.env.AI_MEMORY_CLI_FORCE_MAIN === "1") {
  main().then((code) => {
    process.exitCode = code;
  });
}
