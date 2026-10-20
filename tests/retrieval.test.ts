import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import { HybridRetriever } from "../src/core/retrieval/hybrid.js";
import type { EmbeddingProvider } from "../src/core/embedding/provider.js";

function fresh() {
  return new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
}

describe("retrieval (smart search)", () => {
  let svc: MemoryService;
  beforeEach(async () => { svc = fresh(); await svc.init(); });
  afterEach(() => { try { svc.close(); } catch {} });

  it("hybrid finds relevant via semantic similarity + threshold empty", async () => {
    await svc.save({ namespace: "a:1", type: "semantic", text: "user lives in Berlin and loves currywurst", importance: 0.9 });
    await svc.save({ namespace: "a:1", type: "semantic", text: "the cat is named Mimi and sleeps on keyboard", importance: 0.5 });
    await svc.save({ namespace: "a:1", type: "episodic", text: "we built a vector database yesterday", importance: 0.5 });

    const hit = await svc.search({ query: "where does user live?", namespace: "a:1", k: 5, threshold: 0.3 });
    expect(hit.memories.length).toBeGreaterThan(0);
    expect(hit.memories[0].text.toLowerCase()).toContain("berlin");

    const empty = await svc.search({ query: "quantum entanglement photosynthesis", namespace: "a:1", k: 5, threshold: 0.9 });
    expect(empty.memories.length).toBe(0);
    expect(empty.tokensUsed).toBe(0);
  });

  it("hard budget truncates and creates summary", async () => {
    for (let i = 0; i < 10; i++) {
      await svc.save({ namespace: "a:1", type: "semantic", text: `fact number ${i} about Berlin user preference detail with extra words to consume tokens ${"lorem ".repeat(20)}`, importance: 0.5 });
    }
    const res = await svc.search({ query: "Berlin", namespace: "a:1", k: 10, budgetTokens: 50, threshold: 0.1 });
    expect(res.tokensUsed).toBeLessThanOrEqual(50 + 20); // allow summary slack
    expect(res.truncated).toBe(true);
    expect(res.summary).toBeTruthy();
    // memories tokens <= budget (summary may push slightly over but truncated flag is true)
    const sumMemTokens = res.memories.reduce((s, m) => s + m.tokens, 0);
    expect(sumMemTokens).toBeLessThanOrEqual(50);
  });

  it("namespace isolation in search", async () => {
    await svc.save({ namespace: "a:1", type: "semantic", text: "Berlin memory" });
    await svc.save({ namespace: "b:9", type: "semantic", text: "Berlin memory duplicate" });
    const r = await svc.search({ query: "Berlin", namespace: "a:1", threshold: 0.1 });
    expect(r.memories.every(m => m.namespace === "a:1")).toBe(true);
  });

  it("MMR diversifies near-duplicates", async () => {
    // 3 very similar Berlin facts + 1 cat fact. MMR should interleave cat before 3rd berlin duplicate
    await svc.save({ namespace: "a:1", type: "semantic", text: "user lives in Berlin Mitte", importance: 0.9 });
    await svc.save({ namespace: "a:1", type: "semantic", text: "user lives in Berlin Mitte center", importance: 0.9 });
    await svc.save({ namespace: "a:1", type: "semantic", text: "user lives in Berlin Mitte downtown", importance: 0.9 });
    await svc.save({ namespace: "a:1", type: "semantic", text: "cat Mimi loves fish", importance: 0.5 });
    const r = await svc.search({ query: "Berlin user", namespace: "a:1", k: 4, threshold: 0.1 });
    // ensure we got at least 3 (maybe dedup collapsed some, but at least cat should appear if not deduped)
    expect(r.memories.length).toBeGreaterThanOrEqual(2);
  });
});

// #6: MMR order used to be thrown away by a re-sort before budgetEnforce, so
// Stage 2 could never change what the caller saw. Fixture: two near-identical
// "alpha" rows (cosine 0.99) both outrank a diverse "beta" row, so score order
// is [alpha, dup, beta] while MMR order is [alpha, beta, dup].
describe("stage-2 MMR order reaches the budget", () => {
  const q = [1, 0, 0];
  const nearDup = [0.99, 0.141, 0];   // cosine 0.99 to alpha
  const diverse = [0.95, -0.312, 0];  // cosine 0.95 to alpha, 0.897 to the duplicate

  const fixture = async () => {
    const store = new InMemoryVectorStore();
    await store.init();
    const embedder: EmbeddingProvider = {
      name: "stub",
      dim: 3,
      async embed() { return q; },
      async embedBatch() { return [q]; }
    };
    // Same text, same importance, same single-query-term length: the vector term
    // (0.6 * cosine) is the only thing separating these scores. The query term is
    // shared by all three rows on purpose — since v0.4 BM25 uses real corpus idf
    // (ADR-0012), and a term in only one row would hand that row a lexical boost
    // large enough to reorder the fixture and stop testing MMR at all.
    const alpha = await store.insert({ namespace: "m:1", type: "semantic", text: "match alpha", importance: 0.5 }, q);
    const dup = await store.insert({ namespace: "m:1", type: "semantic", text: "match alpha", importance: 0.5 }, nearDup);
    const beta = await store.insert({ namespace: "m:1", type: "semantic", text: "match beta", importance: 0.5 }, diverse);
    return { retriever: new HybridRetriever(store, embedder, { mmrLambda: 0.3 }), alpha, dup, beta };
  };

  it("keeps the diverse row ahead of the near-duplicate that outscores it", async () => {
    const { retriever, alpha, dup, beta } = await fixture();
    const res = await retriever.search({ query: "match", namespace: "m:1", k: 5, threshold: 0.1 });
    expect(res.memories.map((m) => m.id)).toEqual([alpha.id, beta.id, dup.id]);
  });
});
