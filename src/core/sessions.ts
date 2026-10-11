import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * pi's own session transcript directory.
 *
 * This is the one place in the project that reads a format it does not own — pi
 * writes the `.jsonl`, and its shape can change without asking. So the parser is
 * deliberately tolerant (unknown fields ignored, malformed lines kept as text)
 * and this module never writes: a timeline that can corrupt the timeline is not a
 * timeline. Nothing is indexed into SQLite either, because a second copy of pi's
 * own files is a stale copy.
 */

export class SessionError extends Error {
  constructor(public code: "bad-id" | "not-found", message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export interface SessionTurn {
  index: number;
  role: string;
  tool: string | null;
  timestamp: number | null;
  /** True for a malformed line too: an unparseable turn is a failure, not a turn. */
  isError: boolean;
  text: string;
}

export interface SessionInfo {
  /** Root-relative posix path — the id every other call takes. */
  id: string;
  file: string;
  dir: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface SessionFile {
  id: string;
  file: string;
  /** Lines seen. With `truncated`, this counts what was read, not what is there. */
  total: number;
  turns: SessionTurn[];
  truncated: boolean;
}

const MAX_BYTES = 24 * 1024 * 1024;
const DEFAULT_CHARS = 400;
const LIST_LIMIT = 50;
const TURN_LIMIT = 200;
const MAX_TURN_LIMIT = 500;

/** `PI_SESSIONS` wins; otherwise pi's default agent dir. Never taken from a request. */
export function sessionsRoot(): string {
  const explicit = process.env.PI_SESSIONS?.trim();
  if (explicit) return resolve(explicit);
  const agentDir = process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return resolve(agentDir, "sessions");
}

async function walk(dir: string, out: string[]): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // a missing sessions dir is an empty timeline, not a crash
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

const toId = (root: string, file: string) => file.slice(root.length + 1).split(sep).join("/");

export async function listSessions(opts?: { root?: string; limit?: number; offset?: number }): Promise<{ root: string; total: number; sessions: SessionInfo[] }> {
  const root = resolve(opts?.root ?? sessionsRoot());
  const limit = clamp(opts?.limit ?? LIST_LIMIT, 1, MAX_TURN_LIMIT);
  const offset = clamp(opts?.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);

  const files = await walk(root, []);
  const infos = await Promise.all(files.map(async (file): Promise<SessionInfo | null> => {
    try {
      const s = await stat(file);
      return { id: toId(root, file), file, dir: join(file, ".."), mtimeMs: s.mtimeMs, sizeBytes: s.size };
    } catch {
      return null; // deleted between walk and stat
    }
  }));
  const sorted = infos.filter((i): i is SessionInfo => i !== null).sort((a, b) => b.mtimeMs - a.mtimeMs);
  // Turn counts are deliberately absent from the list: counting lines means reading
  // every file, and 50 transcripts is up to 250 MB to render a column. The count
  // arrives when a session is opened, where the file has to be read anyway.
  return { root, total: sorted.length, sessions: sorted.slice(offset, offset + limit) };
}

/** An id is only ever a path *below* the sessions root: no absolute paths, no `..`, no `.jsonl`-less names. */
function resolveId(root: string, id: string): string {
  const bad = (why: string) => new SessionError("bad-id", `bad session id: ${why}`);
  if (!id || id.length > 500) throw bad("empty");
  if (id.includes("\0")) throw bad("nul byte");
  if (/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(id)) throw bad("absolute path");
  const parts = id.split(/[\\/]/);
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw bad("relative segment");
  if (!id.endsWith(".jsonl")) throw bad("not a .jsonl session");

  const base = resolve(root);
  const file = resolve(base, ...parts);
  if (!file.startsWith(base + sep)) throw bad("outside the sessions root");
  return file;
}

function clip(text: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "…";
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** First string that looks like the turn's body, in the order pi writes them. */
function body(o: Record<string, unknown>): string | null {
  const direct = str(o.text) ?? str(o.content) ?? str(o.message);
  if (direct) return direct;
  const msg = o.message;
  if (msg && typeof msg === "object" && !Array.isArray(msg)) {
    const inner = (msg as Record<string, unknown>).content;
    if (typeof inner === "string") return inner;
    // content parts — take their text, ignore images and tool payloads
    if (Array.isArray(inner)) {
      const parts = inner.map((p) => (p && typeof p === "object" ? str((p as Record<string, unknown>).text) : null)).filter(Boolean);
      if (parts.length) return parts.join("\n");
    }
  }
  if (Array.isArray(o.content)) {
    const parts = o.content.map((p) => (p && typeof p === "object" ? str((p as Record<string, unknown>).text) : null)).filter(Boolean);
    if (parts.length) return parts.join("\n");
  }
  return null;
}

function parseTurn(line: string, index: number, maxChars: number): SessionTurn {
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
  } catch {
    // malformed: still evidence about the session, so it stays visible as a turn
  }
  const role = str(obj?.role) ?? str(obj?.type) ?? "unknown";
  const tool = str(obj?.tool) ?? str(obj?.toolName) ?? null;
  const ts = obj?.timestamp;
  const text = obj ? body(obj) ?? clip(JSON.stringify(obj), maxChars) : line;
  return {
    index,
    role,
    tool,
    timestamp: typeof ts === "number" && Number.isFinite(ts) ? ts : null,
    isError: obj === null || obj.isError === true,
    text: clip(text, maxChars)
  };
}

/**
 * Read one transcript, line-paged.
 *
 * The byte cap exists because these files are unbounded: 24 MB of turn text is
 * already more than a UI can show, and `truncated: true` is a better answer than
 * an out-of-memory read. When the cap lands mid-line the partial line is dropped
 * rather than parsed — half a JSON object is not a turn.
 */
export async function readSession(
  id: string,
  opts?: { root?: string; offset?: number; limit?: number; maxChars?: number; maxBytes?: number }
): Promise<SessionFile> {
  const root = resolve(opts?.root ?? sessionsRoot());
  const file = resolveId(root, id);
  const offset = clamp(opts?.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = clamp(opts?.limit ?? TURN_LIMIT, 1, MAX_TURN_LIMIT);
  const maxChars = opts?.maxChars ?? DEFAULT_CHARS;
  const maxBytes = clamp(opts?.maxBytes ?? MAX_BYTES, 1, Number.MAX_SAFE_INTEGER);

  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    throw new SessionError("not-found", `no such session: ${id}`);
  }
  const readBytes = Math.min(size, maxBytes);
  const truncated = readBytes < size;

  const fh = await open(file, "r");
  let raw = "";
  try {
    const buf = Buffer.allocUnsafe(readBytes);
    await fh.read(buf, 0, readBytes, 0);
    raw = buf.toString("utf8");
  } finally {
    await fh.close();
  }
  if (truncated) {
    const lastNewline = raw.lastIndexOf("\n");
    raw = lastNewline > 0 ? raw.slice(0, lastNewline) : "";
  }

  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  const turns = lines.slice(offset, offset + limit).map((l, i) => parseTurn(l, offset + i, maxChars));
  return { id: toId(root, file), file, total: lines.length, turns, truncated };
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), lo), hi) : lo;
}
