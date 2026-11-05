import { describe, it, expect, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnChild, closeAllChildren } from "./helpers/child.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A port nobody else in the suite uses, chosen high enough to miss most ephemeral ones. */
const PORT = 17_000 + Math.floor(Math.random() * 900);

afterAll(async () => {
  await closeAllChildren();
});

// Regression: the isMain guard once compared import.meta.url to a hand-built
// `file://${argv[1]}` string, which never matches on Windows (drive letter +
// backslashes), so `tsx src/api/server.ts` started nothing and silently exited.
describe("entrypoint", () => {
  it("listens when run directly", async () => {
    // Spawn node + the tsx loader directly rather than `npx tsx …` with `shell: true`:
    // on Windows that chain is cmd.exe -> npx.cmd -> node -> node, and `child.kill()`
    // reaps only the first of them. Two full suites' worth of that is what left the
    // machine littered with idle node.exe and made one run take 22.75 s instead of 9.
    const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawnChild(process.execPath, [tsx, join(root, "src", "api", "server.ts")], {
      cwd: root,
      env: { ...process.env, PORT: String(PORT), MEMORY_DB_PATH: ":memory:", EMBEDDING_PROVIDER: "hash" },
      stdio: "ignore",
    });
    try {
      let body: string | null = null;
      for (let i = 0; i < 40 && body === null; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const res = await fetch(`http://127.0.0.1:${PORT}/health`);
          if (res.ok) body = await res.text();
        } catch {
          // not up yet
        }
      }
      expect(body, "server never bound a port").not.toBeNull();
      expect(JSON.parse(body as string).ok).toBe(true);
    } finally {
      child.kill();
    }
  }, 30000);
});
