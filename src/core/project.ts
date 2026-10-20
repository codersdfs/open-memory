import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";

/**
 * Project identity (ADR-0020).
 *
 * A long-lived repository is one effort across many sessions, many agents and
 * many working directories. `namespace` answers "who wrote this"; it cannot
 * answer "which effort is this about", because the same agent works on several
 * repositories and the same repository is worked on by several agents. So a
 * project is its own dimension: a human-readable slug attached to every write,
 * resolved the way an operator already thinks — from the repository the process
 * is running in.
 *
 * Resolution order, explicit first:
 *   1. an explicit argument (CLI flag, API field, test seam)
 *   2. `MEMORY_PROJECT` or `AI_MEMORY_PROJECT`
 *   3. the git work-tree root of the current directory, slugged
 *   4. null — an unscoped memory, which is exactly what every row written before
 *      projects existed is
 *
 * The slug, not the path, is stored: paths move (a clone lands elsewhere), a
 * slug is what a human says out loud, and `project:root` keeps the path for
 * audit without making it the key.
 */

export const PROJECT_ENV_KEYS = ["MEMORY_PROJECT", "AI_MEMORY_PROJECT"] as const;

const SLUG_MAX = 40;

/**
 * Slug rules: lowercase, `[a-z0-9._-]`, collapse everything else to `-`.
 *
 * Deterministic on purpose — two agents in the same repository must derive the
 * same string without coordinating, or the brief splits in half.
 */
export function projectSlug(raw: string): string | null {
  const cleaned = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s/\\:]+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!cleaned) return null;
  return cleaned.slice(0, SLUG_MAX);
}

/** Explicit/env values are already a name, not a path: normalize, do not stat. */
export function normalizeProject(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return null;
  return projectSlug(raw);
}

/**
 * `git rev-parse --show-toplevel` at most once per directory per process.
 *
 * A write is not allowed to cost a process spawn every time, and a process that
 * changes directory (a watcher, a test) must not get the first directory's
 * answer forever — hence the cache key is the directory.
 */
const rootCache = new Map<string, string | null>();

function gitRoot(cwd: string, env: NodeJS.ProcessEnv): string | null {
  const key = resolve(cwd);
  if (rootCache.has(key)) return rootCache.get(key) ?? null;
  let root: string | null = null;
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: key,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      env
    });
    const trimmed = out.trim();
    root = trimmed.length > 0 ? resolve(trimmed) : null;
  } catch {
    // Not a git checkout, no git binary, or a timeout: no project, not an error.
    root = null;
  }
  rootCache.set(key, root);
  return root;
}

/** Test seam: forget the memoized git lookups (the env is read live anyway). */
export function resetProjectCache(): void {
  rootCache.clear();
}

export interface ProjectResolution {
  project: string | null;
  /** Where the slug came from, for `memory_stats` and debugging. */
  source: "explicit" | "env" | "git" | "none";
  /** Absolute repository root when it was discoverable. */
  root: string | null;
}

/**
 * Resolve the project this process is acting on.
 *
 * `null` is a legitimate answer: not every write belongs to a repository (a
 * personal preference, a fact about the user), and forcing one would make every
 * unscoped memory look project-specific to the brief.
 */
export function resolveProject(
  explicit?: string | null,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): ProjectResolution {
  const env = opts.env ?? process.env;
  const fromExplicit = normalizeProject(explicit);
  if (fromExplicit) return { project: fromExplicit, source: "explicit", root: null };

  for (const key of PROJECT_ENV_KEYS) {
    const value = normalizeProject(env[key]);
    if (value) return { project: value, source: "env", root: null };
  }

  const root = gitRoot(opts.cwd ?? process.cwd(), env);
  if (root) {
    const slug = projectSlug(basename(root));
    if (slug) return { project: slug, source: "git", root };
  }

  return { project: null, source: "none", root: null };
}
