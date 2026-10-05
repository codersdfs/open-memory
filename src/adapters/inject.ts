import { MemoryService } from "../core/memoryService.js";
import type { MemoryType } from "../core/types.js";
import { resolveAgent, resolveRequestScope } from "../core/scope.js";

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

export function renderBlock(
  memories: { id: string; text: string; type: string; namespace: string; score?: number }[],
  opts: { agent: string; cwd: string | null }
): string {
  const lines = memories.map((m) => {
    const where = m.namespace.startsWith("shared:") ? "shared" : "private";
    return `- (${where}/${m.type}) ${m.text.replace(/\s+/g, " ").trim()}`;
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

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
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

  const svc = opts.service ?? new MemoryService({ dbPath: opts.db });
  if (!opts.service) await svc.init();
  try {
    const result = await svc.search({
      query: searchText,
      namespaces,
      agent,
      k: opts.limit ?? 5,
      budgetTokens: opts.budgetTokens ?? Number(process.env.AI_MEMORY_INJECT_BUDGET ?? 600),
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
