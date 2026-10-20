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
const ENV = ["HOME", "USERPROFILE", "AI_MEMORY_HOME", "CODEX_HOME", "PI_HOME", "DSH_HOME", "AI_MEMORY_AGENT", "AI_MEMORY_CLI", "AI_MEMORY_MCP_COMMAND"];

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

/**
 * Declared agents — the answer to "my client is not one of the four".
 *
 * The property that matters is the same one the built-in adapters are held to: a
 * client's config file survives link/unlink byte for byte apart from our entry.
 */
describe("declared agents (agents.json)", () => {
  const clientFile = () => path.join(home, ".cursor", "mcp.json");
  // The memory home is `~/.ai-memory`, so the declaration file sits one level in.
  const specsFile = () => path.join(home, ".ai-memory", "agents.json");

  function seedClient(file = clientFile()): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }, null, 2));
  }

  /** The memory home only exists once setup has run, so seed it by hand. */
  function seedSpecs(raw: string): void {
    mkdirSync(path.dirname(specsFile()), { recursive: true });
    writeFileSync(specsFile(), raw);
  }

  it("adds, links, reports, unlinks and removes a client with no adapter class", async () => {
    seedClient();
    const file = clientFile();

    // dry run: no declaration, no entry
    expect(await runAgentCommand(["add", "cursor"], { "mcp-file": file }, ctx())).toBe(0);
    expect(existsSync(specsFile())).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers["ai-memory"]).toBeUndefined();

    expect(await runAgentCommand(["add", "cursor"], { "mcp-file": file, write: true }, ctx())).toBe(0);
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    expect(cfg.mcpServers.other).toEqual({ command: "x" });
    expect(cfg.theme).toBe("dark");
    expect(cfg.mcpServers["ai-memory"].type).toBe("stdio");
    expect(cfg.mcpServers["ai-memory"].env.AI_MEMORY_AGENT).toBe("cursor");
    expect(cfg.mcpServers["ai-memory"].args).toEqual([process.env.AI_MEMORY_CLI, "mcp"]);
    expect(JSON.parse(readFileSync(specsFile(), "utf8")).agents.cursor.mcpFile).toBe(file);

    // the registry serves it, and says it is linked
    expect(createRegistry().ids()).toContain("cursor");
    const s = { ...ctx(), json: true };
    expect(await runAgentCommand(["status"], { agent: "cursor" }, s)).toBe(0);
    const rows = JSON.parse(s.lines.join("")) as { id: string; linked: boolean }[];
    expect(rows.find((r) => r.id === "cursor")).toMatchObject({ linked: true });

    // idempotent
    const before = readFileSync(file, "utf8");
    expect(await runAgentCommand(["add", "cursor"], { "mcp-file": file, write: true }, ctx())).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(before);

    // unlink removes our entry and nothing else
    expect(await runAgentCommand(["unlink"], { agent: "cursor", write: true }, ctx())).toBe(0);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.mcpServers.other).toEqual({ command: "x" });
    expect(after.mcpServers["ai-memory"]).toBeUndefined();
    expect(after.theme).toBe("dark");

    // remove drops the declaration; the registry forgets it
    expect(await runAgentCommand(["remove", "cursor"], { write: true }, ctx())).toBe(0);
    expect(createRegistry().ids()).not.toContain("cursor");
    expect(JSON.parse(readFileSync(specsFile(), "utf8")).agents).toEqual({});
  });

  it("rejects a declaration with no config file", async () => {
    const c = ctx();
    expect(await runAgentCommand(["add", "cursor"], {}, c)).toBe(2);
    expect(c.errs.join("\n")).toMatch(/--mcp-file/);
    expect(existsSync(specsFile())).toBe(false);
  });

  it("refuses a built-in id instead of silently dropping its hooks", async () => {
    seedClient();
    const c = ctx();
    expect(await runAgentCommand(["add", "claude"], { "mcp-file": clientFile(), write: true }, c)).toBe(2);
    expect(c.errs.join("\n")).toMatch(/built-in adapter/);
    expect(existsSync(specsFile())).toBe(false);
    expect(JSON.parse(readFileSync(clientFile(), "utf8")).mcpServers["ai-memory"]).toBeUndefined();

    // A hand-edited collision is refused at load too, and doctor names it rather than
    // letting a declaration quietly do less than the adapter it replaced.
    mkdirSync(path.dirname(process.env.AI_MEMORY_CLI!), { recursive: true });
    writeFileSync(process.env.AI_MEMORY_CLI!, "// stub\n");
    seedSpecs(JSON.stringify({ agents: { claude: { mcpFile: clientFile() } } }));
    expect(createRegistry().get("claude")).toBeInstanceOf(ClaudeAdapter);
    expect(createRegistry().ids().sort()).toEqual(["claude", "codex", "dsh", "pi"]);

    const d = ctx();
    expect(await runAgentCommand(["doctor"], {}, d)).toBe(1);
    expect(d.lines.join("\n")).toMatch(/built-in id\(s\) ignored — claude/);

    // The escape hatch: the declaration is still removable by hand.
    expect(await runAgentCommand(["remove", "claude"], { write: true }, ctx())).toBe(0);
    expect(await runAgentCommand(["doctor"], {}, ctx())).toBe(0);
  });

  it("honours a hand-written declaration with an instructions file", async () => {
    seedClient();
    const rules = path.join(home, "RULES.md");
    writeFileSync(rules, "# House rules\n\nBe terse.\n");
    seedSpecs(JSON.stringify({ agents: { zed: { mcpFile: clientFile(), instructions: rules } } }));

    expect(createRegistry().get("zed")).toBeTruthy();
    expect(await runAgentCommand(["link"], { agent: "zed", write: true }, ctx())).toBe(0);

    const cfg = JSON.parse(readFileSync(clientFile(), "utf8"));
    expect(cfg.mcpServers["ai-memory"].env.AI_MEMORY_AGENT).toBe("zed");
    const written = readFileSync(rules, "utf8");
    expect(written).toContain("Be terse.");
    expect(written).toContain("ai-memory:begin");

    expect(await runAgentCommand(["unlink"], { agent: "zed", write: true }, ctx())).toBe(0);
    const stripped = readFileSync(rules, "utf8");
    expect(stripped).toContain("Be terse.");
    expect(stripped).not.toContain("ai-memory:begin");
  });

  it("edits a TOML client section-wise", async () => {
    const file = path.join(home, "client.toml");
    writeFileSync(file, 'approval = "never"\n\n[history]\npersistence = "save-all"\n');

    expect(await runAgentCommand(["add", "tomlclient"], { "mcp-file": file, format: "toml", write: true }, ctx())).toBe(0);
    const written = readFileSync(file, "utf8");
    expect(written).toContain("[mcp_servers.ai-memory]");
    expect(written).toContain("[mcp_servers.ai-memory.env]");
    expect(written).toContain('approval = "never"');
    expect(written).toContain("[history]");

    expect(await runAgentCommand(["unlink"], { agent: "tomlclient", write: true }, ctx())).toBe(0);
    const stripped = readFileSync(file, "utf8");
    expect(stripped).not.toContain("ai-memory");
    expect(stripped).toContain('approval = "never"');
  });

  it("ignores a broken declaration file instead of failing the whole command", async () => {
    seedSpecs("{ oops");
    const c = ctx();
    expect(await runAgentCommand(["list"], {}, c)).toBe(0);
    expect(c.lines.join("\n")).toContain("claude");
    expect(createRegistry().ids()).toEqual(["claude", "codex", "dsh", "pi"]);

    // and refuses to write over it
    const c2 = ctx();
    expect(await runAgentCommand(["add", "cursor"], { "mcp-file": clientFile(), write: true }, c2)).toBe(1);
    expect(c2.errs.join("\n")).toMatch(/refusing to rewrite/);
    expect(readFileSync(specsFile(), "utf8")).toBe("{ oops");
  });
});
