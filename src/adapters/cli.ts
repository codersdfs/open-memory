import { createRegistry, defaultAdapters, isBuiltIn, cliEntryPath, mcpCommandSpec } from "./index.js";
import { GenericAdapter } from "./generic.js";
import { agentsFilePath, readSpecs, validateSpec, writeSpecs } from "./specs.js";
import { plan } from "./fs.js";
import { resolveAgent, resolveUser, resolveWriteKey } from "../core/scope.js";
import { resolveDbPath, dbExists } from "../core/dbPath.js";
import { existsSync } from "node:fs";

/**
 * `ai-memory agent …` and `ai-memory context …` (ADR-0007).
 *
 * Everything here is dry-run by default: `agent link` prints exactly what it would
 * change, and only `--write` touches a file. Users have real configuration in these
 * files, so a preview that is wrong is a bug, and a silent write is unacceptable.
 */

export interface CommandCtx {
  json: boolean;
  out: (s: string) => void;
  err: (s: string) => void;
}

interface Flags {
  [key: string]: string | boolean;
}

function flag(flags: Flags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function bool(flags: Flags, name: string): boolean {
  const v = flags[name];
  return v === true || v === "true" || v === "1";
}

function renderActions(
  ctx: CommandCtx,
  adapterId: string,
  actions: { path: string; detail: string; changed: boolean; preview?: string }[],
  write: boolean
): void {
  if (ctx.json) {
    ctx.out(JSON.stringify({ agent: adapterId, write, actions }, null, 2));
    return;
  }
  let changed = 0;
  for (const a of actions) {
    const mark = a.changed ? (write ? "changed" : "would change") : "already ok";
    if (a.changed) changed++;
    ctx.out(`${mark.padEnd(13)} ${a.path}`);
    ctx.out(`              ${a.detail}`);
    if (a.preview && a.changed && !write) {
      for (const line of a.preview.split("\n")) ctx.out(`              | ${line}`);
    }
  }
  if (!write && changed > 0) ctx.out(`\n${changed} change(s) not applied — re-run with --write`);
  else if (write && changed === 0) ctx.out("\nnothing to change");
}

export async function runAgentCommand(positionals: string[], flags: Flags, ctx: CommandCtx): Promise<number> {
  const sub = positionals[0] ?? "list";
  const only = flag(flags, "agent");
  const write = bool(flags, "write");
  const registry = createRegistry();
  const selected = only ? registry.get(only) : undefined;
  if (only && !selected) {
    ctx.err(`agent: unknown agent "${only}" (known: ${registry.ids().join(", ")})`);
    return 2;
  }

  switch (sub) {
    case "list": {
      const rows = await Promise.all(
        registry.all().map(async (a) => ({ id: a.id, label: a.label, detected: a.detect(), ...(await a.status()) }))
      );
      if (ctx.json) {
        ctx.out(JSON.stringify(rows, null, 2));
        return 0;
      }
      for (const r of rows) {
        ctx.out(`${r.id.padEnd(8)} ${r.linked ? "linked  " : "not set "} ${r.detected ? "installed" : "not found"}  ${r.label}`);
      }
      return 0;
    }

    case "init": {
      const targets = selected ? [selected] : registry.all().filter((a) => a.detect());
      const all: unknown[] = [];
      for (const a of targets) {
        const actions = await a.link({ write });
        all.push({ agent: a.id, actions });
        renderActions(ctx, a.id, actions, write);
      }
      if (!write) ctx.out("\nre-run with --write to apply");
      if (ctx.json) ctx.out(JSON.stringify(all, null, 2));
      return 0;
    }

    case "link": {
      const targets = selected ? [selected] : registry.all().filter((a) => a.detect());
      if (targets.length === 0) {
        ctx.err(`agent link: no agent detected; pass --agent <id> (known: ${registry.ids().join(", ")})`);
        return 1;
      }
      for (const a of targets) {
        const actions = await a.link({ write });
        if (ctx.json) ctx.out(JSON.stringify({ agent: a.id, write, actions }, null, 2));
        else renderActions(ctx, a.id, actions, write);
      }
      return 0;
    }

    case "unlink": {
      const targets = selected ? [selected] : registry.all().filter((a) => a.detect());
      for (const a of targets) {
        const actions = await a.unlink({ write });
        if (ctx.json) ctx.out(JSON.stringify({ agent: a.id, write, actions }, null, 2));
        else renderActions(ctx, a.id, actions, write);
      }
      return 0;
    }

    case "status": {
      const rows = await Promise.all(
        registry.all().map(async (a) => ({ id: a.id, label: a.label, detected: a.detect(), ...(await a.status()) }))
      );
      if (ctx.json) {
        ctx.out(JSON.stringify(rows, null, 2));
        return 0;
      }
      for (const r of rows) ctx.out(`${r.linked ? "✓" : "·"} ${r.id.padEnd(8)} ${r.detail}`);
      return 0;
    }

    case "specs": {
      const { specs, errors } = readSpecs();
      if (ctx.json) {
        ctx.out(JSON.stringify({ file: agentsFilePath(), agents: specs, errors }, null, 2));
        return 0;
      }
      ctx.out(agentsFilePath());
      const ids = Object.keys(specs);
      if (ids.length === 0) ctx.out("  (no declared agents)");
      for (const id of ids) ctx.out(`  ${id.padEnd(12)} ${specs[id]!.mcpFile}${isBuiltIn(id) ? "   ← built-in id: ignored, link that one instead" : ""}`);
      for (const error of errors) ctx.err(`  ${error}`);
      return 0;
    }

    case "add": {
      const id = positionals[1];
      if (!id) {
        ctx.err("agent add: an id is required, e.g. ai-memory agent add cursor --mcp-file ~/.cursor/mcp.json");
        return 2;
      }
      const mcpFile = flag(flags, "mcp-file");
      if (!mcpFile) {
        ctx.err("agent add: --mcp-file <path> is required — the config file to register the MCP server in");
        return 2;
      }
      const env: Record<string, string> = {};
      for (const pair of (flag(flags, "env") ?? "").split(",")) {
        const trimmed = pair.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) {
          ctx.err(`agent add: --env expects KEY=VALUE, got "${trimmed}"`);
          return 2;
        }
        env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
      const declared = validateSpec(id, {
        mcpFile,
        jsonPath: flag(flags, "json-path"),
        format: flag(flags, "format"),
        env: Object.keys(env).length > 0 ? env : undefined,
        instructions: flag(flags, "instructions")
      });
      if (typeof declared === "string") {
        ctx.err(`agent add: ${declared}`);
        return 2;
      }

      const file = agentsFilePath();
      const { specs, errors } = readSpecs();
      // A file we cannot parse is not a file to append to: writing it back would
      // silently drop whatever the user actually declared there.
      if (errors.length > 0) {
        ctx.err(`agent add: refusing to rewrite ${file}`);
        for (const error of errors) ctx.err(`  ${error}`);
        return 1;
      }
      const existed = id in specs;
      if (isBuiltIn(id)) {
        ctx.err(
          `agent add: "${id}" is a built-in adapter, and its entry is more than a config path — a declaration would drop ` +
            `its hooks or managed instructions. Link it as it is: ai-memory agent link --agent ${id} --write`
        );
        return 2;
      }
      specs[id] = declared;
      writeSpecs(specs, write);
      renderActions(
        ctx,
        id,
        [plan(file, `${existed ? "update" : "declare"} agent "${id}" → ${declared.mcpFile}`, true, JSON.stringify({ agents: { [id]: declared } }, null, 2))],
        write
      );
      // Declaring is half of it — register into the client's own config as well,
      // so one command leaves the agent talking to memory.
      renderActions(ctx, id, await new GenericAdapter(id, declared).link({ write }), write);
      return 0;
    }

    case "remove": {
      const id = positionals[1];
      if (!id) {
        ctx.err("agent remove: an id is required");
        return 2;
      }
      const file = agentsFilePath();
      const { specs, errors } = readSpecs();
      if (errors.length > 0) {
        ctx.err(`agent remove: refusing to rewrite ${file}`);
        for (const error of errors) ctx.err(`  ${error}`);
        return 1;
      }
      if (!(id in specs)) {
        ctx.err(`agent remove: "${id}" is not declared in ${file}`);
        return 1;
      }
      delete specs[id];
      writeSpecs(specs, write);
      ctx.out(`${write ? "removed" : "would remove"} declared agent "${id}"`);
      ctx.out(`  its config file is untouched — run: ai-memory agent unlink --agent ${id} --write`);
      return 0;
    }

    case "doctor": {
      return await doctor(ctx);
    }

    default:
      ctx.err(`agent: unknown subcommand "${sub}" (init | list | status | specs | add | remove | doctor | link | unlink)`);
      return 2;
  }
}

/** Preflight: the things that actually break an install, checked in dependency order. */
async function doctor(ctx: CommandCtx): Promise<number> {
  const { command, args } = mcpCommandSpec();
  const cli = args[0] ?? "";
  const checks: { name: string; ok: boolean; detail: string }[] = [];

  const nodeOk = existsSync(command);
  checks.push({ name: "node runtime", ok: nodeOk, detail: command });

  const cliOk = existsSync(cli);
  checks.push({
    name: "cli build",
    ok: cliOk,
    detail: cliOk ? cli : `${cli} missing — run: npm run build`
  });

  const db = resolveDbPath();
  const storeOk = dbExists(db) || existsSync(db.replace(/memory\.db$/, ""));
  checks.push({ name: "store", ok: true, detail: `${db}${dbExists(db) ? "" : " (created on first write)"}` });

  const agent = resolveAgent();
  const user = resolveUser();
  checks.push({ name: "identity", ok: true, detail: `agent=${agent} user=${user} write→${resolveWriteKey({ agent })}` });

  const registry = createRegistry();
  for (const a of registry.all()) {
    const s = await a.status();
    // A detected-but-unlinked agent is advice, not breakage: the user may simply not
    // have run `agent link` yet. Doctor only fails on things that cannot work.
    checks.push({ name: `agent:${a.id}`, ok: true, detail: a.detect() ? s.detail : "not installed" });
  }

  // A declaration that never loads is a silent no-op, which is exactly what doctor is
  // for: report the file, not only the adapters that made it through it.
  const declarations = readSpecs();
  const collisions = Object.keys(declarations.specs).filter(isBuiltIn);
  checks.push({
    name: "declarations",
    ok: declarations.errors.length === 0 && collisions.length === 0,
    detail:
      declarations.errors.length > 0
        ? declarations.errors.join("; ")
        : collisions.length > 0
          ? `${agentsFilePath()}: built-in id(s) ignored — ${collisions.join(", ")}`
          : `${Object.keys(declarations.specs).length} declared in ${agentsFilePath()}`
  });

  const failed = checks.filter((c) => !c.ok);
  if (ctx.json) ctx.out(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  else {
    for (const c of checks) ctx.out(`${c.ok ? "ok  " : "FAIL"} ${c.name.padEnd(12)} ${c.detail}`);
    ctx.out(failed.length === 0 ? "\nall checks passed" : `\n${failed.length} check(s) failed`);
  }
  return failed.length === 0 ? 0 : 1;
}

export async function runContextCommand(positionals: string[], flags: Flags, _ctx: CommandCtx): Promise<number> {
  const sub = positionals[0] ?? "refresh";
  if (sub !== "refresh") {
    _ctx.err(`context: unknown subcommand "${sub}" (expected: refresh)`);
    return 2;
  }
  const write = bool(flags, "write");
  const registry = createRegistry();
  for (const adapter of registry.all()) {
    if (!adapter.detect()) continue;
    const actions = await adapter.link({ write });
    if (_ctx.json) _ctx.out(JSON.stringify({ agent: adapter.id, write, actions }, null, 2));
    else renderActions(_ctx, adapter.id, actions, write);
  }
  return 0;
}

export { defaultAdapters, cliEntryPath };
