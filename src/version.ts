import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The package version, found by walking up from this file.
 *
 * A fixed relative path cannot work: this file is `src/version.ts` in the repo but
 * `dist/src/version.js` once built, so `../../package.json` hits the real manifest
 * in one and `dist/package.json` — which is not shipped — in the other. That is
 * why `ai-memory version` crashed on every installed copy.
 *
 * Matching the package name keeps a stray `package.json` in an ancestor directory
 * (a host project, a global npm prefix) from being mistaken for this one. It is
 * matched by its unscoped last path segment, so the check survives the package
 * living under a scope (`@franklinww/open-memory`) without hard-coding that scope.
 */
let cached: string | undefined;

export async function appVersion(): Promise<string> {
  if (cached !== undefined) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name?.split("/").pop() === "open-memory" && pkg.version) return (cached = pkg.version);
    } catch { /* no manifest here — keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Never throw: a missing version is a cosmetic problem, and failing here would
  // take down whatever command asked.
  return (cached = "unknown");
}
