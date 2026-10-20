import { afterAll, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryService } from "../src/core/memoryService.js";

/**
 * `scripts/seed.ts` must not be able to write the operator's real store by accident.
 *
 * This checkout's `.env` sets `MEMORY_DB_PATH=memory.db`, which is how seed fixtures ended
 * up in the real database — so the interesting case is a plain `npm run seed` with no
 * explicit target, spawned exactly the way a user would run it. The child process is the
 * only way to observe the module-import order the fix depends on (the env snapshot must
 * happen before `src/config.ts` loads `.env`).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED = path.join(root, "scripts", "seed.ts");
const TSX = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const REAL_DB = path.join(root, "memory.db");

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function runSeed(explicitDbPath?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Whatever the developer's shell or `.env` says must not decide the target for the
  // "no explicit setting" case; `.env` is loaded inside the child and is the thing under
  // test.
  delete env.MEMORY_DB_PATH;
  delete env.AI_MEMORY_DB;
  delete env.NAMESPACE;
  if (explicitDbPath) env.MEMORY_DB_PATH = explicitDbPath;
  const res = spawnSync(process.execPath, [TSX, SEED], { cwd: root, encoding: "utf8", env, timeout: 120_000 });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function printedDbPath(stdout: string): string {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("db: "));
  expect(line, `seed did not print a db line:\n${stdout}`).toBeTruthy();
  return line!.slice("db: ".length).replace(/\s+\(temporary store[^)]*\)$/, "").trim();
}

describe("scripts/seed.ts store isolation", () => {
  it("writes a temporary store and says so when MEMORY_DB_PATH was not set explicitly", () => {
    const r = runSeed();
    expect(r.code, r.stderr).toBe(0);

    const dbPath = printedDbPath(r.stdout);
    expect(r.stdout).toContain("(temporary store");
    expect(path.resolve(dbPath)).not.toBe(REAL_DB);
    // A directory under the OS temp root, created by mkdtemp.
    expect(path.resolve(dbPath).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
    expect(r.stdout).toContain("total 8 in default:default");
    tempDirs.push(path.dirname(dbPath));
  });

  it("still seeds an explicitly named store", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ai-memory-seed-explicit-"));
    tempDirs.push(dir);
    const dbPath = path.join(dir, "explicit.db");

    const r = runSeed(dbPath);
    expect(r.code, r.stderr).toBe(0);
    expect(printedDbPath(r.stdout)).toBe(dbPath);
    expect(r.stdout).not.toContain("(temporary store");
    expect(r.stdout).toContain("total 8 in default:default");
    expect(existsSync(dbPath)).toBe(true);

    // It is a real store, seeded with the eight fixtures.
    const svc = new MemoryService({ dbPath });
    await svc.init();
    try {
      const { total } = await svc.list({ namespace: "default:default", limit: 100 });
      expect(total).toBe(8);
    } finally {
      svc.close();
    }
  });
});
