import type { Adapter } from "./types.js";
import type { AdapterAction } from "./fs.js";
import { existsSync, mcpCommandSpec, plan, readJsonIfExists, readTextIfExists, stripBom, writeJson, writeText } from "./fs.js";
import { hasSection, tomlLiteral, tomlString, upsertSection } from "./toml.js";
import { MANAGED_BLOCK_BEGIN, readManagedFile, removeManagedBlock, renderAgentsBlock, upsertManagedBlock } from "./instructions.js";
import { SERVER_NAME, type AgentSpec } from "./specs.js";

/**
 * Any MCP client, driven by a declaration instead of a class (see specs.ts).
 *
 * Same contract as the built-in adapters, enforced by the shared `Adapter`
 * interface: read the file, change only the keys we own, never write without
 * `write: true`, and leave a `.ai-memory.bak` the first time a file is touched.
 */
export class GenericAdapter implements Adapter {
  readonly id: string;
  readonly label: string;

  constructor(id: string, private spec: AgentSpec) {
    this.id = id;
    this.label = `${id} (declared)`;
  }

  /** Declaring an agent *is* the statement that it is installed here. */
  detect(): boolean {
    return true;
  }

  paths(): string[] {
    return [this.spec.mcpFile, ...(this.spec.instructions ? [this.spec.instructions] : [])];
  }

  private get isToml(): boolean {
    return this.spec.format === "toml";
  }

  private get mapPath(): string {
    return this.spec.jsonPath ?? (this.isToml ? "mcp_servers" : "mcpServers");
  }

  private get header(): string {
    return `${this.mapPath}.${SERVER_NAME}`;
  }

  private serverEntry(): { type: string; command: string; args: string[]; env: Record<string, string> } {
    const { command, args } = mcpCommandSpec();
    return { type: "stdio", command, args, env: { AI_MEMORY_AGENT: this.id, ...(this.spec.env ?? {}) } };
  }

  private tomlBody(): string[] {
    const entry = this.serverEntry();
    return [
      `type = "stdio"`,
      `command = ${tomlLiteral(entry.command)}`,
      `args = [${entry.args.map(tomlString).join(", ")}]`,
      `[${this.header}.env]`,
      ...Object.entries(entry.env).map(([k, v]) => `${k} = ${tomlString(v)}`)
    ];
  }

  async link(opts: { write: boolean }): Promise<AdapterAction[]> {
    const actions: AdapterAction[] = [];

    if (this.isToml) {
      const file = this.spec.mcpFile;
      const current = stripBom(readTextIfExists(file) ?? "");
      const body = this.tomlBody();
      const next = upsertSection(current, { path: file, header: this.header, body });
      const changed = next !== current;
      actions.push(
        plan(file, `${hasSection(current, this.header) ? "update" : "add"} [${this.header}] (stdio MCP server)`, changed, `[${this.header}]\n${body.join("\n")}`)
      );
      if (changed) writeText(file, next, opts.write);
    } else {
      const file = this.spec.mcpFile;
      const cfg = readJsonIfExists(file) ?? {};
      const desired = this.serverEntry();
      const map = serverMap(cfg, this.mapPath, true)!;
      const changed = JSON.stringify(map[SERVER_NAME]) !== JSON.stringify(desired);
      map[SERVER_NAME] = desired;
      if (changed) writeJson(file, cfg, opts.write);
      actions.push(plan(file, `register MCP server "${SERVER_NAME}" at ${this.mapPath}`, changed, JSON.stringify(desired, null, 2)));
    }

    if (this.spec.instructions) {
      const file = this.spec.instructions;
      const current = readManagedFile(file);
      const block = renderAgentsBlock();
      const next = upsertManagedBlock(current, block);
      const changed = next !== current;
      actions.push(plan(file, `${current.includes(MANAGED_BLOCK_BEGIN) ? "update" : "add"} managed memory instructions block`, changed, block));
      if (changed) writeText(file, next, opts.write);
    }

    return actions;
  }

  async unlink(opts: { write: boolean }): Promise<AdapterAction[]> {
    const actions: AdapterAction[] = [];

    if (this.isToml) {
      const file = this.spec.mcpFile;
      const current = readTextIfExists(file);
      if (current !== null) {
        const next = upsertSection(stripBom(current), { path: file, header: this.header, body: null });
        const changed = next !== current;
        actions.push(plan(file, `remove [${this.header}]`, changed));
        if (changed) writeText(file, next, opts.write);
      }
    } else {
      const file = this.spec.mcpFile;
      const cfg = readJsonIfExists(file);
      if (cfg) {
        const map = serverMap(cfg, this.mapPath, false);
        const removed = Boolean(map && SERVER_NAME in map);
        if (map) delete map[SERVER_NAME];
        actions.push(plan(file, `remove MCP server "${SERVER_NAME}"`, removed));
        if (removed) writeJson(file, cfg, opts.write);
      }
    }

    if (this.spec.instructions) {
      const file = this.spec.instructions;
      if (existsSync(file)) {
        const current = readManagedFile(file);
        const next = removeManagedBlock(current);
        const changed = next !== current;
        actions.push(plan(file, "remove managed memory instructions block", changed));
        if (changed) writeText(file, next, opts.write);
      }
    }

    return actions;
  }

  async status(): Promise<{ linked: boolean; detail: string }> {
    const suffix = this.spec.instructions ? ` + ${this.spec.instructions}` : "";
    try {
      if (this.isToml) {
        const linked = hasSection(stripBom(readTextIfExists(this.spec.mcpFile) ?? ""), this.header);
        return { linked, detail: `mcp=${linked ? "yes" : "no"}${suffix} (${this.spec.mcpFile})` };
      }
      const cfg = readJsonIfExists(this.spec.mcpFile);
      const map = cfg ? serverMap(cfg, this.mapPath, false) : null;
      const linked = JSON.stringify(map?.[SERVER_NAME]) === JSON.stringify(this.serverEntry());
      return { linked, detail: `mcp=${linked ? "yes" : "no"}${suffix} (${this.spec.mcpFile})` };
    } catch (err) {
      return { linked: false, detail: `unreadable: ${(err as Error).message}` };
    }
  }
}

/**
 * Walk a dotted key path. `create` is what separates a write from a read: a read
 * must never invent the keys it is looking for.
 */
function serverMap(cfg: Record<string, unknown>, keyPath: string, create: boolean): Record<string, unknown> | null {
  let cur: Record<string, unknown> = cfg;
  for (const part of keyPath.split(".")) {
    const next = cur[part];
    if (next && typeof next === "object" && !Array.isArray(next)) {
      cur = next as Record<string, unknown>;
      continue;
    }
    if (!create) return null;
    const fresh: Record<string, unknown> = {};
    cur[part] = fresh;
    cur = fresh;
  }
  return cur;
}
