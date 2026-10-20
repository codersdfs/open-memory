import path from "node:path";
import { existsSync } from "node:fs";
import { resolveHome } from "../core/dbPath.js";
import type { AgentSpec } from "./specs.js";

/**
 * Known MCP clients, as data.
 *
 * The four class-based adapters (claude, codex, dsh, pi) earn their classes because
 * they write more than an MCP entry: hooks, a TOML section, a managed instructions
 * block. Every other client below differs from its neighbour only in *where its
 * config file is* and *where the server map sits inside it* — which is exactly the
 * shape `AgentSpec` already describes, and exactly what `GenericAdapter` already
 * does. Adding a client here is therefore a data change, not a code path: no new
 * class, no new branch in `link`, no new test per client.
 *
 * The entries are ordered by how many people are likely to have them installed. The
 * `detect` path is a *directory that only that client creates*; a config file alone
 * is not proof, because several clients create their config lazily on first launch
 * and an empty `~/.cursor/` would otherwise be indistinguishable from a real one.
 */

export interface KnownAgent {
  id: string;
  label: string;
  /**
   * Absolute paths, any one of which means "this client is installed here".
   * A directory is the stronger signal; a config file is accepted when the client
   * has no dedicated home directory of its own.
   */
  detect: (home: string) => string[];
  spec: (home: string) => AgentSpec;
}

const vsCodeUser = (home: string): string => {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim() || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Code", "User");
  }
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Code", "User");
  return path.join(home, ".config", "Code", "User");
};

/**
 * Zed keeps the same `context_servers` map on every platform, but the file lives
 * under the platform config root.
 */
const zedConfig = (home: string): string => {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim() || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Zed", "settings.json");
  }
  if (process.platform === "darwin") return path.join(home, ".zed", "settings.json");
  return path.join(home, ".config", "zed", "settings.json");
};

export const KNOWN_AGENTS: KnownAgent[] = [
  {
    id: "cursor",
    label: "Cursor",
    detect: (home) => [path.join(home, ".cursor")],
    spec: (home) => ({ mcpFile: path.join(home, ".cursor", "mcp.json"), format: "json" })
  },
  {
    id: "windsurf",
    label: "Windsurf",
    detect: (home) => [path.join(home, ".codeium", "windsurf")],
    spec: (home) => ({ mcpFile: path.join(home, ".codeium", "windsurf", "mcp_config.json"), format: "json" })
  },
  {
    id: "cline",
    label: "Cline (VS Code)",
    detect: (home) => [path.join(home, ".cline")],
    spec: (home) => {
      const dir = path.join(home, ".cline", "data");
      return { mcpFile: path.join(dir, "cline_mcp_settings.json"), format: "json" };
    }
  },
  {
    id: "zed",
    label: "Zed",
    detect: (home) => [path.dirname(zedConfig(home))],
    // JSONC, not JSON: Zed's settings.json ships a commented header
    // ("// Zed settings"), so a strict parse refuses the file. The splicer keeps
    // those comments while inserting `context_servers.ai-memory`.
    spec: (home) => ({ mcpFile: zedConfig(home), jsonPath: "context_servers", format: "jsonc" })
  },
  {
    id: "continue",
    label: "Continue",
    detect: (home) => [path.join(home, ".continue")],
    // Continue's assistant-level map is `experimental.modelContextProtocolServers`;
    // the documented, stable path for user-level servers is the `mcpServers` block.
    spec: (home) => {
      const dir = path.join(home, ".continue");
      return { mcpFile: path.join(dir, "mcpServers", "ai-memory.json"), format: "json" };
    }
  },
  {
    id: "vscode",
    label: "VS Code (GitHub Copilot)",
    detect: (home) => [vsCodeUser(home)],
    // VS Code keeps MCP servers in `mcp.json`, which is JSONC like the rest of its
    // settings; declaring it jsonc means a commented file is edited, not refused.
    spec: (home) => ({ mcpFile: path.join(vsCodeUser(home), "mcp.json"), jsonPath: "servers", format: "jsonc" })
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    detect: (home) => [path.join(home, ".gemini")],
    spec: (home) => ({ mcpFile: path.join(home, ".gemini", "settings.json"), format: "json" })
  },
  {
    id: "opencode",
    label: "opencode",
    detect: (home) => [path.join(home, ".config", "opencode"), path.join(home, ".opencode")],
    spec: (home) => {
      const local = path.join(home, ".config", "opencode", "opencode.json");
      const legacy = path.join(home, ".opencode", "config.json");
      return { mcpFile: existsSync(local) || !existsSync(legacy) ? local : legacy, format: "json" };
    }
  },
  {
    id: "qwen",
    label: "Qwen Code",
    detect: (home) => [path.join(home, ".qwen")],
    spec: (home) => ({ mcpFile: path.join(home, ".qwen", "settings.json"), format: "json" })
  },
  {
    id: "crush",
    label: "Crush",
    detect: (home) => [path.join(home, ".config", "crush")],
    spec: (home) => ({ mcpFile: path.join(home, ".config", "crush", "crush.json"), format: "json" })
  },
  {
    id: "amp",
    label: "Amp",
    detect: (home) => [path.join(home, ".config", "amp")],
    spec: (home) => ({ mcpFile: path.join(home, ".config", "amp", "settings.json"), format: "json" })
  },
  {
    id: "aider",
    label: "Aider (MCP bridge)",
    detect: (home) => [path.join(home, ".aider")],
    spec: (home) => ({ mcpFile: path.join(home, ".aider", "mcp.json"), format: "json" })
  }
];

/**
 * Ids the known list also accepts under a common alias, so `agent link --agent
 * windsurf-codeium` is not a mystery failure. The canonical id is what gets written
 * into `AI_MEMORY_AGENT`, so the namespace does not fork on a spelling.
 */
export const ALIASES: Record<string, string> = {
  windsurf: "windsurf",
  codeium: "windsurf",
  "cursor-ide": "cursor",
  copilot: "vscode",
  "vscode-copilot": "vscode",
  geminiCli: "gemini",
  "gemini-cli": "gemini",
  qwencode: "qwen",
  "qwen-code": "qwen",
  opencodeAi: "opencode"
};

export function findKnown(id: string, home = resolveHome()): KnownAgent | undefined {
  const canonical = ALIASES[id] ?? id;
  return KNOWN_AGENTS.find((k) => k.id === canonical);
}

/** Which known clients exist on this machine. */
export function detectKnown(home = resolveHome()): KnownAgent[] {
  return KNOWN_AGENTS.filter((k) => k.detect(home).some((p) => existsSync(p)));
}
