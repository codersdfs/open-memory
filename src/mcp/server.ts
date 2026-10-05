import { createInterface } from "node:readline";
import { MemoryService } from "../core/memoryService.js";
import { MemoryClient } from "../cli/http.js";
import { resolveAgent, type MemoryScope } from "../core/scope.js";
import { callTool, MEMORY_TOOLS, type ToolContext } from "./tools.js";

/**
 * MCP over stdio for the memory store (ADR-0007).
 *
 * Deliberately dependency-free and frameless-agnostic: every client we target
 * (Claude Code, Codex, pi, the DSH connector) speaks newline-delimited JSON-RPC on
 * stdio. One rule dominates this file — **stdout is the protocol channel**. Any
 * stray `console.log` corrupts the session, so all diagnostics go to stderr and a
 * test asserts stdout purity.
 */

const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1]!;
const SERVER_NAME = "ai-memory";
const SERVER_VERSION = "0.3.0";

const INSTRUCTIONS = [
  "ai-memory gives you a durable store shared with other coding agents.",
  "Call memory_search before guessing about past decisions, project conventions, or user preferences.",
  "Call memory_remember after learning something durable. Use scope=shared for facts any agent would need;",
  "scope=private for notes specific to this agent. Never store secrets or credentials.",
  "Extra CLI available in a shell: ai-memory search \"...\" / ai-memory save \"...\" --scope shared."
].join(" ");

export interface McpOptions {
  db?: string;
  agent?: string;
  scope?: MemoryScope;
  /** When set (or when the daemon is healthy and `noDaemon` is not set), proxy instead of opening SQLite. */
  server?: string;
  noDaemon?: boolean;
  /** For tests: inject a ready service. */
  service?: MemoryService;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpServerHandle {
  /** Feed one line; resolves to the response line, or null for notifications. */
  handleLine(line: string): Promise<string | null>;
  close(): Promise<void>;
}

export function log(...parts: unknown[]): void {
  process.stderr.write(`[ai-memory] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`);
}

function rpcResult(id: string | number | null, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

/** Build a server around an options bag. Exported for tests (no process I/O). */
export async function createMcpServer(opts: McpOptions): Promise<McpServerHandle> {
  const agent = resolveAgent(opts.agent);
  let service = opts.service ?? null;
  let viaDaemon = false;
  let client: MemoryClient | null = null;

  if (!service && !opts.noDaemon) {
    client = new MemoryClient(opts.server);
    viaDaemon = await client.healthy();
    if (!viaDaemon) client = null;
  }

  if (!service && !viaDaemon) {
    service = new MemoryService({ dbPath: opts.db });
    await service.init();
  }

  const ctx: ToolContext = {
    // When proxying, tool calls still need a service; the proxy path is handled
    // inside callToolViaDaemon below, so a local store is created lazily only if
    // the daemon disappears mid-session.
    service: service as MemoryService,
    defaultAgent: agent,
    defaultScope: opts.scope
  };

  const ensureLocalService = async (): Promise<void> => {
    if (!ctx.service && !service) {
      service = new MemoryService({ dbPath: opts.db });
      await service.init();
      ctx.service = service;
    }
  };

  const handle = async (raw: string): Promise<string | null> => {
    const line = raw.trim();
    if (!line) return null;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return rpcError(null, -32700, "parse error");
    }
    const id = msg.id ?? null;
    const isNotification = msg.id === undefined || msg.id === null;
    const method = msg.method ?? "";

    // Notifications never get a reply, even on error.
    if (isNotification) {
      if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
      if (method === "exit") return null;
      return null;
    }

    switch (method) {
      case "initialize": {
        const requested = String((msg.params?.protocolVersion as string | undefined) ?? "");
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS
        });
      }

      case "ping":
        return rpcResult(id, {});

      case "tools/list":
        return rpcResult(id, { tools: MEMORY_TOOLS });

      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const args = (msg.params?.arguments as Record<string, unknown> | undefined) ?? {};
        if (!MEMORY_TOOLS.some((t) => t.name === name)) {
          return rpcError(id, -32602, `unknown tool: ${name}`);
        }
        let result;
        if (viaDaemon && client) {
          result = await callViaDaemon(client, agent, opts.scope, name, args);
        } else {
          await ensureLocalService();
          result = await callTool(ctx, name, args);
        }
        return rpcResult(id, {
          content: [{ type: "text", text: result.text }],
          structuredContent: result.structured,
          isError: result.isError === true
        });
      }

      case "resources/list":
        return rpcResult(id, { resources: [] });
      case "prompts/list":
        return rpcResult(id, { prompts: [] });

      case "shutdown":
        return rpcResult(id, null);

      default:
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  };

  return {
    handleLine: handle,
    async close() {
      if (service) await service.close();
      ctx.service = service as MemoryService;
    }
  };
}

/**
 * Daemon path: the HTTP API is the canonical writer, so MCP tool calls become HTTP
 * calls when the daemon is up. Kept separate so the local path stays testable.
 */
