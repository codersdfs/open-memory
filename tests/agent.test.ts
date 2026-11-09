import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { buildServer } from "../src/api/server.js";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";

/**
 * ADR-0043 — the console agent's HTTP surface.
 *
 * The LLM is never real in tests: `agentEnv` injects the seam, and OPENAI_BASE_URL
 * points the loop at a local mock completions server that always answers
 * `memory_remember` on the first turn of a conversation and reads the tool result on
 * the second. That exercises the whole path the console depends on — tool dispatch,
 * the write gate, the verdict relay, convergence — without a network.
 */

function mockCompletions(): { server: HttpServer; url: () => string } {
  const server = createHttpServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const body = JSON.parse(raw) as {
        messages: { role: string; content: string; tool_call_id?: string }[];
      };
      const last = body.messages[body.messages.length - 1];
      const toolResult = body.messages.find((m) => m.role === "tool");
      let message: Record<string, unknown>;
      if (last.role === "tool") {
        const stored = last.content.includes('"stored":true');
        message = { role: "assistant", content: stored ? "ack: stored" : "ack: gate refused it" };
      } else {
        const userText = body.messages.filter((m) => m.role === "user").map((m) => m.content).join(" ");
        // "I never said the deploy needs docker" is a known-reject conversational fixture
        // (tests/curation.test.ts:33) — the gate must refuse it whatever the model asked for.
        const target = userText.includes("docker") ? "I never said the deploy needs docker" : "测试不绿不合并";
        message = {
          role: "assistant",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "memory_remember", arguments: JSON.stringify({ text: target, type: "semantic" }) },
          }],
        };
      }
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  return {
    server,
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
  };
}

describe("agent routes (ADR-0043)", () => {
  let base = "";
  let close = () => {};
  let mock: { server: HttpServer; url: () => string };

  beforeAll(async () => {
    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
    const { app } = await buildServer({ service: svc, agentEnv: {} });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => app.close(() => r()));
    mock = mockCompletions();
    await new Promise<void>((r) => mock.server.listen(0, "127.0.0.1", r));
  });
  afterAll(async () => {
    await close();
    await new Promise<void>((r) => mock.server.close(() => r()));
  });

  const post = (p: string, body: unknown) =>
    fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("status without a key says llm:false and names no model", async () => {
    const res = await fetch(`${base}/agent/status`);
    const body = (await res.json()) as { llm: boolean; model: string | null };
    expect(body.llm).toBe(false);
    expect(body.model).toBeNull();
  });

  it("chat without a key answers 501 no-model, not a fake reply", async () => {
    const res = await post("/agent/chat", { messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no-model");
  });

  it("chat refuses a body with no messages", async () => {
    const res = await post("/agent/chat", {});
    expect(res.status).toBe(400);
  });

  it("the tool loop stores what the model remembered, and the trace shows it", async () => {
    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
    const { app } = await buildServer({
      service: svc,
      agentEnv: { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: mock.url() },
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const b2 = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${b2}/agent/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "记住:测试不绿不合并" }], namespace: "agent:test" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { reply: string; trace: { tool: string; summary: string }[]; model: string };
      expect(body.reply).toBe("ack: stored");
      expect(body.trace).toHaveLength(1);
      expect(body.trace[0].tool).toBe("memory_remember");
      expect(body.trace[0].summary).toContain("new row");

      const list = (await (await fetch(`${b2}/memories?namespace=agent:test`)).json()) as { total: number; memories: { text: string; source: string }[] };
      expect(list.total).toBe(1);
      expect(list.memories[0].text).toContain("不绿");
      expect(list.memories[0].source).toBe("agent-chat");
    } finally {
      await new Promise<void>((r) => app.close(() => r()));
    }
  });

  it("a curation refusal (conversational) comes back as a verdict the model can relay", async () => {
    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
    const { app } = await buildServer({
      service: svc,
      agentEnv: { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: mock.url() },
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const b2 = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${b2}/agent/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "记住这句 docker 相关的话" }], namespace: "agent:test" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { reply: string; trace: { summary: string }[] };
      expect(body.reply).toBe("ack: gate refused it");
      expect(body.trace[0].summary).toContain("rejected by write gate");

      const list = (await (await fetch(`${b2}/memories?namespace=agent:test`)).json()) as { total: number };
      expect(list.total).toBe(0);
    } finally {
      await new Promise<void>((r) => app.close(() => r()));
    }
  });
});
