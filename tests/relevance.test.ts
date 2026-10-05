/**
 * The acceptance check for zeroing the vector weight: an unrelated query must
 * not retrieve. Before the change, HashEmbeddingProvider gave any two memories
 * ~0.9 cosine, so "kubernetes ingress controller" scored 0.73 against
 * "user lives in Berlin" — above any usable threshold.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { HybridRetriever } from "../src/core/retrieval/hybrid.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";

const NS = "test:1";
let store: InMemoryVectorStore;
let retriever: HybridRetriever;

describe("relevance under hash embeddings", () => {
  beforeEach(() => {
    store = new InMemoryVectorStore();
    retriever = new HybridRetriever(store, new HashEmbeddingProvider());
  });

  const put = async (text: string, importance = 0.6) => {
    await store.init();
    const { MemoryService } = await import("../src/core/memoryService.js");
    const svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
    return svc.save({ namespace: NS, type: "semantic", text, importance });
  };

  it("does not retrieve for an unrelated query", async () => {
    await put("user lives in Berlin and prefers answers in German", 0.6);
    await put("frank 跟 agent 说话用中文, 他自己输入用英文", 0.6);
    // Threshold well below what recency+importance alone used to hand out (0.34):
    // relevance must gate on its own, not on the floor.
    for (const threshold of [0.05, 0.2, 0.35]) {
      const r = await retriever.search({ query: "kubernetes ingress controller", namespace: NS, threshold });
      expect(r.memories, `unrelated query must not clear ${threshold}`).toHaveLength(0);
    }
  });

  it("still retrieves on an exact word match", async () => {
    await put("user lives in Berlin and prefers answers in German", 0.6);
    const r = await retriever.search({ query: "Berlin", namespace: NS, threshold: 0.35 });
    expect(r.memories).toHaveLength(1);
  });

  it("retrieves a Chinese memory from a Chinese query", async () => {
    await put("frank 跟 agent 说话用中文, 他自己输入用英文", 0.7);
    const r = await retriever.search({ query: "中文", namespace: NS, threshold: 0.35 });
    expect(r.memories).toHaveLength(1);
  });

  it("excludes a zero-overlap memory entirely, not merely ranks it lower", async () => {
    const noise = await put("kubernetes ingress controller settings", 0.6);
    const hit = await put("user lives in Berlin", 0.6);
    const r = await retriever.search({ query: "Berlin", namespace: NS, threshold: 0, k: 10 });
    const ids = r.memories.map((m) => m.id);
    expect(ids).toContain(hit.id);
    expect(ids, "no lexical overlap and no vector signal means not a candidate at all").not.toContain(noise.id);
  });
});