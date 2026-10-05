import path from "node:path";
import { home } from "../memory.js";
import type { Adapter } from "./types.js";
import type { AdapterAction } from "./fs.js";
import { existsSync, getObject, mcpCommandSpec, plan, readJsonIfExists, writeJson } from "./fs.js";

/**
 * DeepSeek Harness (DSH) integration.
 *
 * DSH passes an MCP client config to spawned tools; the stable, documented path for
 * that file is `~/.dsh/mcp.json` (overridable with `DSH_HOME`). The adapter writes the
 * standard `mcpServers` shape so DSH — or any other MCP client pointed at the same
 * file — can spawn `ai-memory mcp`. The agent id `dsh` is also what `detectAgent()`
 * reports when a process runs under DSH, so writes land in the right private layer.
 */

const MCP_NAME = "ai-memory";

export function dshMcpPath(): string {
  const home_ = process.env.DSH_HOME?.trim() || path.join(home(), ".dsh");
  return path.join(home_, "mcp.json");
}

export class DshAdapter implements Adapter {
  id = "dsh";
  label = "DeepSeek Harness";

  detect(): boolean {
    return Boolean(process.env.DSH_HOME) || existsSync(path.join(home(), ".dsh"));
  }

  paths(): string[] {
    return [dshMcpPath()];
  }

  async link(opts: { write: boolean }): Promise<AdapterAction[]> {
    const file = dshMcpPath();
    const cfg = readJsonIfExists(file) ?? {};
    const servers = getObject(cfg, "mcpServers");
    const { command, args } = mcpCommandSpec();
    const desired = { type: "stdio", command, args, env: { AI_MEMORY_AGENT: "dsh" } };
    const changed = JSON.stringify(servers[MCP_NAME]) !== JSON.stringify(desired);
    servers[MCP_NAME] = desired;
    if (changed) writeJson(file, cfg, opts.write);
    return [
      plan(
        file,
        `register MCP server "${MCP_NAME}" (stdio) for DSH tools`,
        changed,
        JSON.stringify({ mcpServers: { [MCP_NAME]: desired } }, null, 2)
      )
    ];
  }

  async unlink(opts: { write: boolean }): Promise<AdapterAction[]> {
    const file = dshMcpPath();
    const cfg = readJsonIfExists(file);
    if (!cfg) return [plan(file, "nothing to do (no config file)", false)];
    const servers = cfg.mcpServers as Record<string, unknown> | undefined;
    const removed = Boolean(servers && MCP_NAME in servers);
    if (servers) delete servers[MCP_NAME];
    if (removed) writeJson(file, cfg, opts.write);
    return [plan(file, `remove MCP server "${MCP_NAME}"`, removed)];
  }

  async status(): Promise<{ linked: boolean; detail: string }> {
    const cfg = readJsonIfExists(dshMcpPath());
    const servers = cfg?.mcpServers as Record<string, unknown> | undefined;
    const linked = Boolean(servers && MCP_NAME in servers);
    return { linked, detail: `mcp=${linked ? "yes" : "no"} (${dshMcpPath()})` };
  }
}
