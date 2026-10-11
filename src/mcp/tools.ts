import type { MemoryService } from "../core/memoryService.js";
import type { Memory, MemoryType, SearchResult } from "../core/types.js";
import { stripEmbedding } from "../core/types.js";
import { resolveAgent, resolveRequestScope, resolveWriteKey, type MemoryScope } from "../core/scope.js";

/**
 * The tool surface exposed over MCP.
 *
 * Names are `memory_*` on purpose: the pi extension already teaches agents a
 * `memory_search` tool, and cross-agent memory should not force every prompt to be
 * rewritten. Every tool accepts `scope`, because "is this fact mine or everyone's"
 * is the one decision the model must make explicitly.
 */

export interface ToolContext {
  service: MemoryService;
  /** Agent this server is running for (`--agent`, else detection). */
  defaultAgent: string;
  /** Default scope when a call omits it. */
  defaultScope?: MemoryScope;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

const SCOPE_PROP = {
  type: "string",
  enum: ["private", "shared"],
  description:
    "private = only this agent's layer; shared = the cross-agent layer every agent can read. Default: private for writes, both layers for reads."
};

const TYPE_PROP = { type: "string", enum: ["episodic", "semantic", "procedural", "working"] };

export const MEMORY_TOOLS: McpTool[] = [
  {
    name: "memory_search",
    description:
      "Search long-term memory (this agent's private notes plus the shared cross-agent layer). Returns scored memories and the token budget used. Use before guessing about past decisions, conventions, or user preferences.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to recall." },
        scope: SCOPE_PROP,
        k: { type: "integer", description: "Max memories to return (default 5)." },
        budgetTokens: { type: "integer", description: "Hard token cap for the result (default 800)." },
        threshold: { type: "number", description: "Minimum hybrid score (default 0.35)." },
        type: TYPE_PROP
      },
      required: ["query"]
    }
  },
  {
    name: "memory_remember",
    description:
      "Store one durable fact. Use scope=shared for anything another agent would need (project conventions, commands, environment facts); scope=private for notes that only make sense for this agent or this user.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The memory, self-contained and specific." },
        scope: SCOPE_PROP,
        type: TYPE_PROP,
        importance: { type: "number", description: "0..1, default 0.5." },
        tags: { type: "array", items: { type: "string" } },
        source: { type: "string", description: "Where this came from (file, task, conversation)." }
      },
      required: ["text"]
    }
  },
  {
    name: "memory_list",
    description: "List the most recent memories in the resolved scope(s).",
    inputSchema: {
      type: "object",
      properties: {
        scope: SCOPE_PROP,
        limit: { type: "integer", description: "Default 20." },
        type: TYPE_PROP
      }
    }
  },
  {
    name: "memory_get",
    description: "Fetch one memory by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    }
  },
  {
    name: "memory_forget",
    description:
      "Soft-delete a memory (it is kept and can be restored). Use for facts that are wrong or obsolete rather than for tidying.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    }
  },
  {
    name: "memory_stats",
    description: "Counts per scope and type, plus which embedding provider is in use.",
    inputSchema: {
      type: "object",
      properties: { scope: SCOPE_PROP, all: { type: "boolean" } }
    }
  }
];

export interface McpToolResult {
  /** Human/model readable block. */
  text: string;
  /** Structured payload for clients that want it. */
  structured: unknown;
  isError?: boolean;
}

const asScope = (v: unknown): MemoryScope | undefined => (v === "shared" ? "shared" : v === "private" ? "private" : undefined);

function renderSearch(r: SearchResult, budget: number): string {
  if (r.memories.length === 0) return "no memories matched";
  const lines = r.memories.map((m) => {
    const flags = [m.type, m.namespace, typeof m.score === "number" ? m.score.toFixed(3) : "-"].join("/");
    return `[${m.id}] (${flags}) ${m.text.replace(/\s+/g, " ").trim()}`;
  });
  lines.push(`tokens: ${r.tokensUsed}/${budget}${r.truncated ? " (truncated)" : ""}`);
  return lines.join("\n");
}

