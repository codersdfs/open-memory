import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgentCommand, runContextCommand } from "../src/adapters/cli.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter, upsertManagedBlock, removeManagedBlock, renderAgentsBlock, codexSectionBody } from "../src/adapters/codex.js";
import { PiAdapter } from "../src/adapters/pi.js";
import { DshAdapter } from "../src/adapters/dsh.js";
import { upsertSection, hasSection, tomlLiteral } from "../src/adapters/toml.js";
import { createRegistry } from "../src/adapters/index.js";
import { cliEntryPath, mcpCommandSpec } from "../src/adapters/fs.js";

/**
 * Adapter tests.
 *
 * Every case runs against a throwaway home directory (`HOME`/`USERPROFILE` + the
 * per-agent overrides) so the real `~/.claude.json` on the machine is never touched.
 * The properties that matter and are asserted here:
 *   1. unrelated configuration survives a link/unlink byte for byte;
 *   2. link is idempotent, and unlink removes only what link added;
 *   3. nothing is written unless `write: true`.
 */

let home: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["HOME", "USERPROFILE", "CODEX_HOME", "PI_HOME", "DSH_HOME", "AI_MEMORY_AGENT", "AI_MEMORY_CLI", "AI_MEMORY_MCP_COMMAND"];

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "ai-memory-adapters-"));
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.AI_MEMORY_CLI = path.join(home, "dist", "cli", "index.js");
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  rmSync(home, { recursive: true, force: true });
});

function ctx() {
  const lines: string[] = [];
  const errs: string[] = [];
  return { json: false, out: (s: string) => lines.push(s), err: (s: string) => errs.push(s), lines, errs };
}

describe("toml section editing", () => {
  it("adds, replaces and removes a section without touching neighbours", () => {
    const original = `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = 'other'\n\n[history]\npersistence = "save-all"\n`;
    const added = upsertSection(original, { path: "x", header: "mcp_servers.ai-memory", body: ["type = \"stdio\""] });
    expect(added).toContain("[mcp_servers.ai-memory]");
    expect(added).toContain("[mcp_servers.other]");
    expect(added).toContain("[history]");
    expect(added).toContain('model = "gpt-5"');

    const replaced = upsertSection(added, { path: "x", header: "mcp_servers.ai-memory", body: ["type = \"http\""] });
    expect(replaced).toContain('type = "http"');
    expect(replaced).not.toContain('type = "stdio"');
    expect(replaced.match(/\[mcp_servers\.ai-memory\]/g)).toHaveLength(1);

    const removed = upsertSection(replaced, { path: "x", header: "mcp_servers.ai-memory", body: null });
    expect(hasSection(removed, "mcp_servers.ai-memory")).toBe(false);
    expect(removed).toContain("[history]");
  });

  it("does not reflow Windows paths in literal strings", () => {
    expect(tomlLiteral("C:\\Users\\frank\\.dsh")).toBe("'C:\\Users\\frank\\.dsh'");
  });
});

describe("claude adapter", () => {
  it("preserves unrelated ~/.claude.json state and unrelated hooks", async () => {
    const claudeJson = path.join(home, ".claude.json");
    writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { "C:/code": { allowedTools: [] } }, mcpServers: { existing: { command: "x" } } }, null, 2)
    );
    const settings = path.join(home, ".claude", "settings.json");
    mkdirSync(path.dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool" }] }] }, model: "opus" }, null, 2));

    const adapter = new ClaudeAdapter();
    const actions = await adapter.link({ write: true });
    expect(actions.every((a) => a.changed)).toBe(true);

    const cfg = JSON.parse(readFileSync(claudeJson, "utf8"));
    expect(cfg.projects["C:/code"]).toEqual({ allowedTools: [] });
    expect(cfg.mcpServers.existing).toEqual({ command: "x" });
    expect(cfg.mcpServers["ai-memory"].args).toEqual([process.env.AI_MEMORY_CLI, "mcp"]);

    const s = JSON.parse(readFileSync(settings, "utf8"));
    expect(s.model).toBe("opus");
    expect(JSON.stringify(s.hooks.Stop)).toContain("other-tool");
    expect(JSON.stringify(s.hooks.SessionStart)).toContain("ai-memory");

    // idempotent
    const second = await adapter.link({ write: true });
    expect(second.every((a) => !a.changed)).toBe(true);

    // unlink removes only ours
    await adapter.unlink({ write: true });
    const cfg2 = JSON.parse(readFileSync(claudeJson, "utf8"));
    expect(cfg2.mcpServers.existing).toEqual({ command: "x" });
    expect(cfg2.mcpServers["ai-memory"]).toBeUndefined();
    const s2 = JSON.parse(readFileSync(settings, "utf8"));
    expect(JSON.stringify(s2.hooks)).toContain("other-tool");
    expect(JSON.stringify(s2.hooks)).not.toContain("ai-memory");
  });

  it("writes nothing without --write", async () => {
    const adapter = new ClaudeAdapter();
    const actions = await adapter.link({ write: false });
    expect(actions.some((a) => a.changed)).toBe(true);
    expect(existsSync(path.join(home, ".claude.json"))).toBe(false);
    expect(existsSync(path.join(home, ".claude", "settings.json"))).toBe(false);
  });

  it("refuses to clobber a corrupt config file", async () => {
    writeFileSync(path.join(home, ".claude.json"), "{ this is not json");
    await expect(new ClaudeAdapter().link({ write: true })).rejects.toThrow(/not valid JSON/);
  });
});

