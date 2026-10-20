import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Child processes started by tests, tracked so none outlives the run.
 *
 * Why this file exists: `spawnSync` waits for the child to exit, but on Windows the
 * handle is not always reaped promptly, and `spawn("npx", …, { shell: true })` starts
 * *two* processes — npx and the node it launches — of which `child.kill()` kills only
 * the first. A full suite spawns a CLI a few hundred times, and the leftovers add up:
 * an idle `node.exe` costs ~0.2 MB and ~0.1 s of CPU, so the pile is invisible in
 * `Get-Process` and deadly to the run that inherits it. One such run took 22.75 s
 * against a 9–10 s baseline and failed a test that passes on its own; that is the
 * symptom this module removes at the source.
 *
 * The rule: every spawned child goes through `spawnChild`/`spawnSyncChild`, and the
 * test file that spawns them calls `closeAllChildren()` in `afterAll`.
 */

interface Tracked {
  pid: number;
  child: import("node:child_process").ChildProcess;
}

const tracked = new Set<Tracked>();

function track(child: import("node:child_process").ChildProcess): void {
  if (typeof child.pid !== "number") return;
  const entry: Tracked = { pid: child.pid, child };
  tracked.add(entry);
  child.on("exit", () => tracked.delete(entry));
}

/**
 * Kill a process tree. `child.kill()` only reaches the direct child, which for a
 * shell-wrapped spawn is the shell; the work is one level down.
 */
function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    if (process.platform === "win32") {
      // `taskkill /T` walks children, `/F` skips the polite ask the tree never honours.
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // Already gone, or not ours to kill: both are fine at teardown.
  }
}

/** Wraps `child_process.spawn` and tracks the result. */
export function spawnChild(
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2] = {}
): import("node:child_process").ChildProcess {
  const child = spawn(command, args as string[], options);
  track(child);
  return child;
}

/**
 * Wraps `child_process.spawnSync` with a default timeout, so a hung CLI fails the
 * test it belongs to instead of stalling the suite until vitest's per-file limit.
 *
 * The overload is deliberate: callers pass `{ encoding: "utf8" }` and expect string
 * `stdout`/`stderr`, which is exactly what the untyped generic loses.
 */
export function spawnSyncChild(
  command: string,
  args: readonly string[],
  options: Omit<import("node:child_process").SpawnSyncOptionsWithStringEncoding, "encoding"> & { encoding?: "utf8" } = {}
): { status: number | null; stdout: string; stderr: string; error?: Error; signal: NodeJS.Signals | null } {
  const res = spawnSync(command, args as string[], { timeout: 60_000, windowsHide: true, encoding: "utf8", ...options });
  return res as { status: number | null; stdout: string; stderr: string; error?: Error; signal: NodeJS.Signals | null };
}

/**
 * Kill everything this file started and wait for the kernel to forget it.
 *
 * The wait matters more than the kill: a killed process stays a zombie until its
 * parent reaps it, and the next test file's spawn has to allocate a slot for it.
 */
export async function closeAllChildren(): Promise<void> {
  const live = [...tracked];
  tracked.clear();
  const killed: number[] = [];
  for (const entry of live) {
    try {
      if (entry.child.exitCode === null && !entry.child.killed) {
        entry.child.kill();
        killTree(entry.pid);
        killed.push(entry.pid);
      }
    } catch {
      // Raced with its own exit.
    }
  }
  // Poll instead of sleeping a fixed amount: most trees are gone within one tick.
  for (let i = 0; i < 20 && killed.length > 0; i++) {
    const stillAlive = killed.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (stillAlive.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Temp directory helper: creates the dir and removes it (or leaves it on request). */
export function tempDir(prefix: string): { dir: string; db: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    db: path.join(dir, "memory.db"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Windows keeps a just-closed SQLite file briefly; a leaked temp dir is
        // strictly better than a red suite.
      }
    },
  };
}
