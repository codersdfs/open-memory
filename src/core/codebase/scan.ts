import { promises as fs } from "node:fs";
import path from "node:path";

import { GRAMMARS } from "./languages/index.js";

/**
 * Repository walk for the code index (ADR-0050). Skips the directories every
 * checkout carries and honours a root `.gitignore` well enough to stay out of
 * generated trees — a minimal matcher, documented as one: patterns are anchored
 * like gitignore but `**` and negation are best-effort, because the index is
 * derived state and a stray generated file costs one stale row, not an answer.
 */

/**
 * Derived from the grammar registry (roadmap Phase 2): the walk indexes whatever
 * extensions the registered grammars claim, so a new language turns scannable
 * by registration alone. Kept as an export even though nothing outside this
 * file imports it today — the compatibility surface stays put.
 */
export const CODE_EXTENSIONS = new Set(GRAMMARS.flatMap((grammar) => grammar.extensions));

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".cache",
  ".zcode", ".codegraph", ".superpowers", ".empryo", ".pi", ".venv", "__pycache__"
]);

export const MAX_FILE_BYTES = 1_000_000;

export interface ScannedFile {
  /** Repo-relative path with forward slashes — the row's `path`. */
  path: string;
  absPath: string;
  mtime: number;
  size: number;
}

class GitignoreMatcher {
  private rules: { re: RegExp; negated: boolean; dirOnly: boolean }[] = [];

 constructor(lines: string[]) {
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const negated = line.startsWith("!");
      const dirOnly = line.endsWith("/");
      let pattern = negated ? line.slice(1) : line;
      if (dirOnly) pattern = pattern.slice(0, -1);
      pattern = pattern.replace(/^\//, "");
      // gitignore: a pattern with no `/` matches at any depth; `**` spans segments.
      const anyDepth = !pattern.includes("/");
      const regex = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "(?:.*/)?")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]");
      const source = anyDepth ? `(^|/)${regex}(/|$)` : `^${regex}(/|$)`;
      this.rules.push({ re: new RegExp(source), negated, dirOnly });
    }
  }

  ignored(relPath: string, isDir: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(relPath)) ignored = !rule.negated;
    }
    return ignored;
  }
}

export async function loadGitignore(root: string): Promise<GitignoreMatcher> {
  try {
    const text = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    return new GitignoreMatcher(text.split(/\r?\n/));
  } catch {
    return new GitignoreMatcher([]);
  }
}

/** Every indexable source file under `root`, repo-relative paths, forward slashes. */
export async function scanRoot(root: string): Promise<ScannedFile[]> {
  const ignore = await loadGitignore(root);
  const out: ScannedFile[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || ignore.ignored(childRel, true)) continue;
        await walk(path.join(dir, entry.name), childRel);
      } else if (entry.isFile()) {
        if (ignore.ignored(childRel, false)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!CODE_EXTENSIONS.has(ext)) continue;
        const absPath = path.join(dir, entry.name);
        try {
          const st = await fs.stat(absPath);
          out.push({ path: childRel, absPath, mtime: Math.floor(st.mtimeMs), size: st.size });
        } catch {
          // Vanished between readdir and stat: nothing to index, nothing to report.
        }
      }
    }
  };
  await walk(root, "");
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
