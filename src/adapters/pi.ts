import path from "node:path";
import { home } from "../memory.js";
import type { Adapter } from "./types.js";
import type { AdapterAction } from "./fs.js";
import { existsSync, getObject, hasCommand, mcpCommandSpec, plan, readJsonIfExists, writeJson } from "./fs.js";

/**
 * pi / `.pi` agent integration.
 *
 * pi already loads MCP servers from `~/.pi/agent/mcp-adapter.json` — that is the
 * file the existing pi extension edits — so registration is a single entry there.
 * pi passes the agent's tools straight through (`directTools: true`), which is why
 * `memory_*` tools need to be named exactly as the extension named them.
 */

const MCP_NAME = "ai-memory";

export function mcpAdapterPath(): string {
  return process.env.PI_HOME ? path.join(process.env.PI_HOME, "agent", "mcp-adapter.json") : path.join(home(), ".pi", "agent", "mcp-adapter.json");
}

export class PiAdapter implements Adapter {
  id = "pi";
  label = "pi agent";

  detect(): boolean {
    return existsSync(path.join(home(), ".pi")) || hasCommand("pi");
  }

  paths(): string[] {
    return [mcpAdapterPath()];
  }

  async link(opts: { write: boolean }): Promise<AdapterAction[]> {
    const file = mcpAdapterPath();
    const cfg = readJsonIfExists(file) ?? {};
    const servers = getObject(cfg, "mcpServers");
    const { command, args } = mcpCommandSpec();
    const desired = { command, args, env: { AI_MEMORY_AGENT: "pi" }, directTools: true };
    const changed = JSON.stringify(servers[MCP_NAME]) !== JSON.stringify(desired);
    servers[MCP_NAME] = desired;
    if (changed) writeJson(file, cfg, opts.write);
    return [plan(file, `register MCP server "${MCP_NAME}" with directTools`, changed, JSON.stringify(desired, null, 2))];
  }

  async unlink(opts: { write: boolean }): Promise<AdapterAction[]> {
    const file = mcpAdapterPath();
    const cfg = readJsonIfExists(file);
    if (!cfg) return [plan(file, "nothing to do (no config file)", false)];
    const servers = cfg.mcpServers as Record<string, unknown> | undefined;
    const removed = Boolean(servers && MCP_NAME in servers);
    if (servers) delete servers[MCP_NAME];
    if (removed) writeJson(file, cfg, opts.write);
    return [plan(file, `remove MCP server "${MCP_NAME}"`, removed)];
  }

  async status(): Promise<{ linked: boolean; detail: string }> {
    const cfg = readJsonIfExists(mcpAdapterPath());
    const servers = cfg?.mcpServers as Record<string, unknown> | undefined;
    const linked = Boolean(servers && MCP_NAME in servers);
    return { linked, detail: `mcp=${linked ? "yes" : "no"} (${mcpAdapterPath()})` };
  }
}
