import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where the memory store lives (ADR-0007).
 *
 * Precedence, highest first:
 *   1. an explicit `dbPath` argument (tests, `--db`)
 *   2. `MEMORY_DB_PATH` — the v0.2.0 variable, still honoured first so nobody's
 *      existing setup silently points somewhere else
 *   3. `AI_MEMORY_DB`
 *   4. `$AI_MEMORY_HOME/memory.db` (default `~/.ai-memory/memory.db`)
 *
 * The default moved out of the repo because four different agents now share one
 * store, and an agent launched from an arbitrary cwd must not end up with its own
 * copy of `memory.db`.
 */
export const DEFAULT_HOME_DIRNAME = ".ai-memory";

export function resolveHome(explicit?: string): string {
  return explicit?.trim() || process.env.AI_MEMORY_HOME?.trim() || path.join(os.homedir(), DEFAULT_HOME_DIRNAME);
}

/** Absolute path to the store. Pure — never touches the filesystem. */
export function resolveDbPath(explicit?: string): string {
  if (explicit?.trim()) return normalize(explicit.trim());
  const fromEnv = process.env.MEMORY_DB_PATH ?? process.env.AI_MEMORY_DB;
  if (fromEnv?.trim()) return normalize(fromEnv.trim());
  return path.join(resolveHome(), "memory.db");
}

/**
 * SQLite special names are connection strings, not file paths: `path.resolve`
 * would turn `:memory:` into `<cwd>\:memory:` and make the open fail. URI-style
 * names (`file:...`) are handed through for the same reason.
 */
function normalize(raw: string): string {
  if (raw === ":memory:" || raw.startsWith("file:")) return raw;
  return path.resolve(expandHome(raw));
}

/**
 * Legacy in-repo store, used by `ai-memory setup --copy-db` and `db info` to
 * detect a pre-ADR-0007 install that has not been migrated yet.
 */
export function legacyDbPath(cwd: string = process.cwd()): string {
  return path.join(cwd, "memory.db");
}

export function dbExists(p: string): boolean {
  return existsSync(p);
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}
