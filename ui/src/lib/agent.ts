/**
 * The Agent view's brain (ADR-0043): try the server's LLM tool loop first, and when the
 * daemon has no key (501 `no-model`) fall back to this deterministic engine — intent
 * parsed off the message, executed against the same HTTP API every other view reads.
 *
 * The local mode is a real mode, not a stub: every block it returns is a wire answer
 * (hits carry their explain decomposition; a refused save carries the write gate's
 * verdict verbatim). Nothing here invents a number, which is the same rule the Recall
 * view's D4 sets for scores.
 */
import { api } from "./api";
import type { AgentStatus, AgentChatMessage, AgentTraceStep, Memory, SearchResult, BriefResult } from "./api";

export type AgentBlock =
  | { kind: "text"; text: string }
  | { kind: "hits"; result: SearchResult; query: string }
  | { kind: "saved"; memory: Memory }
  | { kind: "rejected"; title: string; advice: string }
  | { kind: "brief"; result: BriefResult }
  | { kind: "stats"; namespace: string; total: number; byType: Record<string, number> }
  | { kind: "trace"; steps: AgentTraceStep[]; model: string }
  | { kind: "error"; text: string };

export interface AgentTurnBlocks {
  blocks: AgentBlock[];
}

export const SUGGESTIONS: readonly string[] = [
  "帮我记住:daemon 只能绑定 127.0.0.1",
  "还记得我们为什么把底线降到 0.35 吗?",
  "概要",
  "统计",
];

let statusCache: AgentStatus | null = null;

/** One read of /agent/status per session; the pill and the dispatch both want it. */
export async function preflight(): Promise<AgentStatus | null> {
  if (statusCache !== null) return statusCache;
  statusCache = await api.agentStatus().catch(() => null);
  return statusCache;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** src/api/server.ts:650-661 — a refused save answers 422 {error, curation: verdict}. */
function curationOf(e: unknown): { title: string; advice: string } | null {
  if (typeof e !== "object" || e === null) return null;
  const status = (e as { status?: unknown }).status;
  if (status !== 422) return null;
  const body = (e as unknown as { body?: { curation?: { junk?: string; advice?: string } } }).body;
  const c = body?.curation;
  if (c === undefined || typeof c !== "object") return null;
  return { title: `策展拒绝 · ${c.junk ?? "low-value"}`, advice: c.advice ?? "" };
}

const REMEMBER_RE = /^(?:请|帮我|give me a hand,)?\s*(?:记住|記住|记一下|存一下|remember)\s*[:：,，]?\s*/i;
const BRIEF_RE = /^(?:请|帮我)?\s*(?:概要|摘要|总结|brief)\s*[:：]?\s*/i;
const STATS_RE = /^(?:统计|stats)\s*$/i;

async function llmTurn(input: string, namespace: string): Promise<AgentTurnBlocks | null> {
  const status = await preflight();
  if (status === null || !status.llm) return null;
  const messages: AgentChatMessage[] = [{ role: "user", content: input }];
  try {
    const r = await api.agentChat({ messages, namespace });
    const blocks: AgentBlock[] = [];
    if (r.trace.length > 0) blocks.push({ kind: "trace", steps: r.trace, model: r.model });
    blocks.push({ kind: "text", text: r.reply === "" ? "(模型没有返回内容)" : r.reply });
    return { blocks };
  } catch (e) {
    const status401 = typeof e === "object" && e !== null && "status" in e && (e as { status: number }).status;
    if (status401 === 501) return null; // key vanished between status and chat — go local
    return { blocks: [{ kind: "error", text: `LLM 模式失败,本地模式同样可用。${errText(e)}` }] };
  }
}

async function localTurn(input: string, namespace: string): Promise<AgentTurnBlocks> {
  const remember = input.match(REMEMBER_RE);
  if (remember !== null) {
    const text = input.slice(remember[0].length).trim();
    if (text === "") {
      return { blocks: [{ kind: "text", text: "要记住的内容写在「记住:」后面——比如:记住 daemon 只能绑定 127.0.0.1。" }] };
    }
    try {
      const memory = await api.create({ namespace, type: "semantic", text, source: "agent-chat" });
      return {
        blocks: [
          { kind: "saved", memory },
          { kind: "text", text: `已存入 ${namespace}。它现在可以被检索,也会参与写入时的近邻比对。` },
        ],
      };
    } catch (e) {
      const rejected = curationOf(e);
      if (rejected !== null) return { blocks: [{ kind: "rejected", ...rejected }] };
      return { blocks: [{ kind: "error", text: errText(e) }] };
    }
  }

  if (BRIEF_RE.test(input)) {
    try {
      const result = await api.brief({ namespace, budgetTokens: 600 });
      return { blocks: [{ kind: "brief", result }] };
    } catch (e) {
      return { blocks: [{ kind: "error", text: errText(e) }] };
    }
  }

  if (STATS_RE.test(input.trim())) {
    try {
      const s = await api.stats(namespace, false);
      return { blocks: [{ kind: "stats", namespace, total: s.total, byType: s.byType }] };
    } catch (e) {
      return { blocks: [{ kind: "error", text: errText(e) }] };
    }
  }

  // Everything else is a search — the same floor the agent tools use (0.35), so a
  // question that answers nothing here also answers nothing over MCP.
  try {
    const result = await api.search({ query: input, namespace, k: 5, threshold: 0.35 });
    return {
      blocks: [
        { kind: "text", text: `在 ${namespace} 里找到 ${result.memories.length} 条:` },
        { kind: "hits", result, query: input },
      ],
    };
  } catch (e) {
    return { blocks: [{ kind: "error", text: errText(e) }] };
  }
}

/** One console turn: LLM when the daemon has a key, deterministic otherwise. */
export async function respond(input: string, namespace: string): Promise<AgentTurnBlocks> {
  const viaLlm = await llmTurn(input, namespace);
  if (viaLlm !== null) return viaLlm;
  return localTurn(input, namespace);
}
