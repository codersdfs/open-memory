import path from "node:path";
import { home } from "../memory.js";
import type { Adapter } from "./types.js";
import type { AdapterAction } from "./fs.js";
import { clone, getObject, hasCommand, mcpCommandSpec, plan, readJsonIfExists, slash, writeJson, writeText, existsSync } from "./fs.js";

/**
 * Claude Code integration.
 *
 * MCP servers live in `~/.claude.json` (user scope) and hooks in
 * `~/.claude/settings.json`. Two things matter here:
 *   1. `~/.claude.json` also holds a large amount of unrelated state that Claude
 *      Code rewrites constantly — never write it wholesale without re-reading it
 *      first, and never replace the whole `hooks` object.
 *   2. Hook commands run in a POSIX shell even on Windows, so paths must use
 *      forward slashes and the command must not depend on the cwd.
 */

const MCP_NAME = "ai-memory";

function claudeJsonPath(): string {
  return path.join(home(), ".claude.json");
}

function settingsPath(): string {
  return path.join(home(), ".claude", "settings.json");
}

function injectCommand(hook: "session-start" | "prompt-submit" | "stop"): string {
  const { command, args } = mcpCommandSpec();
  const cli = slash(args[0] ?? "");
  const node = slash(command);
  return `"${node}" "${cli}" inject --mode ${hook} 2>/dev/null || exit 0`;
}

function mergeHookSettings(settings: Record<string, unknown>): { changed: boolean } {
  const hooks = getObject(settings, "hooks");
  let changed = false;

  const add = (event: string, matcher: string | null, marker: string) => {
    const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const already = JSON.stringify(list).includes("ai-memory");
    if (already) return;
    list.push({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: "command", command: marker, timeout: 10 }]
    });
    hooks[event] = list;
    changed = true;
  };

  add("SessionStart", null, injectCommand("session-start"));
  add("UserPromptSubmit", null, injectCommand("prompt-submit"));
  add("Stop", null, injectCommand("stop"));
  return { changed };
}

export class ClaudeAdapter implements Adapter {
  id = "claude";
  label = "Claude Code";

  detect(): boolean {
    return existsSync(claudeJsonPath()) || existsSync(settingsPath()) || hasCommand("claude");
  }

  paths(): string[] {
    return [claudeJsonPath(), settingsPath()];
  }

  async link(opts: { write: boolean }): Promise<AdapterAction[]> {
    const actions: AdapterAction[] = [];

    const cfgPath = claudeJsonPath();
    const cfg = readJsonIfExists(cfgPath) ?? {};
    const servers = getObject(cfg, "mcpServers");
    const { command, args } = mcpCommandSpec();
    const desired = { type: "stdio", command, args, env: {} };
    const mcpChanged = JSON.stringify(servers[MCP_NAME]) !== JSON.stringify(desired);
    servers[MCP_NAME] = desired;
    actions.push(
      plan(cfgPath, `register MCP server "${MCP_NAME}" (stdio: ${command} ${args.join(" ")})`, mcpChanged, JSON.stringify(desired, null, 2))
    );
    writeJson(cfgPath, cfg, opts.write);

    const sPath = settingsPath();
    const settings = readJsonIfExists(sPath) ?? {};
    const { changed } = mergeHookSettings(settings);
    actions.push(plan(sPath, "add SessionStart / UserPromptSubmit / Stop hooks calling `ai-memory inject`", changed));
    writeJson(sPath, settings, opts.write);

    return actions;
  }

  async unlink(opts: { write: boolean }): Promise<AdapterAction[]> {
    const actions: AdapterAction[] = [];

    const cfgPath = claudeJsonPath();
    const cfg = readJsonIfExists(cfgPath);
    if (cfg) {
      const servers = cfg.mcpServers as Record<string, unknown> | undefined;
      const removed = Boolean(servers && MCP_NAME in servers);
      if (servers) delete servers[MCP_NAME];
      actions.push(plan(cfgPath, `remove MCP server "${MCP_NAME}"`, removed));
      if (removed) writeJson(cfgPath, cfg, opts.write);
    }

    const sPath = settingsPath();
    const settings = readJsonIfExists(sPath);
    if (settings) {
      const hooks = settings.hooks as Record<string, unknown[]> | undefined;
      let removed = 0;
      if (hooks) {
        for (const event of Object.keys(hooks)) {
          const list = Array.isArray(hooks[event]) ? hooks[event]! : [];
          const kept = list.filter((entry) => !JSON.stringify(entry).includes("ai-memory"));
          if (kept.length !== list.length) removed += list.length - kept.length;
          if (kept.length === 0) delete hooks[event];
          else hooks[event] = kept;
        }
      }
      actions.push(plan(sPath, `remove ${removed} ai-memory hook(s)`, removed > 0));
      if (removed > 0) writeJson(sPath, settings, opts.write);
    }

    return actions;
  }

  async status(): Promise<{ linked: boolean; detail: string }> {
    const cfg = readJsonIfExists(claudeJsonPath());
    const servers = cfg?.mcpServers as Record<string, unknown> | undefined;
    const hasMcp = Boolean(servers && MCP_NAME in servers);
    const settings = readJsonIfExists(settingsPath());
    const hasHooks = JSON.stringify(settings?.hooks ?? {}).includes("ai-memory");
    return {
      linked: hasMcp,
      detail: `mcp=${hasMcp ? "yes" : "no"} hooks=${hasHooks ? "yes" : "no"} (${claudeJsonPath()})`
    };
  }
}
