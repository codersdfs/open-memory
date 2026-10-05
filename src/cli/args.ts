/**
 * Minimal argument parsing for the `ai-memory` CLI.
 *
 * Hand-rolled on purpose: the project ships zero runtime dependencies, and the
 * grammar needs are tiny (`--flag`, `--key value`, `--key=value`, `--` terminator,
 * positionals). Unknown flags are kept so a typo surfaces as a clear error instead
 * of being silently ignored.
 */

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
  rest: string[];
}

export function isFlagName(token: string): boolean {
  return /^--?[A-Za-z]/.test(token);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  let command = "";
  let onlyPositionals = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (onlyPositionals) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      onlyPositionals = true;
      continue;
    }
    if (isFlagName(token)) {
      const body = token.replace(/^--?/, "");
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      // Required-value flags. Everything else is a boolean switch.
      const next = argv[i + 1];
      if (next !== undefined && !isFlagName(next) && next !== "--" && REQUIRES_VALUE.has(body)) {
        flags[body] = next;
        i++;
        continue;
      }
      if (next !== undefined && !isFlagName(next) && !token.startsWith("-")) {
        // Tolerate `--k v` for flags we do not know, but never swallow positionals
        // for a known boolean switch.
        if (!BOOLEAN_FLAGS.has(body)) {
          flags[body] = next;
          i++;
          continue;
        }
      }
      flags[body] = true;
      continue;
    }
    rest.push(token);
    if (!command) command = token;
    else positionals.push(token);
  }

  return { command, positionals, flags, rest };
}

const REQUIRES_VALUE = new Set([
  "db",
  "agent",
  "user",
  "namespace",
  "scope",
  "server",
  "k",
  "limit",
  "budget",
  "threshold",
  "type",
  "text",
  "id",
  "tags",
  "importance",
  "source",
  "status",
  "pin",
  "mode",
  "query",
  "from",
  "since",
  "home",
  "profile",
  "path",
  "name",
  "url",
  "target",
  "format"
]);

const BOOLEAN_FLAGS = new Set(["json", "write", "dry-run", "all", "help", "version", "no-daemon", "force", "quiet", "verbose", "yes"]);

export function flagString(a: ParsedArgs, name: string): string | undefined {
  const v = a.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(a: ParsedArgs, name: string): boolean {
  const v = a.flags[name];
  return v === true || v === "true" || v === "1";
}

export function flagNumber(a: ParsedArgs, name: string): number | undefined {
  const v = flagString(a, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function flagList(a: ParsedArgs, name: string): string[] | undefined {
  const v = flagString(a, name);
  if (!v) return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Positional-or-flag convenience: `ai-memory search "text"` or `--query text`. */
export function queryText(a: ParsedArgs, flag = "query"): string | undefined {
  return flagString(a, flag) ?? (a.positionals.length > 0 ? a.positionals.join(" ") : undefined);
}
