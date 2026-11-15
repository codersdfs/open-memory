import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createEmbeddingProvider, EMBEDDING_PRESETS, previewEmbedding } from "../src/core/embedding/index.js";
import { ApiEmbeddingProvider } from "../src/core/embedding/openai.js";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import type { EmbeddingProvider } from "../src/core/embedding/provider.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import { HybridRetriever } from "../src/core/retrieval/hybrid.js";

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

// P8 small half (ADR-0048): the local OpenAI-compatible preset. Same wire as
// `openai`, but the key is OPTIONAL (Ollama/LM Studio authenticate by being on
// localhost, and some builds reject a Bearer line outright) and nothing has a
// default — a local endpoint's address, model id and width are facts about the
// user's install, and the factory refuses to guess any of them.
describe("openai-local preset", () => {
  const full = {
    EMBEDDING_PROVIDER: "openai-local",
    OPENAI_BASE_URL: "http://localhost:11434/v1",
    OPENAI_EMBED_MODEL: "nomic-embed-text",
    EMBEDDING_DIM: "768"
  };

  it("resolves with NO key — the whole point of the preset", () => {
    const p = createEmbeddingProvider(env(full));
    expect(p.name).toBe("openai-local");
    expect(p.dim).toBe(768);
  });

  it("names every missing variable at once, with the example the user needs", () => {
    try {
      createEmbeddingProvider(env({ EMBEDDING_PROVIDER: "openai-local" }));
      throw new Error("should have thrown");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain("OPENAI_BASE_URL");
      expect(msg).toContain("OPENAI_EMBED_MODEL");
      expect(msg).toContain("EMBEDDING_DIM");
      expect(msg).toContain("OPENAI_API_KEY is optional");
    }
  });

  it("stays visible to the console's preview", () => {
    const ok = previewEmbedding(env(full));
    expect(ok).toEqual({ ok: true, provider: "openai-local", model: "nomic-embed-text", dim: 768 });
    const bad = previewEmbedding(env({ EMBEDDING_PROVIDER: "openai-local" }));
    expect(bad.ok).toBe(false);
  });

  it("exposes itself as a preset with no key requirement and no width of its own", () => {
    const row = EMBEDDING_PRESETS.find((p) => p.provider === "openai-local");
    expect(row).toEqual({ provider: "openai-local", keyEnv: null, model: null, dim: 0 });
  });

  it("sends no Authorization header when the key is empty, and Bearer when set", async () => {
    const headers: Record<string, Record<string, string | string[] | undefined>> = {};
    const server = createServer((req, res) => {
      headers[req.url ?? ""] = req.headers;
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ embedding: new Array(8).fill(0.01) }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const local = new ApiEmbeddingProvider({ name: "openai-local", baseUrl: base + "/a", apiKey: "", model: "m", dim: 8, inputType: false });
      await local.embed("hello");
      // The absent header is the feature: Ollama 401s a malformed `Bearer `.
      expect(headers["/a/embeddings"]!.authorization).toBeUndefined();

      const keyed = new ApiEmbeddingProvider({ name: "openai-local", baseUrl: base + "/b", apiKey: "sk-x", model: "m", dim: 8, inputType: false });
      await keyed.embed("hello");
      expect(headers["/b/embeddings"]!.authorization).toBe("Bearer sk-x");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("still requires the key for hosted openai — the empty key is openai-local's, not openai's", () => {
    expect(() => createEmbeddingProvider(env({ EMBEDDING_PROVIDER: "openai" }))).toThrow(/OPENAI_API_KEY/);
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

// The vector term must exist exactly when it carries signal. With hash it is noise
// (~0.9 cosine to everything) and stays out of the score; with a real provider, a
// configured embedder that contributed nothing would be a paid no-op.
describe("vector weight follows the embedder", () => {
  const vec = [1, 0, 0, 0];

  const retrieverOf = async (name: string) => {
    const store = new InMemoryVectorStore();
    await store.init();
    await store.insert({ namespace: "v:1", type: "semantic", text: "vector only match" }, vec);
    const embedder: EmbeddingProvider = {
      name,
      dim: 4,
      async embed() { return vec; },
      async embedBatch() { return [vec]; },
    };
    return new HybridRetriever(store, embedder);
  };

  const weightOf = async (name: string) => {
    const res = await (await retrieverOf(name)).search({ query: "nothing lexical", namespace: "v:1", threshold: 0, k: 1, explain: true });
    return res.memories[0].explain!.weighted.vector;
  };

  it("weights the vector term for a real provider", async () => {
    expect(await weightOf("openai")).toBeGreaterThan(0);
  });

  it("leaves it out for the hash default", async () => {
    expect(await weightOf("hash")).toBe(0);
  });

  it("still obeys an explicit MEMORY_VECTOR_WEIGHT", async () => {
    process.env.MEMORY_VECTOR_WEIGHT = "0.1";
    try {
      expect(await weightOf("openai")).toBeCloseTo(0.1, 6);
    } finally { delete process.env.MEMORY_VECTOR_WEIGHT; }
  });
});


// #8: the length/char signal loop indexed charCodeAt(i % text.length), and % 0 is
// NaN, so "" produced an all-NaN vector that JSON-serialized to nulls and scored 0.
describe("HashEmbeddingProvider", () => {
  it("embeds the empty string as a finite vector, not NaN", async () => {
    const v = await new HashEmbeddingProvider().embed("");
    expect(v).toHaveLength(384);
    expect(v.every(Number.isFinite)).toBe(true);
  });
});
