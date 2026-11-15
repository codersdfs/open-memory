import { CurationRejected, type SaveInput } from "../core/memoryService.js";
import { TYPES, type MemoryType } from "../core/types.js";
import type { MemoryService } from "../core/memoryService.js";
import { runtimeEnv } from "../core/settings.js";

/**
 * The console agent (ADR-0043): one server-side tool loop over the chat-completions
 * wire, executing the same memory operations the CLI and MCP already expose.
 *
 * Why server-side: the key never crosses to the browser, and the tools run in-process
 * against this daemon's own `MemoryService` — the same partition resolution, the same
 * write gate (ADR-0041) and the same curation (ADR-0040) a `memory_remember` over MCP
 * would hit. The console renders the trace, so every answer shows what ran.
 *
 * Fail-open, like every other judgment seam: without a key the route answers 501
 * `no-model` and the console falls back to its local deterministic commands. A store
 * whose chat dies because an API is down is worse than one that never had a model.
 *
 * Zero dependencies: the wire is one POST and a JSON body, the same shape
 * `extractor.ts:llmExtract` already speaks. `OPENAI_BASE_URL` is honoured so a
 * self-hosted endpoint needs no code change (and so tests can point the loop at a
 * local mock).
 */

const DEFAULT_BASE = "https://api.openai.com/v1";
const MAX_STEPS = 8;
const TIMEOUT_MS = 60_000;
const MAX_MESSAGES = 24;
const MAX_CONTENT = 8000;
/** Tool payloads go back to the model trimmed — a brief can be long; the model needs the head. */
const TOOL_RESULT_MAX = 4000;

export interface AgentStatus {
  /** Whether a chat round-trip is possible at all: a key on the merged seam. */
  llm: boolean;
  model: string | null;
  base: string;
}

/** Read per call, never at module load — a key the console writes to settings.json has to apply live. */
export function agentStatus(env: NodeJS.ProcessEnv = runtimeEnv()): AgentStatus {
  const key = env.OPENAI_API_KEY?.trim();
  return {
    llm: Boolean(key),
    model: key ? env.EXTRACTOR_MODEL?.trim() || "gpt-4o-mini" : null,
    base: env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE,
  };
}

export class AgentNoModel extends Error {
  constructor() {
    super("no-model");
    this.name = "AgentNoModel";
  }
}

export interface AgentTraceStep {
  tool: string;
  args: Record<string, unknown>;
  /** One line for the console's step list — what ran and what it returned, numbers included. */
  summary: string;
}

export interface AgentChatResult {
  reply: string;
  trace: AgentTraceStep[];
  model: string;
}

interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (service: MemoryService, args: Record<string, unknown>, namespace: string) => Promise<{ summary: string; data: unknown }>;
}

function str(v: unknown, max = 5000): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 || t.length > max ? null : t;
}
function numOf(v: unknown, lo: number, hi: number): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined;
}
function clip(s: string, max = TOOL_RESULT_MAX): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

const TOOLS: ToolSpec[] = [
  {
    name: "memory_search",
    description:
      "Hybrid search over long-term memory (vector + BM25 + recency + strength, hard token budget). " +
      "Use before guessing about past decisions, conventions or user preferences.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query (1-2000 chars)" },
        k: { type: "number", description: "Max hits, 1-50, default 5" },
        threshold: { type: "number", description: "Relevance floor 0-1; default 0.35 (agent floor)" },
        type: { type: "string", enum: TYPES },
      },
      required: ["query"],
    },
    run: async (service, args, namespace) => {
      const query = str(args.query, 2000);
      if (!query) throw new Error("query required");
      const r = await service.search({
        query,
        namespace,
        k: numOf(args.k, 1, 50) ?? 5,
        threshold: numOf(args.threshold, 0, 1) ?? 0.35,
        type: str(args.type, 40) as MemoryType | undefined,
      });
      const head = r.memories.slice(0, 3).map((m) => `${m.score.toFixed(2)} ${m.text.slice(0, 120)}`);
      return {
        summary: `${r.memories.length} hit${r.memories.length === 1 ? "" : "s"} · ${r.tokensUsed} tokens`,
        data: { hits: r.memories.map((m) => ({ score: m.score, text: m.text, type: m.type, kind: (m as { kind?: string }).kind })), head },
      };
    },
  },
  {
    name: "memory_brief",
    description:
      "Everything this project already decided, without searching: conventions, decisions, gotchas, open tasks. " +
      "Use for 'what should I know about X' questions.",
    parameters: { type: "object", properties: {} },
    run: async (service, _args, namespace) => {
      const r = await service.brief({ namespace, budgetTokens: 600 });
      return {
        summary: `${r.tokensUsed} tokens · ${r.truncated ? "truncated" : "whole"}`,
        data: { brief: clip(r.text, 3000), tokensUsed: r.tokensUsed },
      };
    },
  },
  {
    name: "memory_list",
    description: "The most recent memories in the namespace, newest first.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "1-20, default 10" } },
    },
    run: async (service, args, namespace) => {
      const r = await service.list({ namespace, limit: numOf(args.limit, 1, 20) ?? 10 });
      return {
        summary: `${r.total} rows in ${namespace}`,
        data: { total: r.total, rows: r.memories.map((m) => ({ id: m.id, type: m.type, text: m.text.slice(0, 160) })) },
      };
    },
  },
  {
    name: "memory_remember",
    description:
      "Store one durable fact for future sessions. Only for things still useful weeks from now — " +
      "not task state. The write gate may reject or demote; report its verdict honestly.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The fact, one self-contained sentence (1-5000 chars)" },
        type: { type: "string", enum: TYPES, description: "default semantic" },
        importance: { type: "number", description: "0-1, default 0.5" },
        tags: { type: "array", items: { type: "string" }, description: "up to 10" },
      },
      required: ["text"],
    },
    run: async (service, args, namespace) => {
      const text = str(args.text, 5000);
      if (!text) throw new Error("text required");
      const input: SaveInput = {
        namespace,
        type: (str(args.type, 40) as MemoryType | undefined) ?? "semantic",
        text,
        importance: numOf(args.importance, 0, 1) ?? 0.5,
        tags: Array.isArray(args.tags) ? args.tags.slice(0, 10).map(String) : undefined,
        source: "agent-chat",
      };
      try {
        const r = await service.saveDetailed(input);
        const what = r.decision.action === "supersede" ? "superseded an older row" : r.decision.action === "reinforce" ? "reinforced an existing row" : "new row";
        return {
          summary: `${what} · ${r.memory.id.slice(0, 8)}`,
          data: { stored: true, action: r.decision.action, id: r.memory.id },
        };
      } catch (e) {
        if (e instanceof CurationRejected) {
          // The verdict is the answer: the model relays the gate's advice instead of apologising.
          return {
            summary: `rejected by write gate (${e.verdict.junk})`,
            data: { stored: false, curation: e.verdict },
          };
        }
        throw e;
      }
    },
  },
  {
    name: "memory_forget",
    description: "Soft-delete one memory by id (kept, restorable). Confirm the id from memory_list or memory_search first.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The memory id" } },
      required: ["id"],
    },
    run: async (service, args) => {
      const id = str(args.id, 100);
      if (!id) throw new Error("id required");
      await service.delete(id);
      return { summary: `soft-deleted ${id.slice(0, 8)}`, data: { ok: true } };
    },
  },
  {
    name: "memory_stats",
    description: "Counts for the namespace: total rows and per-type breakdown.",
    parameters: { type: "object", properties: {} },
    run: async (service, _args, namespace) => {
      const total = (await service.list({ namespace, limit: 1 })).total;
      const byType: Record<string, number> = {};
      for (const t of TYPES) byType[t] = (await service.list({ namespace, type: t, limit: 1 })).total;
      return { summary: `${total} rows`, data: { total, byType } };
    },
  },
];

