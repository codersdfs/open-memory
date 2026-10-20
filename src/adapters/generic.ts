import type { Adapter } from "./types.js";
import type { AdapterAction } from "./fs.js";
import { existsSync, mcpCommandSpec, plan, readJsonIfExists, readTextIfExists, stripBom, writeJson, writeText } from "./fs.js";
import { parseJsonc, removeJsoncPath, setJsoncPath } from "./jsonc.js";
import { hasSection, tomlLiteral, tomlString, upsertSection } from "./toml.js";
import { MANAGED_BLOCK_BEGIN, readManagedFile, removeManagedBlock, renderAgentsBlock, upsertManagedBlock } from "./instructions.js";
import { SERVER_NAME, type AgentSpec } from "./specs.js";
import type { KnownAgent } from "./known.js";
import { homedir } from "node:os";

/**
 * Any MCP client, driven by a declaration instead of a class (see specs.ts).
 *
 * Same contract as the built-in adapters, enforced by the shared `Adapter`
 * interface: read the file, change only the keys we own, never write without
 * `write: true`, and leave a `.ai-memory.bak` the first time a file is touched.
 *
 * Three formats, because three shapes of real config exist:
 *   - `json`  — a strict JSON object; edited by round-trip (the file was machine
 *               output, so reformatting it loses nothing);
 *   - `jsonc` — JSON with comments (Zed, VS Code); edited by *splice*, because
 *               round-tripping would delete the user's comments;
 *   - `toml`  — a section upsert, for clients that keep everything in TOML.
 */
export class GenericAdapter implements Adapter {
  readonly id: string;
  readonly label: string;

  constructor(id: string, private spec: AgentSpec, label?: string, private known?: KnownAgent) {
    this.id = id;
    // A known client (known.ts) passes its product name; a user declaration has no
    // name to show, so it says where it came from.
    this.label = label ?? `${id} (declared)`;
  }

  /**
   * Declaring an agent *is* the statement that it is installed here — but that holds
   * only for declarations. A known client is listed whether or not it is on this
   * machine, so it has to ask: the answer comes from the same directory probe
   * `agent list` used before it had a catalogue. Returning `true` for both made every
   * client look installed and made a bare `agent link` write into all twelve.
   */
  detect(): boolean {
    if (!this.known) return true;
    return this.known.detect(homedir()).some((p) => existsSync(p));
  }

  paths(): string[] {
    return [this.spec.mcpFile, ...(this.spec.instructions ? [this.spec.instructions] : [])];
  }

  private get isToml(): boolean {
    return this.spec.format === "toml";
  }

  private get isJsonc(): boolean {
    return this.spec.format === "jsonc";
  }

  private get mapPath(): string {
    return this.spec.jsonPath ?? (this.isToml ? "mcp_servers" : "mcpServers");
  }

  private get header(): string {
    return `${this.mapPath}.${SERVER_NAME}`;
  }

  /** `mcp.servers` → `["mcp","servers"]`; the JSONC splicer walks this by key. */
  private pathParts(): string[] {
    return this.mapPath.split(".").filter((p) => p.length > 0);
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
    } else if (this.isJsonc) {
      const file = this.spec.mcpFile;
      const current = stripBom(readTextIfExists(file) ?? "");
      const desired = this.serverEntry();
      // The file may not exist yet; an empty document is an empty object. It cannot
      // start as "" because setJsoncPath splices into a parsed object.
      const base = current.trim() === "" ? "{}\n" : current;
      const edit = setJsoncPath(base, [...this.pathParts(), SERVER_NAME], desired);
      if (edit.changed) writeText(file, edit.text, opts.write);
      actions.push(
        plan(file, `register MCP server "${SERVER_NAME}" at ${this.mapPath} (JSONC, comments preserved)`, edit.changed, JSON.stringify(desired, null, 2))
      );
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
    } else if (this.isJsonc) {
      const file = this.spec.mcpFile;
      const current = stripBom(readTextIfExists(file) ?? "");
      if (current.trim() !== "") {
        const edit = removeJsoncPath(current, [...this.pathParts(), SERVER_NAME]);
        actions.push(plan(file, `remove MCP server "${SERVER_NAME}" at ${this.mapPath} (JSONC)`, edit.changed));
        if (edit.changed) writeText(file, edit.text, opts.write);
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
      if (this.isJsonc) {
        const raw = readTextIfExists(this.spec.mcpFile);
        if (raw === null) return { linked: false, detail: `mcp=no${suffix} (${this.spec.mcpFile})` };
        const cfg = parseJsonc<Record<string, unknown>>(stripBom(raw));
        const map = serverMap(cfg, this.mapPath, false);
        const linked = JSON.stringify(map?.[SERVER_NAME]) === JSON.stringify(this.serverEntry());
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