describe("codex adapter", () => {
  it("writes a section and a managed AGENTS.md block, and reverses both", async () => {
    const dir = path.join(home, ".codex");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.toml"), `# my codex config\napproval_policy = "never"\n`);
    writeFileSync(path.join(dir, "AGENTS.md"), "# House rules\n\nAlways run tests.\n");

    const adapter = new CodexAdapter();
    await adapter.link({ write: true });

    const toml = readFileSync(path.join(dir, "config.toml"), "utf8");
    expect(toml).toContain("# my codex config");
    expect(toml).toContain('approval_policy = "never"');
    expect(toml).toContain("[mcp_servers.ai-memory]");
    expect(toml).toContain("[mcp_servers.ai-memory.env]");
    // `command` is the runtime; the cli entry rides in `args`.
    expect(toml).toMatch(/^command = '.*node.*'$/im);
    expect(toml).toContain("index.js");

    const md = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(md).toContain("# House rules");
    expect(md).toContain("Always run tests.");
    expect(md).toContain("<!-- ai-memory:begin -->");
    expect(md.endsWith("\n")).toBe(true);

    await adapter.link({ write: true });
    expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8").match(/ai-memory:begin/g)).toHaveLength(1);

    await adapter.unlink({ write: true });
    const toml2 = readFileSync(path.join(dir, "config.toml"), "utf8");
    expect(hasSection(toml2, "mcp_servers.ai-memory")).toBe(false);
    expect(toml2).toContain('approval_policy = "never"');
    const md2 = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(md2).toContain("Always run tests.");
    expect(md2).not.toContain("ai-memory:begin");
  });

  it("honours CODEX_HOME", async () => {
    const custom = path.join(home, "codex-home");
    process.env.CODEX_HOME = custom;
    try {
      await new CodexAdapter().link({ write: true });
      expect(existsSync(path.join(custom, "config.toml"))).toBe(true);
      expect(existsSync(path.join(custom, "AGENTS.md"))).toBe(true);
    } finally {
      delete process.env.CODEX_HOME;
    }
  });

  it("managed block helpers are stable", () => {
    const block = renderAgentsBlock();
    const base = "existing\n";
    const once = upsertManagedBlock(base, block);
    const twice = upsertManagedBlock(once, block);
    expect(twice).toBe(once);
    expect(removeManagedBlock(once).trim()).toBe("existing");
    expect(codexSectionBody().join("\n")).toContain("startup_timeout_sec");
  });
});

