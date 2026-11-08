import { MemoryService } from "../core/memoryService.js";
import type { BriefResult, MemoryType, SearchResult } from "../core/types.js";
import { resolveAgent, resolveRequestScope } from "../core/scope.js";
import { MemoryClient } from "../cli/http.js";
import { appVersion } from "../version.js";

/**
 * `ai-memory inject` — the hook side of memory.
 *
 * Hooks are the only way memory reaches agents that predate MCP (and the cheapest way
 * for the ones that do not): the agent pipes its hook payload on stdin and the block
 * printed on stdout becomes context for the turn. Consequences of that contract:
 *
 *  - **never fail loudly.** A hook that exits non-zero or prints a stack trace shows up
 *    as noise in the user's terminal on every single turn. Any error degrades to empty
 *    output and a stderr note.
 *  - **stay inside a token budget.** This text is prepended to every prompt, so the
 *    default budget is small and the block is dropped entirely when nothing scores.
 *  - **be quiet when there is nothing to say.** No matches means no output at all.
 */

export interface InjectOptions {
  agent?: string;
  /** session-start | prompt-submit | stop | auto (default: sniff the payload). */
  mode?: string;
  db?: string;
  /**
   * Daemon base URL. P7 (ADR-0049) made this option live: with it set, the hook asks
   * the daemon first and rides the same wire as the CLI — principal token included,
   * because the client attaches it. Without it the hook opens the store in-process,
   * exactly as it always has (a hook's boundary is the OS account it runs under; the
   * daemon's token gate is about *cross*-account callers, and probing a daemon the
   * caller never named would make every hook's colour depend on whatever happens to
   * listen on :3000).
   */
  server?: string;
  noDaemon?: boolean;
  budgetTokens?: number;
  threshold?: number;
  limit?: number;
  json?: boolean;
  /** Test seam: inject a service. */
  service?: MemoryService;
  /** Test seam: raw stdin content instead of reading the real stdin. */
  stdin?: string;
}

interface HookPayload {
  mode: string;
  prompt: string;
  sessionId: string | null;
  cwd: string | null;
  raw: unknown;
}

const STOP_PATTERNS = [/stop/i, /turn[-_]?end/i, /session[-_]?end/i, /^shutdown$/i];

export function parseHookPayload(raw: string, explicitMode?: string): HookPayload {
  const text = raw.trim();
  let parsed: Record<string, unknown> = {};
  if (text.startsWith("{")) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  const eventName = String(parsed.hook_event_name ?? parsed.hookEventName ?? parsed.event ?? parsed.type ?? "");
  const explicit = explicitMode && explicitMode !== "auto" ? explicitMode : null;
  const mode = explicit ?? (STOP_PATTERNS.some((re) => re.test(eventName)) ? "stop" : eventName ? "prompt-submit" : "prompt-submit");

  const prompt = String(
    parsed.prompt ?? parsed.user_prompt ?? parsed.userPrompt ?? parsed.message ?? parsed.input ?? parsed.text ?? text ?? ""
  ).trim();

  const sessionId =
    (parsed.session_id as string | undefined) ?? (parsed.sessionId as string | undefined) ?? null;
  const cwd = ((parsed.cwd as string | undefined) ?? (parsed.workspace as string | undefined) ?? null) || null;

  return { mode, prompt, sessionId, cwd, raw: parsed };
}

