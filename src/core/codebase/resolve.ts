import { promises as fs } from "node:fs";
import path from "node:path";
import { parseJsonc } from "../../adapters/jsonc.js";

/**
 * Import resolution for the code index (ADR-0050).
 *
 * Only what a repository actually contains: relative specifiers (`./`, `../`,
 * `/`-rooted) resolved through the extension candidates Node and TypeScript both
 * accept. Bare specifiers point at dependencies, which the index deliberately
 * does not follow — the graph answers questions about *this* repository.
 */

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"];

export interface ResolveTarget {
  /** Repo-relative path of the file the specifier lands on. */
  path: string;
  /** Name imported through the specifier; `*` for namespace/star imports. */
  name: string;
  /** True when the name had to pass through a re-export chain. */
  viaReExport: boolean;
}

/** `./utils` from `src/a.ts` → `src/utils` (+ extension candidates). Null for bare specifiers. */
export function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  }
  if (spec.startsWith("/")) {
    return path.posix.normalize(spec.slice(1));
  }
  return null;
}

/**
 * Files a specifier may land on, in a fixed order: the verbatim path first (it
 * may already carry an extension, and a real `.js` file outranks a same-named
 * `.ts` source), then the TypeScript shapes of a NodeNext-style specifier —
 * `./x.js` also lands on `./x.ts` and `./x.tsx`, `.mjs` on `.mts`, `.cjs` on
 * `.cts`, TS's own mapping — then the plain extension search, then the index
 * files of the extensionless base, so `./x.js` keeps the same directory-index
 * reach as `./x`.
 */
export function specifierCandidates(resolved: string): string[] {
  const out = [resolved];
  const tail = resolved.endsWith(".js") ? ".js" : resolved.endsWith(".mjs") ? ".mjs" : resolved.endsWith(".cjs") ? ".cjs" : null;
  const base = tail ? resolved.slice(0, resolved.length - tail.length) : resolved;
  if (tail) {
    for (const ext of tail === ".js" ? [".ts", ".tsx"] : tail === ".mjs" ? [".mts"] : [".cts"]) out.push(base + ext);
  }
  for (const ext of RESOLVE_EXTENSIONS) out.push(resolved + ext);
  for (const ext of RESOLVE_EXTENSIONS) out.push(`${base}/index${ext}`);
  return out;
}

/**
 * tsconfig `paths` aliases (ADR-0050): what a repository's tsconfig.json /
 * jsconfig.json contributes to specifier resolution. The TS prefix pattern —
 * one optional `/*` per key, `*` matching any remainder — is all the index
 * models; anything a config expresses beyond that keeps resolving as a miss,
 * never a guess.
 */
export interface AliasConfig {
  /** tsconfig `baseUrl`, relative to the repo root; "." when the file omits it. */
  baseUrl: string;
  /** Alias pattern → target patterns, verbatim from `compilerOptions.paths`. */
  paths: Record<string, string[]>;
}

/**
 * Read alias config once per sync: `tsconfig.json` first, then `jsconfig.json`
 * (only one of them rules a directory, and tsconfig wins). The store's JSONC
 * parser reads it — tsconfig allows comments and trailing commas, which bare
 * `JSON.parse` rejects. Tolerant by design: a missing, unreadable, malformed
 * or paths-less config simply disables alias resolution for the whole sync.
 */