describe("pi and dsh adapters", () => {
  it("pi registers with directTools and keeps other servers", async () => {
    const file = path.join(home, ".pi", "agent", "mcp-adapter.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: { ScraplingServer: { command: "x", env: {}, directTools: true } } }, null, 2));

    await new PiAdapter().link({ write: true });
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    expect(cfg.mcpServers.ScraplingServer).toBeTruthy();
    expect(cfg.mcpServers["ai-memory"].directTools).toBe(true);
    expect(cfg.mcpServers["ai-memory"].env.AI_MEMORY_AGENT).toBe("pi");

    await new PiAdapter().unlink({ write: true });
    const cfg2 = JSON.parse(readFileSync(file, "utf8"));
    expect(cfg2.mcpServers.ScraplingServer).toBeTruthy();
    expect(cfg2.mcpServers["ai-memory"]).toBeUndefined();
  });

  it("dsh writes to DSH_HOME/mcp.json", async () => {
    const dshHome = path.join(home, "dsh-home");
    process.env.DSH_HOME = dshHome;
    try {
      const adapter = new DshAdapter();
      expect(adapter.detect()).toBe(true);
      await adapter.link({ write: true });
      const cfg = JSON.parse(readFileSync(path.join(dshHome, "mcp.json"), "utf8"));
      expect(cfg.mcpServers["ai-memory"].type).toBe("stdio");
      expect(cfg.mcpServers["ai-memory"].env.AI_MEMORY_AGENT).toBe("dsh");
      expect((await adapter.status()).linked).toBe(true);
    } finally {
      delete process.env.DSH_HOME;
    }
  });

  it("registry exposes every agent from ADR-0007", () => {
    expect(createRegistry().ids().sort()).toEqual(["claude", "codex", "dsh", "pi"]);
  });

  it("cliEntryPath points at a real build output, not a stale dist/cli path", () => {
    delete process.env.AI_MEMORY_CLI;
    try {
      const entry = cliEntryPath();
      expect(entry).toMatch(/[\\/]index\.js$/);
      // tsconfig uses rootDir ".", so the build output lives under dist/src.
      expect(entry.split(/[\\/]/)).toContain("dist");
      expect(entry).toContain("cli");
      // And what adapters emit must be the same path.
      expect(mcpCommandSpec().args[0]).toBe(entry);
    } finally {
      process.env.AI_MEMORY_CLI = path.join(home, "dist", "cli", "index.js");
    }
  });
});

describe("agent CLI", () => {
  it("list works with no agent installed", async () => {
    const c = ctx();
    expect(await runAgentCommand(["list"], {}, c)).toBe(0);
    expect(c.lines.join("\n")).toContain("claude");
    expect(c.lines.join("\n")).toContain("not set");
  });

  it("reports an unknown --agent instead of guessing", async () => {
    const c = ctx();
    expect(await runAgentCommand(["link"], { agent: "vscode" }, c)).toBe(2);
    expect(c.errs.join("\n")).toMatch(/unknown agent/);
  });

  it("link --agent claude --write links only claude", async () => {
    const c = ctx();
    expect(await runAgentCommand(["link"], { agent: "claude", write: true }, c)).toBe(0);
    expect(existsSync(path.join(home, ".claude.json"))).toBe(true);
    expect(existsSync(path.join(home, ".codex", "config.toml"))).toBe(false);
  });

  it("doctor reports the cli build and exits non-zero when it is missing", async () => {
    const c = ctx();
    const code = await runAgentCommand(["doctor"], {}, c);
    expect(code).toBe(1);
    expect(c.lines.join("\n")).toMatch(/cli build\s+.*ai-memory|cli build/);
    expect(c.lines.join("\n")).toContain("FAIL");
  });

  it("doctor passes once the cli entry exists", async () => {
    const cli = process.env.AI_MEMORY_CLI!;
    mkdirSync(path.dirname(cli), { recursive: true });
    writeFileSync(cli, "// stub\n");
    const c = ctx();
    expect(await runAgentCommand(["doctor"], { agent: "claude" }, c)).toBe(0);
    expect(c.lines.join("\n")).toContain("all checks passed");
  });

  it("status and context refresh are readable in json mode", async () => {
    const c = { ...ctx(), json: true };
    expect(await runAgentCommand(["status"], {}, c)).toBe(0);
    const rows = JSON.parse(c.lines.join("")) as { id: string; linked: boolean }[];
    expect(rows.map((r) => r.id)).toContain("codex");

    const c2 = { ...ctx(), json: true };
    writeFileSync(path.join(home, ".claude.json"), "{}");
    expect(await runContextCommand(["refresh"], { json: true, write: true }, c2)).toBe(0);
    expect(existsSync(path.join(home, ".claude.json"))).toBe(true);
  });
});
