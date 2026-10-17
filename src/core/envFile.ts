/**
 * `.env` as a line list, and the one mutation the console is allowed to make to it:
 * commenting a named key out.
 *
 * `.env` is where a mistaken write costs a key, so nothing here deletes the file,
 * reorders a line or reformats a value. Comment-out inserts a `#` in front of the line's
 * own text — after its leading whitespace, before any `export` — so undoing it is a
 * manual uncomment of the exact same line. Every other line is written back byte-for-byte,
 * CRLF and a missing trailing newline included.
 */

import { readFileSync, statSync } from "node:fs";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface EnvEntry {
  name: string;
  /**
   * The decoded value: quotes stripped and an inline comment dropped, the bytes kept as they
   * were read and never interpreted the way a shell would. The decode is latin-1, so a UTF-8
   * value arrives as its bytes — one character per byte — not as the characters a shell
   * would produce.
   */
  value: string;
  /** 1-based line number, so a caller can point at the line it means. */
  line: number;
  /** `false` for a commented-out line: still reported, because it is still the user's text. */
  enabled: boolean;
}

/** How one line assigns a name. `indent` is where a comment-out inserts its `#`. */
interface EnvLine {
  indent: string;
  name: string;
  value: string;
  enabled: boolean;
}

/**
 * `NAME=v`, `export NAME=v`, and their commented forms. Anything else is not an assignment.
 * The tail is `[^\n]*` rather than `.*` because `.` stops at a `\r`, and a CRLF line that
 * has been split on `\n` still carries its `\r`.
 */
const ASSIGNMENT = /^(\s*)(#\s*)?((?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n]*)$/;

function parseLine(line: string): EnvLine | null {
  const m = ASSIGNMENT.exec(line);
  if (!m) return null;
  return { indent: m[1], name: m[4], value: parseValue(m[5]), enabled: m[2] === undefined };
}

function parseValue(raw: string): string {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    // Inside quotes a `#` is part of the value, so the closing quote is the whole story.
    // The quotes are stripped and escapes are not interpreted: `A="a\"b"` reads `a\`.
    const end = trimmed.indexOf(quote, 1);
    if (end > 0) return trimmed.slice(1, end);
  }
  // Unquoted: `#` starts a comment at the start of the value or after whitespace, so
  // `A=1#2` keeps its value while `A=#abc` is the empty string.
  return trimmed.replace(/(^|\s+)#.*$/, "");
}

/**
 * The `.env` this process reads: `MEMORY_ENV_FILE` when set — that is how a test or a
 * second install points at its own file — otherwise `.env` in `cwd`.
 */
export function envFilePath(cwd?: string): string {
  return process.env.MEMORY_ENV_FILE?.trim() || path.join(cwd ?? process.cwd(), ".env");
}

/**
 * `latin1`, not `utf8`, on both sides of every read and write: it is the one single-byte
 * encoding whose decode always succeeds, and it maps each byte to exactly one character
 * and back. A `.env` with a latin-1 accent would otherwise gain U+FFFD on rewrite, which
 * breaks the byte-for-byte promise this module makes about untouched lines.
 *
 * A `.env` that is not there yet is the only empty one: ENOENT is no file, ENOTDIR is a
 * path through a file. Everything else (EACCES, EISDIR) throws, because reporting an
 * unreadable `.env` as empty would have the caller rewrite it as if it had no keys.
 */
function readText(file: string): string | null {
  try {
    return readFileSync(file, "latin1");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

export function readEnvFile(file: string): EnvEntry[] {
  const text = readText(file);
  if (text === null) return [];
  const entries: EnvEntry[] = [];
  text.split("\n").forEach((line, i) => {
    const parsed = parseLine(line);
    if (parsed) entries.push({ name: parsed.name, value: parsed.value, line: i + 1, enabled: parsed.enabled });
  });
  return entries;
}

export interface CommentOutOptions {
  /**
   * Replaces the tmp → `.env` rename. A hook that throws stands in for an interrupted
   * write, so the crash path is a test rather than a mocked `node:fs` module.
   */
  rename?: (from: string, to: string) => Promise<void>;
}

export interface CommentOutResult {
  /** The names actually commented, in the order given, once each. */
  commented: string[];
  /**
   * Where the `.bak` copy lives — written once, on the first rewrite, and kept — so after a
   * second adopt this is still that first pre-edit copy; `null` when the file was not touched
   * at all.
   */
  backupPath: string | null;
}

/**
 * The mode the rewritten file must keep. A `.env` was just read, so this normally answers;
 * the fallback is owner-only because the file holds keys.
 */
function modeOf(file: string): number {
  try {
    return statSync(file).mode & 0o777;
  } catch {
    return 0o600;
  }
}

/**
 * Comment out every enabled line assigning one of `names` and return what changed.
 *
 * `.env.bak` is written first and only once, then the new `.env` goes tmp + rename,
 * removing the tmp on failure — the same backup-once discipline `backupOnce` keeps for the
 * agent configs, because a half-written `.env` is the one write a user cannot recover from
 * and a second backup would overwrite the first pre-edit copy. Nothing is written when no
 * line matched: no backup, no tmp, byte-identical file.
 */
export async function commentOutEnvKeys(
  file: string,
  names: readonly string[],
  opts: CommentOutOptions = {},
): Promise<CommentOutResult> {
  const original = readText(file);
  if (original === null) return { commented: [], backupPath: null };

  const wanted = new Set(names);
  const lines = original.split("\n");
  const hit = new Set<string>();

  lines.forEach((line, i) => {
    const parsed = parseLine(line);
    if (!parsed || !parsed.enabled || !wanted.has(parsed.name)) return;
    lines[i] = `${parsed.indent}#${line.slice(parsed.indent.length)}`;
    hit.add(parsed.name);
  });

  if (hit.size === 0) return { commented: [], backupPath: null };

  const commented = names.filter((name, i) => hit.has(name) && names.indexOf(name) === i);
  const backupPath = `${file}.bak`;
  const tmp = `${file}.tmp`;
  const doRename = opts.rename ?? rename;

  // `wx` refuses an existing `.bak`, so the first pre-edit copy survives every later adopt.
  try {
    await writeFile(backupPath, original, { encoding: "latin1", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  const mode = modeOf(file);
  try {
    await rm(tmp, { force: true });
    await writeFile(tmp, lines.join("\n"), { encoding: "latin1", mode });
    // `writeFile`'s `mode` is masked by the umask; an explicit chmod is not, so `.env`
    // keeps exactly the mode it had instead of drifting to whatever the umask allows.
    await chmod(tmp, mode);
    await doRename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return { commented, backupPath };
}