export async function loadAliasConfig(root: string): Promise<AliasConfig | null> {
  for (const fileName of ["tsconfig.json", "jsconfig.json"]) {
    let text: string;
    try {
      text = await fs.readFile(path.join(root, fileName), "utf8");
    } catch (error) {
      // A missing tsconfig falls through to jsconfig; any other read failure
      // means the config that exists cannot be trusted, so aliases stay off.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      return null;
    }
    try {
      const parsed = parseJsonc<Record<string, unknown>>(text);
      const options = parsed?.compilerOptions;
      if (!options || typeof options !== "object") return null;
      const optionsRecord = options as Record<string, unknown>;
      if (!optionsRecord.paths || typeof optionsRecord.paths !== "object") return null;
      const paths: Record<string, string[]> = {};
      for (const [key, targets] of Object.entries(optionsRecord.paths)) {
        if (!Array.isArray(targets)) continue;
        const usable = targets.filter((target): target is string => typeof target === "string");
        if (usable.length > 0) paths[key] = usable;
      }
      if (Object.keys(paths).length === 0) return null;
      const baseUrl = typeof optionsRecord.baseUrl === "string" && optionsRecord.baseUrl !== "" ? optionsRecord.baseUrl : ".";
      return { baseUrl, paths };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Every file path an alias specifier may map to, in tsconfig target order and
 * already joined with `baseUrl` (default ".") — the repo-relative shape
 * `specifierCandidates` extends with its extension search. Null when no alias
 * matches, so the caller falls through to ordinary relative resolution with
 * its behaviour untouched.
 */
export function aliasMappedPaths(spec: string, aliases: AliasConfig | null): string[] | null {
  // TS `paths` never applies to relative specifiers: the bare `*` pattern's
  // empty prefix would otherwise swallow `./x`, `../x` and `/x` and mis-route
  // them away from the file beside the importer (ADR-0050).
  if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) return null;
  if (!aliases) return null;
  // A function replacement keeps `$&`-style sequences in a remainder from being
  // read as replacement patterns — a specifier is user text, not a pattern.
  const joined = (target: string, remainder: string): string => {
    const mapped = target.includes("*") ? target.replace("*", () => remainder) : remainder ? `${target}/${remainder}` : target;
    return path.posix.normalize(path.posix.join(aliases.baseUrl, mapped));
  };
  const exact = aliases.paths[spec];
  if (exact) return exact.map((target) => joined(target, ""));
  // Longest prefix wins (TS findBestPatternMatch): `@app/util/*` beats `@app/*`
  // for `@app/util/x`, and the bare `*` key is the empty prefix that loses to
  // every more literal pattern. Equal-length prefixes keep tsconfig order.
  let best: { prefix: string; targets: string[] } | null = null;
  for (const [key, targets] of Object.entries(aliases.paths)) {
    const prefix = key === "*" ? "" : key.endsWith("/*") ? key.slice(0, -1) : null;
    if (prefix === null || !spec.startsWith(prefix)) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, targets };
  }
  if (!best) return null;
  const remainder = spec.slice(best.prefix.length);
  return best.targets.map((target) => joined(target, remainder));
}

/** One indexed file as the resolver sees it: what it exports and what it re-exports. */
export interface FileEntry {
  /** Exported symbol names (the parser's `exported` rows, including `default` never). */
  exportedNames: Set<string>;
  /** The symbol ids these names resolve to, aligned with `exportedNames`. */
  exportedIds: Map<string, string>;
  /** `export { a, b } from "..."` / `export * from "..."` statements. */
  reExports: { spec: string; names: string[] }[];
  moduleNodeId: string;
}

/** How deep a re-export chain is followed before the walk gives up (ADR-0050). */
const MAX_REEXPORT_DEPTH = 4;

/**
 * Files a re-export's specifier may land on, alias mapping first: a barrel's
 * `export ... from "@app/x"` resolves through tsconfig paths exactly like an
 * import statement, and only a specifier no alias claims falls back to the
 * relative rules. Empty when neither can land it in the repo.
 */
function reExportLandings(spec: string, fromFile: string, aliases: AliasConfig | null): string[] {
  const mapped = aliasMappedPaths(spec, aliases);
  if (mapped) return mapped.flatMap((target) => specifierCandidates(target));
  const resolved = resolveSpecifier(fromFile, spec);
  return resolved ? specifierCandidates(resolved) : [];
}

/**
 * Resolve one imported name to a symbol id through the project's file index.
 * Re-export chains are followed to a bounded depth (ADR-0050): barrels several
 * files deep are a real repository shape, so the walk descends until a file
 * exports the name or the depth runs out. A visited set keeps a re-export
 * cycle from looping forever — a file may be entered once per resolution walk,
 * and a chain that never lands gives up honestly.
 */
export function resolveImportedName(
  files: Map<string, FileEntry>,
  targetPath: string,
  name: string,
  aliases: AliasConfig | null = null
): ResolveTarget | null {
  const direct = files.get(targetPath);
  if (!direct) return null;

  const directId = direct.exportedIds.get(name);
  if (directId) return { path: targetPath, name, viaReExport: false };

  // Breadth-first by hop: the shortest chain that lands the name wins, and
  // files expand in re-export statement order, so the result is deterministic.
  const visited = new Set<string>([targetPath]);
  let frontier: { path: string; entry: FileEntry }[] = [{ path: targetPath, entry: direct }];
  for (let depth = 1; depth <= MAX_REEXPORT_DEPTH; depth++) {
    const next: { path: string; entry: FileEntry }[] = [];
    for (const { path, entry } of frontier) {
      for (const re of entry.reExports) {
        if (!re.names.includes("*") && !re.names.includes(name)) continue;
        for (const candidate of reExportLandings(re.spec, path, aliases)) {
          if (visited.has(candidate)) continue;
          const landed = files.get(candidate);
          if (!landed) continue;
          visited.add(candidate);
          if (landed.exportedIds.has(name)) {
            return { path: candidate, name, viaReExport: true };
          }
          // A star or named re-export may itself point at another barrel —
          // enter it and let the next hop decide, never returning an id the
          // file does not actually export.
          next.push({ path: candidate, entry: landed });
        }
      }
    }
    frontier = next;
  }
  return null;
}
