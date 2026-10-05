import { describe, it, expect, beforeEach } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { callTool, MEMORY_TOOLS } from "../src/mcp/tools.js";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { resolveScopeKeys } from "../src/core/scope.js";

/**
 * Protocol-level tests for the MCP surface (ADR-0007).
 *
 * These go through `handleLine` rather than a live process so the assertions can be
 * synchronous and exact. The one thing they cannot cover — stdout purity against a
 * stray `console.log` somewhere in the dependency graph — is covered by an
 * end-to-end spawn test.
 */

const ENV_KEYS = ["AI_MEMORY_USER", "AI_MEMORY_AGENT", "MEMORY_USER", "MEMORY_AGENT", "DSH_HOME", "DSH_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_SANDBOX", "CODEX_HOME", "PI_HOME"];

let svc: MemoryService;

beforeEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AI_MEMORY_USER = "mcpuser";
  process.env.AI_MEMORY_AGENT = "claude";
  svc = new MemoryService({ store: new InMemoryVectorStore(), dedupThreshold: 0.99 });
  await svc.init();
});

async function call(line: unknown): Promise<Record<string, unknown>> {
  const server = await createMcpServer({ service: svc, agent: "claude" });
  const out = await server.handleLine(JSON.stringify(line));
  expect(out).not.toBeNull();
  return JSON.parse(out!) as Record<string, unknown>;
}

describe("MCP handshake", () => {
  it("answers initialize with tools capability and the requested protocol version", async () => {
    const res = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    const result = res.result as Record<string, unknown>;
    expect(res.jsonrpc).toBe("2.0");
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    const info = result.serverInfo as Record<string, string>;
    expect(info.name).toBe("ai-memory");
    expect(String(result.instructions)).toMatch(/memory_search/);
  });

  it("falls back to the newest supported version for an unknown one", async () => {
    const res = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect((res.result as Record<string, unknown>).protocolVersion).toBe("2025-06-18");
  });

  it("stays silent on notifications", async () => {
    const server = await createMcpServer({ service: svc, agent: "claude" });
    expect(await server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
  });

  it("reports a parse error with a null id instead of throwing", async () => {
    const server = await createMcpServer({ service: svc, agent: "claude" });
    const res = JSON.parse((await server.handleLine("{not json"))!) as Record<string, unknown>;
    expect((res.error as Record<string, unknown>).code).toBe(-32700);
    expect(res.id).toBeNull();
  });

  it("rejects unknown methods with -32601", async () => {
    const res = await call({ jsonrpc: "2.0", id: 7, method: "tools/explode" });
    expect((res.error as Record<string, unknown>).code).toBe(-32601);
  });

  it("answers ping", async () => {
    const res = await call({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect(res.result).toEqual({});
  });
});

describe("MCP tool listing", () => {
  it("advertises every memory tool with a JSON schema", async () => {
    const res = await call({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    const tools = (res.result as { tools: typeof MEMORY_TOOLS }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["memory_forget", "memory_get", "memory_list", "memory_remember", "memory_search", "memory_stats"].sort()
    );
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
      // `memory_get` / `memory_forget` take only an id (a get is not layer-specific);
      // every other tool must expose the private/shared decision to the model.
      if (t.name !== "memory_get" && t.name !== "memory_forget") {
        expect(t.inputSchema.properties).toHaveProperty("scope");
      }
    }
  });
});

describe("MCP tools/call", () => {
  it("remembers into the private layer by default and finds it again", async () => {
    const remember = await call({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "memory_remember", arguments: { text: "The staging database password rotates on the first Monday." } }
    });
    const structured = (remember.result as Record<string, unknown>).structuredContent as { id: string; namespace: string };
    expect((remember.result as { isError?: boolean }).isError ?? false).toBe(false);
    expect(structured.namespace).toBe("claude:mcpuser");

    const search = await call({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "memory_search", arguments: { query: "staging database password rotate" } }
    });
    const result = (search.result as Record<string, unknown>).structuredContent as { memories: { id: string }[]; scopes: string[] };
    expect(result.memories.map((m) => m.id)).toContain(structured.id);
    expect(result.scopes).toEqual(resolveScopeKeys({ agent: "claude", user: "mcpuser" }));
  });

  it("honours scope=shared for writes", async () => {
    const res = await call({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "memory_remember", arguments: { text: "Shared convention: run pnpm, never npm.", scope: "shared" } }
    });
    expect(((res.result as Record<string, unknown>).structuredContent as { namespace: string }).namespace).toBe("shared:mcpuser");
  });

  it("never returns embeddings to the model", async () => {
    await svc.save({ namespace: "claude:mcpuser", type: "semantic", text: "A fact about embeddings leaking." });
    const res = await call({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "memory_search", arguments: { query: "embeddings leaking" } }
    });
    const result = (res.result as Record<string, unknown>).structuredContent as { memories: Record<string, unknown>[] };
    expect(result.memories.length).toBeGreaterThan(0);
    for (const m of result.memories) expect(m).not.toHaveProperty("embedding");
  });

  it("returns an isError result (not a protocol error) for a bad call", async () => {
    const res = await call({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "memory_search", arguments: {} } });
    expect((res.result as { isError?: boolean }).isError).toBe(true);
    expect(String(((res.result as Record<string, unknown>).content as { text: string }[])[0]!.text)).toMatch(/query is required/);
  });

  it("rejects an unknown tool name at the protocol level", async () => {
    const res = await call({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "memory_delete_everything", arguments: {} } });
    expect((res.error as Record<string, unknown>).code).toBe(-32602);
  });

  it("forgets (soft) and then cannot get", async () => {
    const saved = await svc.save({ namespace: "claude:mcpuser", type: "semantic", text: "Temporary fact to forget." });
    const forget = await call({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "memory_forget", arguments: { id: saved.id } } });
    expect((forget.result as { isError?: boolean }).isError ?? false).toBe(false);
    const get = await call({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "memory_get", arguments: { id: saved.id } } });
    expect((get.result as { isError?: boolean }).isError).toBe(true);
  });

  it("stats counts both layers of the fan-out", async () => {
    await svc.save({ namespace: "claude:mcpuser", type: "semantic", text: "Private note for stats." });
    await svc.save({ namespace: "shared:mcpuser", type: "procedural", text: "Shared note for stats." });
    const res = await call({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "memory_stats", arguments: {} } });
    const stats = (res.result as Record<string, unknown>).structuredContent as { perScope: Record<string, { total: number }> };
    expect(stats.perScope["claude:mcpuser"]!.total).toBe(1);
    expect(stats.perScope["shared:mcpuser"]!.total).toBe(1);
  });
});

describe("callTool dispatch", () => {
  it("fails closed for an unknown tool", async () => {
    const res: any = await callTool({ service: svc, defaultAgent: "claude" }, "nope", {});
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/unknown tool/);
  });

  it("uses the server default scope when the call omits one", async () => {
    const res: any = await callTool({ service: svc, defaultAgent: "codex", defaultScope: "shared" }, "memory_remember", {
      text: "Codex writes shared by default here."
    });
    expect((res.structured as { namespace: string }).namespace).toBe("shared:mcpuser");
  });
});
