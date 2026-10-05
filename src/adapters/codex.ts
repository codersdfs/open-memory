import path from "node:path";
import { home } from "../memory.js";
import type { Adapter } from "./types.js";
import type { AdapterAction } from "./fs.js";
import { existsSync, hasCommand, mcpCommandSpec, plan, readTextIfExists, stripBom } from "./fs.js";
import { hasSection, tomlLiteral, tomlString, upsertSection, writeToml } from "./toml.js";

/**
 * Codex CLI integration.
 *
 * Codex has no hook mechanism, so memory reaches it through MCP plus a managed block
 * in `~/.codex/AGENTS.md`. `config.toml` is edited section-wise (see toml.ts) because
 * the file contains literal Windows paths that must not be re-escaped.
 */

const SECTION = "mcp_servers.ai-memory";
const BEGIN = "<!-- ai-memory:begin -->";
const END = "<!-- ai-memory:end -->";

export function codexConfigPath(): string {
  return process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "config.toml") : path.join(home(), ".codex", "config.toml");
}

export function codexAgentsPath(): string {
  return process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "AGENTS.md") : path.join(home(), ".codex", "AGENTS.md");
}

export function codexSectionBody(): string[] {
  const { command, args } = mcpCommandSpec();
  return [
    `type = "stdio"`,
    `command = ${tomlLiteral(command)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    `startup_timeout_sec = 30`,
    `[${SECTION}.env]`,
    `AI_MEMORY_AGENT = ${tomlString("codex")}`
  ];
}

export const MANAGED_BLOCK_BEGIN = BEGIN;
export const MANAGED_BLOCK_END = END;

export function renderAgentsBlock(): string {
  return [
    BEGIN,
    "## Memory (ai-memory)",
    "",
    "You have a shared long-term memory available as MCP tools (`memory_search`, `memory_remember`,",
    "`memory_list`, `memory_get`, `memory_forget`, `memory_stats`), and as the `ai-memory` CLI in a shell.",
    "",
    "- Search before guessing about past decisions, project conventions, or user preferences.",
    "- Store durable facts with `memory_remember`. Use `scope: \"shared\"` for anything another agent",
    "  would need; keep agent-specific notes `scope: \"private\"`.",
    "- Never store secrets, tokens, or credentials.",
    END
  ].join("\n");
}

/** Replace the managed block, appending it if absent. Never touches other content. */
export function upsertManagedBlock(content: string, block: string): string {
  const start = content.indexOf(BEGIN);
  const end = content.indexOf(END);
  if (start >= 0 && end > start) {
    return content.slice(0, start) + block + content.slice(end + END.length);
  }
  const sep = content.trim() === "" ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return content + sep + block + "\n";
}

export function removeManagedBlock(content: string): string {
  const start = content.indexOf(BEGIN);
  const end = content.indexOf(END);
  if (start < 0 || end <= start) return content;
  return (content.slice(0, start) + content.slice(end + END.length)).replace(/\n{3,}/g, "\n\n").trimStart();
}

export class CodexAdapter implements Adapter {
  id = "codex";
  label = "Codex CLI";

  detect(): boolean {
    return existsSync(codexConfigPath()) || hasCommand("codex");
  }

  paths(): string[] {
    return [codexConfigPath(), codexAgentsPath()];
  }

  async link(opts: { write: boolean }): Promise<AdapterAction[]> {
    const actions: AdapterAction[] = [];

    const cfgPath = codexConfigPath();
    const current = stripBom(readTextIfExists(cfgPath) ?? "");
    const body = codexSectionBody();
    const had = hasSection(current, SECTION);
    const next = upsertSection(current, { path: cfgPath, header: SECTION, body });
    const cfgChanged = next !== current;
    actions.push(
      plan(
        cfgPath,
        `${had ? "update" : "add"} [${SECTION}] (stdio MCP server)`,
        cfgChanged,
        `[${SECTION}]\n${body.join("\n")}`
      )
    );
    if (cfgChanged) writeToml(cfgPath, next, opts.write);

    const mdPath = codexAgentsPath();
    const md = stripBom(readTextIfExists(mdPath) ?? "");
    const block = renderAgentsBlock();
    const nextMd = upsertManagedBlock(md, block);
    const mdChanged = nextMd !== md;
    actions.push(plan(mdPath, `${md.includes(BEGIN) ? "update" : "add"} managed memory instructions block`, mdChanged, block));
    if (mdChanged) writeToml(mdPath, nextMd, opts.write);

    return actions;
  }

  async unlink(opts: { write: boolean }): Promise<AdapterAction[]> {
    const actions: AdapterAction[] = [];

    const cfgPath = codexConfigPath();
    const current = readTextIfExists(cfgPath);
    if (current !== null) {
      const next = upsertSection(stripBom(current), { path: cfgPath, header: SECTION, body: null });
      const changed = next !== current;
      actions.push(plan(cfgPath, `remove [${SECTION}]`, changed));
      if (changed) writeToml(cfgPath, next, opts.write);
    }

    const mdPath = codexAgentsPath();
    const md = readTextIfExists(mdPath);
    if (md !== null) {
      const next = removeManagedBlock(stripBom(md));
      const changed = next !== md.replace(/^\uFEFF/, "");
      actions.push(plan(mdPath, "remove managed memory instructions block", changed));
      if (changed) writeToml(mdPath, next, opts.write);
    }

    return actions;
  }

  async status(): Promise<{ linked: boolean; detail: string }> {
    const cfg = readTextIfExists(codexConfigPath()) ?? "";
    const linked = hasSection(stripBom(cfg), SECTION);
    const hasBlock = (readTextIfExists(codexAgentsPath()) ?? "").includes(BEGIN);
    return {
      linked,
      detail: `mcp=${linked ? "yes" : "no"} agents-md=${hasBlock ? "yes" : "no"} (${codexConfigPath()})`
    };
  }
}
