import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export { existsSync };

/**
 * Filesystem helpers shared by every agent adapter.
 *
 * The contract all adapters follow: **never destroy unrelated configuration**.
 * Each mutation re-reads the file, changes only the keys it owns, and writes the
 * result back atomically-ish. `--write` is the only way anything is written, and
 * the first write to a file leaves a `.ai-memory.bak` next to it so a bad merge is
 * always recoverable by hand.
 */

export interface AdapterAction {
  path: string;
  /** What this action changes, in one line. */
  detail: string;
  changed: boolean;
  /** Rendered content for the diff view (never written when `write` is false). */
  preview?: string;
}

export function plan(pathname: string, detail: string, changed: boolean, preview?: string): AdapterAction {
  return { path: pathname, detail, changed, preview };
}

export function ensureDir(filePath: string, write: boolean): void {
  if (!write) return;
  mkdirSync(path.dirname(filePath), { recursive: true });
}

export function readTextIfExists(filePath: string): string | null {
  try {
    return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
  } catch {
    return null;
  }
}

export function readJsonIfExists(filePath: string): Record<string, unknown> | null {
  const raw = readTextIfExists(filePath);
  if (raw === null || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch (err) {
    throw new Error(`refusing to touch ${filePath}: not valid JSON (${(err as Error).message})`);
  }
}

/** Write JSON with 2-space indent and a trailing newline (matches both agents' style). */
export function writeJson(filePath: string, value: unknown, write: boolean): void {
  if (!write) return;
  ensureDir(filePath, write);
  backupOnce(filePath);
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function writeText(filePath: string, value: string, write: boolean): void {
  if (!write) return;
  ensureDir(filePath, write);
  backupOnce(filePath);
  writeFileSync(filePath, value, "utf8");
}

function backupOnce(filePath: string): void {
  const backup = filePath + ".ai-memory.bak";
  try {
    if (existsSync(filePath) && !existsSync(backup)) copyFileSync(filePath, backup);
  } catch {
    // A failed backup must not block the write; the user still has git or the old copy.
  }
}

/** Deep-enough copy for the nested config objects we patch. */
export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function getObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const cur = parent[key];
  if (cur && typeof cur === "object" && !Array.isArray(cur)) return cur as Record<string, unknown>;
  const fresh: Record<string, unknown> = {};
  parent[key] = fresh;
  return fresh;
}

export function hasCommand(cmd: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const res = spawnSync(probe, [cmd], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}

/** The `ai-memory` invocation an agent should spawn: `<node> <abs cli.js> mcp`. */
export function mcpCommandSpec(): { command: string; args: string[] } {
  const override = process.env.AI_MEMORY_MCP_COMMAND;
  if (override?.trim()) {
    const parts = override.trim().split(/\s+/);
    return { command: parts[0]!, args: [...parts.slice(1), "mcp"] };
  }
  return { command: process.execPath, args: [cliEntryPath(), "mcp"] };
}

/**
 * Absolute path to the built CLI entry an agent should spawn.
 *
 * `tsconfig.json` uses `rootDir: "."`, so the build lands at `dist/src/cli/index.js`
 * rather than `dist/cli/index.js`. Resolve relative to this module inside `dist`, and
 * point at the build output when running from `src` under tsx, so a linked agent gets a
 * path that actually exists.
 */
export function cliEntryPath(): string {
  const override = process.env.AI_MEMORY_CLI;
  if (override?.trim()) return override.trim();
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Under `dist`, this file IS the build layout: ../cli/index.js is the entry.
  if (here.split(/[\\/]/).includes("dist")) return path.resolve(here, "..", "cli", "index.js");
  // Running from `src` (tsx, tests): point at the build output instead.
  return path.resolve(here, "..", "..", "dist", "src", "cli", "index.js");
}

/** Windows wants forward slashes in shell hook commands and JSON on POSIX is happy too. */
export function slash(p: string): string {
  return p.replace(/\\/g, "/");
}

export function stripBom(s: string): string {
  return s.replace(/^\uFEFF/, "");
}
