import { describe, it, expect } from "vitest";
import { reembedAll } from "../src/core/embedding/reembed.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { MemoryService } from "../src/core/memoryService.js";
import type { EmbeddingProvider } from "../src/core/embedding/provider.js";

/** A provider of a different width, so a re-embed has something to prove. */
class StubProvider implements EmbeddingProvider {
  readonly name = "stub";
  constructor(readonly dim: number, private readonly boomOn = "") {}
  async embed(text: string): Promise<number[]> {
    if (this.boomOn && text.includes(this.boomOn)) throw new Error("provider exploded");
    const seed = [...text].reduce((s, c) => s + c.charCodeAt(0), 0);
    return Array.from({ length: this.dim }, (_, i) => ((seed + i) % 17) + 1);
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

async function seeded() {
  const store = new InMemoryVectorStore();
  const svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
  await svc.init();
  await svc.save({ namespace: "a:1", type: "semantic", text: "user is a TypeScript engineer", importance: 0.6 });
  await svc.save({ namespace: "b:1", type: "semantic", text: "the cat is named Mimi", importance: 0.6 });
  const forgotten = await svc.save({ namespace: "a:1", type: "semantic", text: "forgotten fact about the moon", importance: 0.6 });
  const archived = await svc.save({ namespace: "a:1", type: "semantic", text: "an archived note about kelp", importance: 0.6 });
  await svc.store.deleteSoft(forgotten.id);
  await svc.store.updateMeta(archived.id, { status: "archived" });
  return { store, forgotten, archived };
}

describe("reembed", () => {
  it("rewrites every vector, including archived and forgotten rows", async () => {
    const { store } = await seeded();
    expect(await store.storedDim()).toBe(384);

    const res = await reembedAll(store, new StubProvider(16));

    expect(res.scanned).toBe(4);
    expect(res.rewritten).toBe(4);
    expect(res.failed).toEqual([]);
    expect(res.partitions).toBe(2);
    // The width the guard reads is now the new provider's, so a swap is complete.
    expect(await store.storedDim()).toBe(16);
  });

  it("leaves a store the dimension guard accepts again", async () => {
    const { store } = await seeded();
    const stub = new StubProvider(16);
    await reembedAll(store, stub);
    // Before the re-embed this constructor's init() throws: 384 stored vs 16 wanted.
    const svc = new MemoryService({ store, embedder: stub });
    await expect(svc.init()).resolves.toBeUndefined();
    await expect(svc.search({ query: "TypeScript engineer", namespace: "a:1" })).resolves.toBeTruthy();
  });

  it("reports a failing row and migrates the rest", async () => {
    const { store } = await seeded();
    const res = await reembedAll(store, new StubProvider(8, "Mimi"));
    expect(res.failed).toHaveLength(1);
    expect(res.rewritten).toBe(3);
    expect(await store.storedDim()).toBe(8);
  });

  it("a dry run writes nothing", async () => {
    const { store } = await seeded();
    const res = await reembedAll(store, new StubProvider(16), { dryRun: true });
    expect(res.scanned).toBe(4);
    expect(res.rewritten).toBe(0);
    expect(await store.storedDim()).toBe(384);
  });

  it("a row stuck at the old width is skipped, not fatal", async () => {
    const { store } = await seeded();
    await reembedAll(store, new StubProvider(16));
    // Exactly what an interrupted migration leaves behind.
    await store.insert(
      { namespace: "a:1", type: "semantic", text: "stale width row", importance: 0.5 },
      new Array(384).fill(0.1)
    );

    const hits = await store.vectorSearch({
      namespace: "a:1",
      queryEmbedding: new Array(16).fill(1),
      limit: 10,
      includeDeleted: true
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.memory.text !== "stale width row")).toBe(true);
  });
});