/** Extract query text and keywords from a hook payload. */
export function deriveQuery(payload: HookPayload): { query: string; keywords: string[] } {
  const prompt = payload.prompt;
  if (!prompt) return { query: "", keywords: [] };
  const firstLine = prompt.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const query = firstLine.slice(0, 400);
  // Dedupe before slicing, or a long prompt's later topics never become keywords.
  // Leading/trailing punctuation is trimmed so "kubernetes." matches "kubernetes".
  const keywords = [
    ...new Set(
      prompt
        .toLowerCase()
        .split(/[^a-z0-9_./#-]+/)
        .map((w) => w.replace(/^[./#-]+|[./#-]+$/g, ""))
        .filter((w) => w.length >= 4)
    )
  ].slice(0, 12);
  return { query, keywords };
}

/** The extractor writes the resolved date as a tag; that date outranks the row's birth. */
const AT_TAG = /^at:(\d{4}-\d{2}-\d{2})$/;

/**
 * When the memory is *about*, not when it was written. A row can be stored days after the
 * event it records, so the explicitly resolved `at:` date wins; `createdAt` is the
 * fallback (UTC day, because it is an epoch and this module must not depend on the
 * machine's timezone for a value that came from another one).
 */
function memoryDate(m: { tags?: string[]; createdAt?: number }): string | null {
  for (const tag of m.tags ?? []) {
    const hit = AT_TAG.exec(String(tag).trim());
    if (hit) return hit[1];
  }
  if (typeof m.createdAt === "number" && Number.isFinite(m.createdAt)) {
    return new Date(m.createdAt).toISOString().slice(0, 10);
  }
  return null;
}

export function renderBlock(
  memories: { id: string; text: string; type: string; namespace: string; score?: number; tags?: string[]; createdAt?: number }[],
  opts: { agent: string; cwd: string | null }
): string {
  const lines = memories.map((m) => {
    const where = m.namespace.startsWith("shared:") ? "shared" : "private";
    // episodic is about when it happened and semantic about when it was learned; both
    // read as stale without a date, and a stale fact is indistinguishable from a wrong
    // one. procedural/working are instructions, so a date would only add noise.
    const dated = m.type === "episodic" || m.type === "semantic";
    const date = dated ? memoryDate(m) : null;
    const stamp = date ? ` [${date}]` : "";
    return `- (${where}/${m.type})${stamp} ${m.text.replace(/\s+/g, " ").trim()}`;
  });
  return [
    "<memory-context>",
    `Recalled from ai-memory for agent "${opts.agent}"${opts.cwd ? ` in ${opts.cwd}` : ""}.`,
    "These are stored facts from earlier sessions; they may be stale — verify before relying on them.",
    ...lines,
    "Use memory_search / memory_remember (MCP) or `ai-memory search|save` to add more.",
    "</memory-context>"
  ].join("\n");
}

/**
 * The session-start block: the brief instead of a search (ADR-0022).
 *
 * A hook fires at the moment a session opens, when there is no prompt and therefore no
 * query — the old code searched for `"*"`, which is a query the retriever cannot answer
 * meaningfully. The brief is built for exactly this moment: fixed sections, fixed order,
 * no ranking to be surprised by. It is wrapped in the same envelope as a recalled block
 * so an agent sees one kind of context, not two.
 */
export function renderBriefBlock(text: string, opts: { agent: string; cwd: string | null }): string {
  return [
    "<memory-context>",
    `Project memory for agent "${opts.agent}"${opts.cwd ? ` in ${opts.cwd}` : ""}.`,
    "These are durable notes from earlier sessions — decisions, conventions and gotchas already settled.",
    "Verify before relying on them; correct one you know to be wrong rather than working around it.",
    "",
    text,
    "Use memory_search / memory_remember (MCP) or `ai-memory search|save` to add more.",
    "</memory-context>"
  ].join("\n");
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The hook over the daemon (`--server`), P7 (ADR-0049). Same branches as the in-process
 * body below — brief for a session start with nothing to query, sweep otherwise — served
 * over the wire the CLI uses, principal token included (the client attaches it). Any
 * refusal, mismatch or error answers `null` and the caller falls back to the store it
 * can open in-process: a hook's first contract is that the user's turn never waits on
 * or breaks for memory.
 */
async function daemonInjection(
  opts: InjectOptions,
  args: {
    agent: string;
    cwd: string | null;
    query: string;
    keywords: string[];
    searchText: string;
    namespaces: string[];
  }
): Promise<string | null> {
  try {
    const client = new MemoryClient(opts.server);
    const health = await client.health();
    if (!health?.ok) return null;
    // The same stale-daemon guard the CLI applies: a daemon left from an older install
    // answers /health happily while serving routes that may not exist yet.
    if (health.version !== (await appVersion())) return null;

    const budgetTokens = opts.budgetTokens ?? Number(process.env.AI_MEMORY_INJECT_BUDGET ?? 600);
    if (!args.query && args.keywords.length === 0) {
      const res = await client.get<BriefResult>(
        "/brief" + MemoryClient.query({ namespaces: args.namespaces.join(","), budgetTokens })
      );
      if (res.ok && res.data.sections.some((s) => s.items.length > 0)) {
        return renderBriefBlock(res.data.text, { agent: args.agent, cwd: args.cwd });
      }
      // Nothing filed (or an older route): fall through to the sweep, like the
      // in-process body does.
    }
    const threshold = opts.threshold ?? Number(process.env.AI_MEMORY_INJECT_THRESHOLD ?? 0.25);
    const res = await client.get<SearchResult>(
      "/memories/search" +
        MemoryClient.query({
          query: args.searchText,
          namespaces: args.namespaces.join(","),
          k: opts.limit ?? 5,
          budgetTokens,
          threshold,
        })
    );
    if (!res.ok) return null;
    if (res.data.memories.length === 0) return "";
    return renderBlock(res.data.memories, { agent: args.agent, cwd: args.cwd });
  } catch {
    return null;
  }
}

/** The whole hook, minus process wiring, so it is unit-testable. */
export async function buildInjection(opts: InjectOptions): Promise<string> {
  const raw = opts.stdin ?? (await readStdin());
  const payload = parseHookPayload(raw, opts.mode);
  if (payload.mode === "stop") return "";

  const { query, keywords } = deriveQuery(payload);
  // SessionStart payloads usually carry no prompt; fall back to a broad sweep so the
  // first turn still gets the user's pinned/high-importance context.
  const searchText = query || keywords.join(" ") || "*";
  const agent = resolveAgent(opts.agent);
  const { namespaces } = resolveRequestScope({ agent });

  if (!opts.service && opts.server && !opts.noDaemon) {
    const block = await daemonInjection(opts, {
      agent,
      cwd: payload.cwd,
      query,
      keywords,
      searchText,
      namespaces,
    });
    if (block !== null) return block;
  }

  const svc = opts.service ?? new MemoryService({ dbPath: opts.db });
  if (!opts.service) await svc.init();
  try {
    const budgetTokens = opts.budgetTokens ?? Number(process.env.AI_MEMORY_INJECT_BUDGET ?? 600);
    // SessionStart: no prompt, so no query. Ask for the brief; fall through to the old
    // sweep only when the project has nothing filed (an un-projected store, or the very
    // first session), so an existing install does not lose the pinned context it had.
    if (!query && keywords.length === 0 && typeof svc.brief === "function") {
      const brief = await svc.brief({ namespaces, agent, budgetTokens });
      if (brief.sections.some((s) => s.items.length > 0)) {
        return renderBriefBlock(brief.text, { agent, cwd: payload.cwd });
      }
    }
    const result = await svc.search({
      query: searchText,
      namespaces,
      agent,
      k: opts.limit ?? 5,
      budgetTokens,
      threshold: opts.threshold ?? Number(process.env.AI_MEMORY_INJECT_THRESHOLD ?? 0.25),
      type: undefined as MemoryType | undefined
    });
    if (result.memories.length === 0) return "";
    return renderBlock(result.memories, { agent, cwd: payload.cwd });
  } finally {
    if (!opts.service) await svc.close();
  }
}

export async function runInject(opts: InjectOptions): Promise<number> {
  try {
    const block = await buildInjection(opts);
    if (!block) return 0;
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: block } }) + "\n"
      );
    } else {
      process.stdout.write(block + "\n");
    }
    return 0;
  } catch (err) {
    // A hook must never break the agent's turn.
    process.stderr.write(`[ai-memory] inject skipped: ${(err as Error).message}\n`);
    return 0;
  }
}
