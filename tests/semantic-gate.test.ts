import { describe, it, expect, afterEach } from "vitest";
import { HybridRetriever } from "../src/core/retrieval/hybrid.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import type { EmbeddingProvider } from "../src/core/embedding/provider.js";

/**
 * The gate that lets a memory in on vector evidence alone.
 *
 * Every row gets a vector chosen here, so the cosines are the experiment rather than a
 * side effect of some provider. The stub's name matters: a provider called `hash` gets
 * vector weight 0, and this path has to stay off for it.
 */
class FixedEmbedder implements EmbeddingProvider {
  readonly name = "stub-embedder";
  constructor(readonly dim: number, private readonly queryVec: number[]) {}
  async embed(text: string): Promise<number[]> {
    return text === QUERY ? this.queryVec : new Array(this.dim).fill(0);
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

const QUERY = "which animal is this";
const NS = "gate:1";
const DIM = 3;

/** A unit vector whose cosine with a query of [1,0,0] is exactly `cos`. */
function at(cos: number): number[] {
  return [cos, Math.sqrt(Math.max(0, 1 - cos * cos)), 0];
}

async function storeWith(targetCos: number, noiseCos: number) {
  const store = new InMemoryVectorStore();
  await store.init();
  // No row shares a word with the query, so bm25 stays 0: the lexical gate cannot be
  // what returns the hit, which is the only way this test says anything.
  await store.insert(
    { namespace: NS, type: "semantic", text: "the creature's moniker", importance: 0.6 },
    at(targetCos)
  );
  for (let i = 0; i < 5; i++) {
    await store.insert({ namespace: NS, type: "semantic", text: `filler row ${i}`, importance: 0.6 }, at(noiseCos));
  }
  return store;
}

const retrieverFor = (store: InMemoryVectorStore) => new HybridRetriever(store, new FixedEmbedder(DIM, at(1)));

const previous = process.env.MEMORY_SEMANTIC_MARGIN;
afterEach(() => {
  if (previous === undefined) delete process.env.MEMORY_SEMANTIC_MARGIN;
  else process.env.MEMORY_SEMANTIC_MARGIN = previous;
});

describe("semantic admission", () => {
  it("admits the top vector hit when it leads the partition by the margin", async () => {
    process.env.MEMORY_SEMANTIC_MARGIN = "0.2";
    const store = await storeWith(0.3, 0.05); // leads by 0.25
    const r = await retrieverFor(store).search({ query: QUERY, namespace: NS });
    expect(r.memories.map((m) => m.text)).toEqual(["the creature's moniker"]);
  });

  it("refuses to admit when the lead is only noise-sized", async () => {
    process.env.MEMORY_SEMANTIC_MARGIN = "0.2";
    const store = await storeWith(0.1, 0.05); // leads by 0.05 — the kubernetes case
    const r = await retrieverFor(store).search({ query: QUERY, namespace: NS });
    expect(r.memories).toHaveLength(0);
  });

  it("the margin is the knob: lowering it admits the same query", async () => {
    process.env.MEMORY_SEMANTIC_MARGIN = "0.01";
    const store = await storeWith(0.1, 0.05);
    const r = await retrieverFor(store).search({ query: QUERY, namespace: NS });
    expect(r.memories.map((m) => m.text)).toEqual(["the creature's moniker"]);
  });

  it("never fires for the hash embedder, which cannot lead anything", async () => {
    process.env.MEMORY_SEMANTIC_MARGIN = "0.01";
    const store = await storeWith(0.3, 0.05);
    const { HashEmbeddingProvider } = await import("../src/core/embedding/hash.js");
    const r = await new HybridRetriever(store, new HashEmbeddingProvider()).search({
      query: QUERY,
      namespace: NS
    });
    expect(r.memories).toHaveLength(0);
  });

  it("still refuses an unrelated query even at a tiny threshold", async () => {
    process.env.MEMORY_SEMANTIC_MARGIN = "0.2";
    const store = await storeWith(0.1, 0.05);
    const r = await retrieverFor(store).search({
      query: "kubernetes ingress controller",
      namespace: NS,
      threshold: 0.05
    });
    expect(r.memories).toHaveLength(0);
  });
});