const TOOLS_WIRE = TOOLS.map((t) => ({
  type: "function" as const,
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

const SYSTEM_PROMPT =
  "You are the open-memory console agent: the user's own memory store, served locally. " +
  "Answer questions about what the memory holds by calling the memory tools — never invent memories. " +
  "When the user asks to remember something, call memory_remember with one self-contained sentence and report the gate's verdict if it is refused. " +
  "Quote scores and counts the tools return. Be concise; the console renders your tool trace beside the reply.";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function sanitizeIncoming(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) throw new Error("messages required");
  const msgs = raw.slice(0, MAX_MESSAGES).map((m): ChatMessage => {
    const rec = m as { role?: unknown; content?: unknown };
    if ((rec.role !== "user" && rec.role !== "assistant") || typeof rec.content !== "string") {
      throw new Error("messages must be {role: user|assistant, content: string}");
    }
    return { role: rec.role, content: clip(rec.content, MAX_CONTENT) };
  });
  if (msgs.length === 0) throw new Error("messages required");
  return msgs;
}

async function completions(
  base: string,
  key: string,
  model: string,
  messages: ChatMessage[],
  fetchImpl: typeof fetch,
): Promise<ChatMessage> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, tools: TOOLS_WIRE, tool_choice: "auto", temperature: 0.2 }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`chat/completions ${res.status} ${clip(detail, 200)}`);
    }
    const body = (await res.json()) as { choices?: { message?: ChatMessage }[] };
    const msg = body.choices?.[0]?.message;
    if (!msg) throw new Error("chat/completions returned no message");
    return msg;
  } finally {
    clearTimeout(timer);
  }
}

export async function agentChat(
  service: MemoryService,
  body: Record<string, unknown>,
  opts?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch },
): Promise<AgentChatResult> {
  const env = opts?.env ?? runtimeEnv();
  const status = agentStatus(env);
  if (!status.llm || status.model === null) throw new AgentNoModel();
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const key = env.OPENAI_API_KEY!.trim();

  const namespace = str(body.namespace, 200) ?? "default:default";
  const incoming = sanitizeIncoming(body.messages);
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...incoming];
  const trace: AgentTraceStep[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const msg = await completions(status.base, key, status.model, messages, fetchImpl);
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      return { reply: (msg.content ?? "").trim(), trace, model: status.model };
    }
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
    for (const call of calls) {
      const spec = TOOLS.find((t) => t.name === call.function.name);
      let result: { summary: string; data: unknown };
      let args: Record<string, unknown> = {};
      if (!spec) {
        result = { summary: "unknown tool", data: { error: `unknown tool ${call.function.name}` } };
      } else {
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          result = { summary: "bad arguments (not JSON)", data: { error: "arguments must be a JSON object" } };
          messages.push({ role: "tool", tool_call_id: call.id, content: clip(JSON.stringify(result)) });
          trace.push({ tool: call.function.name, args: {}, summary: result.summary });
          continue;
        }
        try {
          result = await spec.run(service, args, namespace);
        } catch (e) {
          result = { summary: `failed: ${e instanceof Error ? e.message : String(e)}`, data: { error: e instanceof Error ? e.message : String(e) } };
        }
      }
      trace.push({ tool: call.function.name, args, summary: result.summary });
      messages.push({ role: "tool", tool_call_id: call.id, content: clip(JSON.stringify(result)) });
    }
  }
  throw new Error(`agent loop did not converge in ${MAX_STEPS} steps`);
}
