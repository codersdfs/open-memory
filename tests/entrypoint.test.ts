import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Regression: the isMain guard once compared import.meta.url to a hand-built
// `file://${argv[1]}` string, which never matches on Windows (drive letter +
// backslashes), so `tsx src/api/server.ts` started nothing and silently exited.
describe("entrypoint", () => {
  it("listens when run directly", async () => {
    const port = 7000 + Math.floor(Math.random() * 900);
    const child = spawn("npx", ["tsx", "src/api/server.ts"], {
      cwd: root,
      env: { ...process.env, PORT: String(port), MEMORY_DB_PATH: ":memory:", EMBEDDING_PROVIDER: "hash" },
      shell: process.platform === "win32",
      stdio: "ignore",
    });
    try {
      let body: string | null = null;
      for (let i = 0; i < 40 && body === null; i++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
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
