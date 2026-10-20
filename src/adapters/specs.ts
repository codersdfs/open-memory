import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expandHome, resolveHome } from "../core/dbPath.js";

/**
 * User-declared agents — `~/.ai-memory/agents.json`.
 *
 * The four built-ins are classes because each does real work beyond a path
 * (Claude Code's hooks, Codex's TOML section). Every *other* MCP client differs
 * from its neighbour by data only: where its config file is, and where the server
 * map sits inside it. That is what this file holds, so `agent add` covers the
 * fifth client without anyone writing a class.
 */
export interface AgentSpec {
  /** The client's MCP config file. `~` is expanded. */
  mcpFile: string;
  /** Where the server map lives: dotted JSON key path (`mcp.servers`), or the TOML table prefix. Defaults per format. */
  jsonPath?: string;
  format?: "json" | "toml";
  /** Extra env for the spawned server entry, on top of `AI_MEMORY_AGENT=<id>`. */
  env?: Record<string, string>;
  /** Optional instructions file (AGENTS.md, rules file) that gets the managed memory block. */
  instructions?: string;
}

/** Server name written into the client config. Same key for every client. */
export const SERVER_NAME = "ai-memory";

/** Agent ids are namespace segments, so they may not contain `:` or whitespace. */
const ID_RE = /^[A-Za-z0-9._-]+$/;

export function agentsFilePath(home = resolveHome()): string {
  return path.join(home, "agents.json");
}

/**
 * Validate one declaration. Returns the normalized spec, or a message naming what
 * is wrong — the same function guards `agent add` and the reader, so a hand-edited
 * file can never be stricter than the CLI that wrote it.
 */
export function validateSpec(id: string, raw: unknown): AgentSpec | string {
  if (!ID_RE.test(id)) return `bad id "${id}" (letters, digits, . _ - only)`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `"${id}": expected an object`;
  const r = raw as Record<string, unknown>;
  const mcpFile = typeof r.mcpFile === "string" ? r.mcpFile.trim() : "";
  if (!mcpFile) return `"${id}": needs "mcpFile"`;
  if (r.format !== undefined && r.format !== "json" && r.format !== "toml") return `"${id}": format must be "json" or "toml"`;
  if (r.jsonPath !== undefined && typeof r.jsonPath !== "string") return `"${id}": jsonPath must be a string`;
  if (r.instructions !== undefined && typeof r.instructions !== "string") return `"${id}": instructions must be a path string`;

  let env: Record<string, string> | undefined;
  if (r.env !== undefined) {
    if (!r.env || typeof r.env !== "object" || Array.isArray(r.env)) return `"${id}": env must be an object of string values`;
    env = {};
    for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
      if (typeof v !== "string") return `"${id}": env.${k} must be a string`;
      env[k] = v;
    }
  }

  const jsonPath = typeof r.jsonPath === "string" && r.jsonPath.trim() ? r.jsonPath.trim() : undefined;
  const instructions = typeof r.instructions === "string" && r.instructions.trim() ? expandHome(r.instructions.trim()) : undefined;
  return {
    mcpFile: expandHome(mcpFile),
    ...(jsonPath ? { jsonPath } : {}),
    format: r.format === "toml" ? "toml" : "json",
    ...(env ? { env } : {}),
    ...(instructions ? { instructions } : {})
  };
}

/**
 * Read declarations. Never throws: a file the user broke by hand degrades to
 * "no declared agents" plus a message, because `agent list` and `doctor` have to
 * keep working on a machine where someone fat-fingered a comma.
 */
export function readSpecs(file = agentsFilePath()): { specs: Record<string, AgentSpec>; errors: string[] } {
  if (!existsSync(file)) return { specs: {}, errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    return { specs: {}, errors: [`${file}: not valid JSON (${(err as Error).message})`] };
  }
  const agents = (parsed as { agents?: unknown } | null)?.agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    return { specs: {}, errors: [`${file}: expected { "agents": { "<id>": { "mcpFile": ... } } }`] };
  }
  const specs: Record<string, AgentSpec> = {};
  const errors: string[] = [];
  for (const [id, raw] of Object.entries(agents as Record<string, unknown>)) {
    const spec = validateSpec(id, raw);
    if (typeof spec === "string") errors.push(`${file}: ${spec}`);
    else specs[id] = spec;
  }
  return { specs, errors };
}

export function writeSpecs(specs: Record<string, AgentSpec>, write: boolean, file = agentsFilePath()): void {
  if (!write) return;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ agents: specs }, null, 2) + "\n", "utf8");
}
