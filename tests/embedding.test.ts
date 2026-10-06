import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createEmbeddingProvider } from "../src/core/embedding/index.js";
import { ApiEmbeddingProvider } from "../src/core/embedding/openai.js";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import type { EmbeddingProvider } from "../src/core/embedding/provider.js";

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;

describe("embedding provider selection", () => {
  it("defaults to the offline hash provider", () => {
    const p = createEmbeddingProvider(env({}));
    expect(p.name).toBe("hash");
    expect(p.dim).toBe(384);
  });

  // The bug this whole file exists for: `EMBEDDING_PROVIDER=openai` was documented
  // in .env.example and read by nobody, so every install ran hash silently.
  it("refuses openai without a key instead of silently falling back to hash", () => {
    expect(() => createEmbeddingProvider(env({ EMBEDDING_PROVIDER: "openai" }))).toThrow(/OPENAI_API_KEY/);
  });

  it("refuses an unknown provider by name", () => {
    expect(() => createEmbeddingProvider(env({ EMBEDDING_PROVIDER: "onnx" }))).toThrow(/unknown EMBEDDING_PROVIDER "onnx"/);
  });

  it("reads the documented NIM variables", () => {
    const p = createEmbeddingProvider(env({ EMBEDDING_PROVIDER: "nim", NVIDIA_API_KEY: "nvapi-x" }));
    expect(p.name).toBe("nim");
    expect(p.dim).toBe(2048); // nemotron-3-embed-1b
  });

  it("accepts the nvidia aliases and a NIM_DIM override", () => {
    const p = createEmbeddingProvider(env({ EMBEDDING_PROVIDER: "nvidia-nim", NIM_API_KEY: "nvapi-x", NIM_DIM: "1024" }));
    expect(p.dim).toBe(1024);
  });

  it("rejects a non-numeric dim rather than coercing it", () => {
    expect(() => createEmbeddingProvider(env({ EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "sk-x", EMBEDDING_DIM: "big" })))
      .toThrow(/positive integer/);
  });
});

/** Stub /embeddings endpoint that records what it was sent. */
async function stubApi(reply: (n: number) => unknown): Promise<{ url: string; bodies: Record<string, unknown>[]; close: () => Promise<void> }> {
  const bodies: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw || "{}") as Record<string, unknown>);
      const count = (JSON.parse(raw || "{}").input as string[]).length;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply(count)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bodies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const vectors = (count: number, dim: number) => ({ data: Array.from({ length: count }, () => ({ embedding: new Array(dim).fill(0.01) })) });

describe("ApiEmbeddingProvider", () => {
  it("sends OpenAI's body, and NIM's extra fields only for NIM", async () => {
    const api = await stubApi((n) => vectors(n, 1536));
    try {
      const openai = new ApiEmbeddingProvider({ name: "openai", baseUrl: api.url, apiKey: "sk-x", model: "text-embedding-3-small", dim: 1536, inputType: false });
      await openai.embed("hello", { inputType: "query" });
      expect(api.bodies[0]).toEqual({ model: "text-embedding-3-small", input: ["hello"] });

      const nim = new ApiEmbeddingProvider({ name: "nim", baseUrl: api.url, apiKey: "nvapi-x", model: "m", dim: 1536, inputType: true, extraBody: { truncate: "NONE" } });
      await nim.embed("hello", { inputType: "passage" });
      // input_type is what E5/Nemotron score on; truncate is NIM-only.
      expect(api.bodies[1]).toEqual({ model: "m", input: ["hello"], input_type: "passage", truncate: "NONE" });
    } finally { await api.close(); }
  });

  it("lets a fixed NIM_INPUT_TYPE override the per-call value", async () => {
    const api = await stubApi((n) => vectors(n, 8));
    try {
      const nim = new ApiEmbeddingProvider({ name: "nim", baseUrl: api.url, apiKey: "k", model: "m", dim: 8, inputType: false, extraBody: { input_type: "query" } });
      await nim.embed("x", { inputType: "passage" });
      expect(api.bodies[0].input_type).toBe("query");
    } finally { await api.close(); }
  });

  it("rejects a vector whose length disagrees with the configured dim", async () => {
    const api = await stubApi((n) => vectors(n, 7));
    try {
      const p = new ApiEmbeddingProvider({ name: "openai", baseUrl: api.url, apiKey: "k", model: "m", dim: 1536, inputType: false });
      await expect(p.embed("x")).rejects.toThrow(/7-dim vector but EMBEDDING_DIM is 1536/);
    } finally { await api.close(); }
  });

  it("surfaces the API's own error text", async () => {
    const server = createServer((_req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"bad key"}'); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const p = new ApiEmbeddingProvider({ name: "openai", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "k", model: "m", dim: 8, inputType: false });
      await expect(p.embed("x")).rejects.toThrow(/HTTP 401.*bad key/);
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  });
});

describe("dimension guard", () => {
  const embedderOf = (dim: number): EmbeddingProvider => ({
    name: "stub",
    dim,
    async embed() { return new Array(dim).fill(0); },
    async embedBatch() { return []; },
  });

  it("refuses to start when the store was written at another dim, naming both", async () => {
    const store = new InMemoryVectorStore();
    await store.init();
    await store.insert({ namespace: "t:1", type: "semantic", text: "written at 3 dims" }, [1, 2, 3]);
    const svc = new MemoryService({ store, embedder: embedderOf(384) });
    await expect(svc.init()).rejects.toThrow(/holds 3-dim vectors, but the stub embedder produces 384/);
  });

  it("starts on an empty store, whatever the provider", async () => {
    const store = new InMemoryVectorStore();
    await store.init();
    const svc = new MemoryService({ store, embedder: embedderOf(384) });
    await expect(svc.init()).resolves.toBeUndefined();
  });

  it("starts when the store matches the provider", async () => {
    const store = new InMemoryVectorStore();
    await store.init();
    await store.insert({ namespace: "t:1", type: "semantic", text: "written at 4 dims" }, [1, 2, 3, 4]);
    const svc = new MemoryService({ store, embedder: embedderOf(4) });
    await expect(svc.init()).resolves.toBeUndefined();
  });
});
