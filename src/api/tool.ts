import type { MemoryService } from "../core/memoryService.js";

/**
 * Agent wiring — tool-first (ADR-0003)
 * Vercel AI SDK style tool definition; also usable with any function-calling agent.
 */
export function createMemoryTool(service: MemoryService) {
  return {
    description: "Search AI memory. Use when you need prior facts, preferences, or episodes. Returns scored memories within token budget.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "natural language query" },
        namespace: { type: "string", description: "agentId:userId", default: "default:default" },
        k: { type: "number", description: "max memories", default: 5 },
        budgetTokens: { type: "number", description: "hard token cap", default: 800 },
        type: { type: "string", enum: ["episodic", "semantic", "procedural", "working"] }
      },
      required: ["query"]
    },
    execute: async (args: { query: string; namespace?: string; k?: number; budgetTokens?: number; type?: "episodic" | "semantic" | "procedural" | "working" }) => {
      return service.search({
        query: args.query,
        namespace: args.namespace ?? "default:default",
        k: args.k ?? 5,
        budgetTokens: args.budgetTokens ?? 800,
        type: args.type
      });
    }
  };
}

export async function autoInject(
  service: MemoryService,
  messages: { role: string; content: string }[],
  opts?: { namespace?: string; k?: number; budgetTokens?: number; threshold?: number }
): Promise<{ injected: string | null; result: Awaited<ReturnType<MemoryService["search"]>> | null }> {
  if (messages.length === 0) return { injected: null, result: null };
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return { injected: null, result: null };
  const result = await service.search({
    query: lastUser.content,
    namespace: opts?.namespace ?? "default:default",
    k: opts?.k ?? 5,
    budgetTokens: opts?.budgetTokens ?? 800,
    threshold: opts?.threshold ?? 0.72
  });
  if (result.memories.length === 0) return { injected: null, result };
  const injected =
    `## Recalled memories (${result.tokensUsed} tokens${result.truncated ? ", truncated" : ""})\n` +
    result.memories.map((m) => `- [${m.type} ${m.score.toFixed(2)}] ${m.text}`).join("\n") +
    (result.summary ? `\n> Overflow summary: ${result.summary}` : "");
  return { injected, result };
}