async function callViaDaemon(
  client: MemoryClient,
  agent: string,
  defaultScope: MemoryScope | undefined,
  name: string,
  args: Record<string, unknown>
): Promise<{ text: string; structured: unknown; isError?: boolean }> {
  const scope = args.scope === "shared" || args.scope === "private" ? (args.scope as MemoryScope) : defaultScope;
  switch (name) {
    case "memory_search": {
      const query = String(args.query ?? "").trim();
      if (!query) return { text: "memory_search: query is required", structured: null, isError: true };
      const res = await client.get<{ memories: { id: string; type: string; namespace: string; text: string; score?: number }[]; tokensUsed: number; truncated: boolean }>(
        "/memories/search" +
          MemoryClient.query({
            query,
            agent,
            scope,
            k: args.k === undefined ? 5 : Number(args.k),
            budgetTokens: args.budgetTokens === undefined ? 800 : Number(args.budgetTokens),
            threshold: args.threshold === undefined ? 0.35 : Number(args.threshold),
            type: args.type === undefined ? undefined : String(args.type)
          })
      );
      if (!res.ok) return { text: `memory_search failed: ${res.error}`, structured: null, isError: true };
      const text =
        res.data.memories.length === 0
          ? "no memories matched"
          : res.data.memories
              .map((m) => `[${m.id}] (${m.type}/${m.namespace}, ${(m.score ?? 0).toFixed(3)}) ${m.text.replace(/\s+/g, " ").trim()}`)
              .join("\n") + `\ntokens: ${res.data.tokensUsed}`;
      return { text, structured: res.data };
    }
    case "memory_remember": {
      const text = String(args.text ?? "").trim();
      if (!text) return { text: "memory_remember: text is required", structured: null, isError: true };
      const res = await client.post<{ memory: { id: string; namespace: string } }>("/memories", {
        text,
        type: args.type ?? "semantic",
        agent,
        scope,
        importance: args.importance,
        tags: args.tags,
        source: args.source ?? `mcp:${agent}`
      });
      if (!res.ok) return { text: `memory_remember failed: ${res.error}`, structured: null, isError: true };
      return { text: `stored: ${res.data.memory.id} → ${res.data.memory.namespace}`, structured: res.data.memory };
    }
    case "memory_list": {
      const res = await client.get<{ memories: { id: string; type: string; namespace: string; text: string }[]; total: number }>(
        "/memories" + MemoryClient.query({ agent, scope, limit: args.limit === undefined ? 20 : Number(args.limit), type: args.type === undefined ? undefined : String(args.type) })
      );
      if (!res.ok) return { text: `memory_list failed: ${res.error}`, structured: null, isError: true };
      const text =
        res.data.memories.length === 0
          ? "no memories"
          : res.data.memories.map((m) => `[${m.id}] (${m.type}/${m.namespace}) ${m.text.replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
      return { text, structured: res.data };
    }
    case "memory_get":
    case "memory_forget": {
      const id = String(args.id ?? "").trim();
      if (!id) return { text: `${name}: id is required`, structured: null, isError: true };
      if (name === "memory_forget") {
        const res = await client.del<unknown>(`/memories/${encodeURIComponent(id)}`);
        if (!res.ok) return { text: `memory_forget failed: ${res.error}`, structured: null, isError: true };
        return { text: `forgot ${id}`, structured: { id, deleted: true } };
      }
      const res = await client.get<{ memory: { id: string; type: string; namespace: string; text: string } | null }>(
        `/memories/${encodeURIComponent(id)}`
      );
      if (!res.ok || !res.data.memory) return { text: `no memory ${id}`, structured: null, isError: true };
      return { text: `[${id}] ${res.data.memory.text}`, structured: res.data.memory };
    }
    case "memory_stats": {
      const res = await client.get<Record<string, unknown>>("/stats" + MemoryClient.query({ agent, scope, all: args.all === true }));
      if (!res.ok) return { text: `memory_stats failed: ${res.error}`, structured: null, isError: true };
      return { text: JSON.stringify(res.data), structured: res.data };
    }
    default:
      return { text: `unknown tool: ${name}`, structured: null, isError: true };
  }
}

/** stdio transport: read lines from stdin, write response lines to stdout. */
export async function runMcpServer(opts: McpOptions = {}): Promise<void> {
  const server = await createMcpServer(opts);
  log(`ready (agent=${resolveAgent(opts.agent)}${opts.scope ? `, scope=${opts.scope}` : ""})`);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  let queue: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    // Serialize handlers so two tool calls cannot interleave responses.
    queue = queue.then(async () => {
      try {
        const out = await server.handleLine(line);
        if (out !== null) process.stdout.write(out + "\n");
      } catch (err) {
        log("handler error:", (err as Error).message);
      }
    });
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => resolve());
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });
  await queue;
  await server.close();
}
