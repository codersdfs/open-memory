import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { buildServer } from "../src/api/server.js";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";

describe("api", () => {
  let base = "";
  let close = () => {};

  beforeAll(async () => {
    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
    const { app } = await buildServer({ service: svc });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => app.close(() => r()));
  });
  afterAll(async () => { await close(); });

  const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("POST /memories and POST /memories/search", async () => {
    const createRes = await post("/memories", { namespace: "test:1", type: "semantic", text: "user lives in Berlin", importance: 0.9 });
    expect(createRes.status).toBe(201);
    expect((await createRes.json() as { text: string }).text).toContain("Berlin");

    const list = await (await fetch(`${base}/memories?namespace=test:1`)).json() as { total: number };
    expect(list.total).toBe(1);

    const search = await (await post("/memories/search", { query: "where does user live?", namespace: "test:1", threshold: 0.1 })).json() as { memories: unknown[]; tokensUsed: number; truncated: boolean };
    expect(search.memories.length).toBeGreaterThan(0);
    expect(search.tokensUsed).toBeGreaterThan(0);
    expect(search).toHaveProperty("truncated");
  });

  // The CLI's daemon path searches with GET. The `/memories/:id` pattern also
  // matches "/memories/search", so when it was declared first every daemon-backed
  // search answered "fetch the memory whose id is search" and 404ed — while
  // POST search and the daemon-less CLI kept working, which is why the suite
  // stayed green.
  it("GET /memories/search returns results, not 'no memory with id search'", async () => {
    await post("/memories", { namespace: "test:get", type: "semantic", text: "the daemon path uses a GET", importance: 0.8 });

    const res = await fetch(`${base}/memories/search?query=daemon%20path&namespace=test:get&threshold=0`);
    expect(res.status).toBe(200);
    const body = await res.json() as { memories: { text: string }[] };
    expect(body.memories.length).toBeGreaterThan(0);
    expect(body.memories[0].text).toContain("daemon path");
  });

  it("GET /memories/search explains when asked, and not otherwise", async () => {
    const plain = await (await fetch(`${base}/memories/search?query=daemon&namespace=test:get&threshold=0`)).json() as { memories: Record<string, unknown>[] };
    expect(plain.memories[0]).not.toHaveProperty("explain");

    const asked = await (await fetch(`${base}/memories/search?query=daemon&namespace=test:get&threshold=0&explain=1`)).json() as { memories: { explain?: { final: number; weighted: Record<string, number> } }[] };
    expect(asked.memories[0].explain).toBeDefined();
  });

  it("rejects a memory with a bad type at the trust boundary", async () => {
    const res = await post("/memories", { namespace: "test:1", type: "nonsense", text: "hi" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/type/);
  });

  it("hard budget via API", async () => {
    for (let i = 0; i < 5; i++) {
      await post("/memories", { namespace: "budget:1", type: "semantic", text: `budget fact ${i} ${"word ".repeat(30)}` });
    }
    const j = await (await post("/memories/search", { query: "budget fact", namespace: "budget:1", k: 10, budgetTokens: 20, threshold: 0.1 })).json() as { truncated: boolean; summary: string | null };
    expect(j.truncated).toBe(true);
    expect(j.summary).toBeTruthy();
  });

  it("serves the UI from the same origin", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });
});