/** Dispatch one `tools/call`. Errors become tool results, never protocol failures. */
export async function callTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    switch (name) {
      case "memory_search": {
        const query = String(args.query ?? "").trim();
        if (!query) return { text: "memory_search: query is required", structured: null, isError: true };
        const budgetTokens = Number(args.budgetTokens ?? 800);
        const { namespaces } = resolveRequestScope({
          agent: ctx.defaultAgent,
          scope: asScope(args.scope) ?? ctx.defaultScope
        });
        const result = await ctx.service.search({
          query,
          namespaces,
          agent: ctx.defaultAgent,
          type: args.type as MemoryType | undefined,
          k: args.k === undefined ? 5 : Number(args.k),
          budgetTokens,
          threshold: args.threshold === undefined ? 0.35 : Number(args.threshold)
        });
        return {
          text: renderSearch(result, budgetTokens),
          structured: { ...result, memories: result.memories.map(stripEmbedding) }
        };
      }

      case "memory_remember": {
        const text = String(args.text ?? "").trim();
        if (!text) return { text: "memory_remember: text is required", structured: null, isError: true };
        const scope = asScope(args.scope) ?? ctx.defaultScope ?? "private";
        const namespace = resolveWriteKey({ agent: ctx.defaultAgent, scope });
        const memory = await ctx.service.save({
          namespace,
          text,
          type: (args.type as MemoryType | undefined) ?? "semantic",
          importance: args.importance === undefined ? undefined : Number(args.importance),
          tags: Array.isArray(args.tags) ? (args.tags as string[]).map(String) : undefined,
          source: args.source === undefined ? `mcp:${ctx.defaultAgent}` : String(args.source)
        });
        const action = memory.text === text ? "stored" : "already known";
        return {
          text: `${action}: ${memory.id} → ${memory.namespace}`,
          structured: stripEmbedding(memory)
        };
      }

      case "memory_list": {
        const { namespaces } = resolveRequestScope({
          agent: ctx.defaultAgent,
          scope: asScope(args.scope) ?? ctx.defaultScope
        });
        const limit = args.limit === undefined ? 20 : Number(args.limit);
        const memories: Memory[] = [];
        let total = 0;
        for (const ns of namespaces) {
          const page = await ctx.service.list({ namespace: ns, type: args.type as MemoryType | undefined, limit });
          memories.push(...page.memories);
          total += page.total;
        }
        const text =
          memories.length === 0
            ? "no memories"
            : memories
                .map((m) => `[${m.id}] (${m.type}/${m.namespace}) ${m.text.replace(/\s+/g, " ").slice(0, 160)}`)
                .join("\n") + `\n→ ${memories.length} of ${total}`;
        return { text, structured: { memories: memories.map(stripEmbedding), total, scopes: namespaces } };
      }

      case "memory_get": {
        const id = String(args.id ?? "").trim();
        if (!id) return { text: "memory_get: id is required", structured: null, isError: true };
        const memory = await ctx.service.getActive(id);
        if (!memory) return { text: `no memory ${id}`, structured: null, isError: true };
        return { text: `[${memory.id}] (${memory.type}/${memory.namespace})\n${memory.text}`, structured: stripEmbedding(memory) };
      }

      case "memory_forget": {
        const id = String(args.id ?? "").trim();
        if (!id) return { text: "memory_forget: id is required", structured: null, isError: true };
        const memory = await ctx.service.getActive(id);
        if (!memory) return { text: `no memory ${id}`, structured: null, isError: true };
        await ctx.service.delete(id);
        return { text: `forgot ${id}`, structured: { id, deleted: true } };
      }

      case "memory_stats": {
        const { namespaces } = resolveRequestScope({
          agent: ctx.defaultAgent,
          scope: asScope(args.scope) ?? ctx.defaultScope,
          all: args.all === true
        });
        const perScope: Record<string, { total: number; byType: Record<string, number> }> = {};
        for (const ns of namespaces) {
          const byType: Record<string, number> = {};
          for (const t of ["episodic", "semantic", "procedural", "working"] as const) {
            byType[t] = (await ctx.service.list({ namespace: ns, type: t, limit: 1 })).total;
          }
          perScope[ns] = { total: (await ctx.service.list({ namespace: ns, limit: 1 })).total, byType };
        }
        const text = namespaces.map((ns) => `${ns}: ${perScope[ns]!.total}`).join("\n");
        return {
          text,
          structured: { scopes: namespaces, perScope, embedding: ctx.service.embedder.name, dim: ctx.service.embedder.dim }
        };
      }

      default:
        return { text: `unknown tool: ${name}`, structured: null, isError: true };
    }
  } catch (err) {
    return { text: `${name} failed: ${(err as Error).message}`, structured: null, isError: true };
  }
}

export function agentDescription(agent: string): string {
  return `ai-memory shared memory (agent: ${resolveAgent(agent)}). Private notes plus a shared layer all agents can read.`;
}
