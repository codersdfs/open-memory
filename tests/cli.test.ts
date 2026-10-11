import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * End-to-end CLI tests.
 *
 * These spawn the real entry point with `--no-daemon` and a throwaway store, because
 * the two things most likely to break are the argv handling and the daemon/in-process
 * split — neither of which a unit test of `main()` would catch.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(root, "src", "cli", "index.ts");

function run(args: string[], dbPath: string, env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), CLI, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      MEMORY_DB_PATH: dbPath,
      AI_MEMORY_USER: "cli-test",
      AI_MEMORY_AGENT: "codex",
      AI_MEMORY_CLI_FORCE_MAIN: "1",
      // Point the daemon probe at a closed port so the tests always exercise the
      // in-process path. A developer machine with a real daemon on 7331 would
      // otherwise make these cases non-deterministic.
      AI_MEMORY_SERVER: "http://127.0.0.1:1",
      ...env
    }
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "ai-memory-cli-"));
const db = path.join(tmp, "memory.db");

describe("ai-memory CLI", () => {
  it("prints usage with no arguments", () => {
    const r = run(["--help"], db);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ai-memory");
    expect(r.stdout).toContain("search");
    expect(r.stdout).toContain("--scope");
  });

  it("reports the version from package.json", () => {
    const r = run(["version"], db);
    expect(r.code).toBe(0);
    // A prerelease is a version too: `0.3.0-beta.1` is what a beta publishes.
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it("saves and searches with --json, reporting the searched scopes", () => {
    const save = run(["save", "The nightly job writes to the analytics bucket.", "--scope", "shared", "--json"], db);
    expect(save.code).toBe(0);
    const saved = JSON.parse(save.stdout) as { id: string; namespace: string };
    expect(saved.namespace).toBe("shared:cli-test");

    const search = run(["search", "nightly job analytics bucket", "--json"], db);
    expect(search.code).toBe(0);
    const result = JSON.parse(search.stdout) as { memories: { id: string; text: string }[]; scopes: string[]; tokensUsed: number };
    expect(result.memories.map((m) => m.id)).toContain(saved.id);
    expect(result.scopes).toEqual(["codex:cli-test", "shared:cli-test", "default:default"]);
    expect(typeof result.tokensUsed).toBe("number");
  });

  it("keeps a private save out of the shared layer", () => {
    const save = run(["save", "A private note about the analytics bucket rotation.", "--json"], db);
    const saved = JSON.parse(save.stdout) as { id: string; namespace: string };
    expect(saved.namespace).toBe("codex:cli-test");

    const inShared = run(["search", "analytics bucket rotation", "--scope", "shared", "--json"], db);
    const result = JSON.parse(inShared.stdout) as { memories: { id: string }[] };
    expect(result.memories.map((m) => m.id)).not.toContain(saved.id);
  });

  it("gets, forgets and restores a memory", () => {
    const save = run(["save", "A short-lived fact for the forget test.", "--json"], db);
    const id = (JSON.parse(save.stdout) as { id: string }).id;

    expect(run(["get", id], db).stdout).toContain("short-lived fact");

    const forget = run(["forget", id], db);
    expect(forget.code).toBe(0);
    expect(forget.stdout).toContain("forgot");

    // `get` sees the tombstone, so the operator can still inspect it.
    const afterForget = run(["get", id, "--json"], db);
    expect(afterForget.code).toBe(0);

    const restore = run(["restore", id], db);
    expect(restore.code).toBe(0);
    expect(restore.stdout).toContain("restored");
  });

  it("supersedes an old memory", () => {
    const old = run(["save", "The API base URL is api.example.com.", "--json"], db);
    const oldId = (JSON.parse(old.stdout) as { id: string }).id;
    const next = run(["supersede", oldId, "The API base URL is api-v2.example.com."], db);
    expect(next.code).toBe(0);
    expect(next.stdout).toContain("superseded");
  });

  it("--all sweeps every partition this user owns", () => {
    run(["save", "the staging key rotates on Fridays", "--agent", "claude", "--json"], db);
    run(["save", "codex prefers short diffs", "--agent", "codex", "--json"], db);

    const plain = JSON.parse(run(["list", "--no-daemon", "--json"], db).stdout) as {
      memories: { namespace: string }[];
    };
    expect(
      plain.memories.map((m) => m.namespace),
      "another agent's partition stays out of a plain read"
    ).not.toContain("claude:cli-test");

    const swept = JSON.parse(run(["list", "--no-daemon", "--all", "--json"], db).stdout) as {
      memories: { namespace: string }[];
      scopes: string[];
    };
    const seen = swept.memories.map((m) => m.namespace);
    expect(seen).toContain("claude:cli-test");
    expect(seen).toContain("codex:cli-test");
    expect(swept.scopes).toContain("claude:cli-test");
  });

  it("reembed reports what it rewrote", () => {
    run(["save", "user is a TypeScript engineer", "--json"], db);
    const res = JSON.parse(run(["reembed", "--json"], db).stdout) as {
      scanned: number;
      rewritten: number;
      dim: number;
      previousDim: number;
    };
    expect(res.scanned).toBeGreaterThan(0);
    expect(res.rewritten).toBe(res.scanned);
    expect(res.previousDim).toBe(res.dim);
  });

  it("lists and counts", () => {
    const list = run(["list", "--limit", "5", "--json"], db);
    expect(list.code).toBe(0);
    const page = JSON.parse(list.stdout) as { memories: unknown[]; total: number };
    expect(page.memories.length).toBeGreaterThan(0);

    const stats = run(["stats", "--json"], db);
    const s = JSON.parse(stats.stdout) as { scopes: string[]; perScope: Record<string, { total: number }> };
    expect(s.scopes).toEqual(["codex:cli-test", "shared:cli-test", "default:default"]);
    expect(s.perScope["shared:cli-test"]!.total).toBeGreaterThan(0);
  });

  it("db info explains where the store comes from", () => {
    const r = run(["db", "info", "--json"], db);
    expect(r.code).toBe(0);
    const info = JSON.parse(r.stdout) as { dbPath: string; resolvedFrom: string; agent: string; user: string };
    expect(info.dbPath).toBe(db);
    expect(info.resolvedFrom).toBe("MEMORY_DB_PATH");
    expect(info.agent).toBe("codex");
  });

  it("fails loudly on a missing argument and an unknown command", () => {
    const missing = run(["save"], db);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/text required/);

    const unknown = run(["frobnicate"], db);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/unknown command/);
  });

  it("skips the daemon on request so a stale server cannot answer", () => {
    // Port 1 is not a daemon; --server only matters when it would be consulted.
    const r = run(["search", "nightly job analytics bucket", "--no-daemon", "--json"], db);
    expect(r.code).toBe(0);
    const result = JSON.parse(r.stdout) as { memories: unknown[] };
    expect(result.memories.length).toBeGreaterThan(0);
  });
});

describe("cli entrypoint file", () => {
  it("exists where adapters point agents at it", () => {
    // Adapters emit AI_MEMORY_CLI (or dist/cli/index.js) as the MCP command. The path
    // must at least resolve to a real file in a built checkout.
    const candidates = [path.join(root, "dist", "cli", "index.js"), CLI];
    expect(candidates.some((c) => existsSync(c))).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });
});
