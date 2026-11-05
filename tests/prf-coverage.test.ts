/**
 * ADR-0028: idf-weighted coverage and the PRF second pass.
 *
 * The failure both fix is measured on the LoCoMo evidence audit: a query that
 * names an entity the whole store knows ("What is Caroline's identity?") scores
 * half the store at the same unweighted coverage as the row that answers it, and
 * a multi-hop answer whose second half shares none of the question's vocabulary
 * never enters the pool at all. These tests pin the two behaviours that change:
 * a rare-term holder outranks a ubiquitous-term holder, and a row reachable only
 * through the seeds' shared terms joins the result without ever outranking a row
 * that answered the question itself.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HybridRetriever } from "../src/core/retrieval/hybrid.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { SqliteVectorStore } from "../src/core/store/sqlite.js";
import { coverageWeighted } from "../src/core/retrieval/terms.js";
import { MemoryService } from "../src/core/memoryService.js";

const NS = "prf:1";

describe("coverageWeighted (ADR-0028)", () => {
  it("weights a term every row holds below a term two rows hold", () => {
    // "caroline" is the protagonist: every row holds it. "transgender" is the answer.
    const df = new Map([["caroline", 70], ["transgender", 2]]);
    const holder = coverageWeighted("Caroline: I am a transgender woman.", "caroline transgender", df);
    const filler = coverageWeighted("Caroline went to the market.", "caroline transgender", df);
    expect(holder).toBeGreaterThan(filler);
    // The unweighted coverage would have scored both 0.5.
    expect(filler).toBeLessThan(0.5);
    expect(holder).toBeGreaterThan(0.5);
  });

  it("returns 1 for a row holding every asked term whatever its df", () => {
    const df = new Map([["berlin", 40], ["user", 40], ["lives", 3]]);
    expect(coverageWeighted("user lives in Berlin", "user lives berlin", df)).toBe(1);
  });

  it("drops terms the partition has never seen instead of shrinking every score", () => {
    const df = new Map([["berlin", 4]]);
    // "kubernetes" is unseen: no row can hold it, so it must not tax the others.
    expect(coverageWeighted("user lives in Berlin", "berlin kubernetes", df)).toBe(1);
  });

  it("scores 0 when nothing asked has been seen or nothing is asked", () => {
    expect(coverageWeighted("anything", "totally unseen words", new Map([["totally", 1]]))).toBe(0);
    expect(coverageWeighted("anything", "", new Map([["a", 1]]))).toBe(0);
  });
});

describe("termDf", () => {
  it("in-memory store counts live rows over the whole map", async () => {
    const store = new InMemoryVectorStore();
    await store.init();
    const svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
    await svc.save({ namespace: NS, type: "semantic", text: "fencing club on tuesday", importance: 0.6 });
    await svc.save({ namespace: NS, type: "semantic", text: "fencing competition in spring", importance: 0.6 });
    await svc.save({ namespace: NS, type: "semantic", text: "pottery class on saturday", importance: 0.6 });
    const df = await store.termDf(["fencing", "pottery", "unseen"]);
    expect(df.get("fencing")).toBe(2);
    expect(df.get("pottery")).toBe(1);
    expect(df.has("unseen")).toBe(false);
  });

  it("sqlite store reads the maintained df table", async () => {
    const db = `:memory:` as const;
    const store = new SqliteVectorStore(db);
    await store.init();
    const svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
    await svc.save({ namespace: NS, type: "semantic", text: "fencing club on tuesday", importance: 0.6 });
    await svc.save({ namespace: NS, type: "semantic", text: "fencing competition in spring", importance: 0.6 });
    const df = await store.termDf(["fencing", "tuesday", "unseen"]);
    expect(df.get("fencing")).toBe(2);
    expect(df.get("tuesday")).toBe(1);
    expect(df.has("unseen")).toBe(false);
    store.close();
  });
});

describe("PRF second pass (ADR-0028)", () => {
  let store: InMemoryVectorStore;
  let retriever: HybridRetriever;

  beforeEach(() => {
    delete process.env.MEMORY_PRF;
    store = new InMemoryVectorStore();
    // Opt-in by default (measured net-negative on the LoCoMo audit); these tests
    // exercise the pass, so they ask for it — read at construction, like
    // MEMORY_ASSEMBLE.
    process.env.MEMORY_PRF = "on";
    retriever = new HybridRetriever(store, new HashEmbeddingProvider());
  });

  afterEach(() => { delete process.env.MEMORY_PRF; });

  const seed = async () => {
    await store.init();
    const svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
    // The question's words reach only the first row. The second holds the other
    // half of the answer and shares "fencing" with it — and deliberately shares
    // nothing with the question, so without the second pass it cannot sneak in
    // on recency+strength (0.34) plus a name-match bm25 crumb. The third is noise.
    await svc.save({ namespace: NS, type: "semantic", text: "Melanie's hobby is fencing; she goes to the fencing club every tuesday", importance: 0.6 });
    await svc.save({ namespace: NS, type: "semantic", text: "The fencing competition happens in spring", importance: 0.6 });
    await svc.save({ namespace: NS, type: "semantic", text: "The kubernetes ingress controller needs a static ip", importance: 0.6 });
  };

  it("is off by default: without the env the second pass never runs", async () => {
    await seed();
    delete process.env.MEMORY_PRF;
    retriever = new HybridRetriever(store, new HashEmbeddingProvider());
    const r = await retriever.search({ query: "What is Melanie's hobby?", namespace: NS, threshold: 0.35 });
    const texts = r.memories.map((m) => m.text);
    expect(texts.some((t) => t.includes("hobby is fencing"))).toBe(true);
    expect(texts.some((t) => t.includes("fencing competition"))).toBe(false);
  });

  it("reaches a row that shares the seeds' topic but none of the question's words", async () => {
    await seed();
    const r = await retriever.search({ query: "What is Melanie's hobby?", namespace: NS, threshold: 0.35 });
    const texts = r.memories.map((m) => m.text);
    expect(texts.some((t) => t.includes("hobby is fencing"))).toBe(true);
    expect(texts.some((t) => t.includes("fencing competition"))).toBe(true);
  });

  it("can be turned off and returns exactly the first pass", async () => {
    await seed();
    // The switch is read at construction, like MEMORY_ASSEMBLE.
    process.env.MEMORY_PRF = "off";
    retriever = new HybridRetriever(store, new HashEmbeddingProvider());
    const r = await retriever.search({ query: "What is Melanie's hobby?", namespace: NS, threshold: 0.35 });
    const texts = r.memories.map((m) => m.text);
    expect(texts.some((t) => t.includes("hobby is fencing"))).toBe(true);
    expect(texts.some((t) => t.includes("fencing competition"))).toBe(false);
  });

  it("never lets an expansion hit outrank a row that answered the question", async () => {
    await seed();
    const r = await retriever.search({ query: "What is Melanie's hobby?", namespace: NS, threshold: 0.35 });
    expect(r.memories[0]!.text).toContain("hobby is fencing");
  });

  it("does not fire when the first pass is empty", async () => {
    await seed();
    const r = await retriever.search({ query: "unrelated bamboo scaffolding", namespace: NS, threshold: 0.35 });
    expect(r.memories).toHaveLength(0);
  });

  it("does not expand on a term held by more than a third of the partition", async () => {
    await store.init();
    const svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
    // "alpha" sits in 3 of 5 rows — the protagonist's name, not the topic. Both
    // seeds hold it, but the DF_CAP_RATIO rule must keep it out of the expansion
    // even so, and every other seed term is a df-1 one-off, so no second pass
    // may run and "alpha three" (no asked word) must stay out.
    const rows = [
      "zeta alpha one",      // seed 1: holds the asked word
      "zeta alpha two",      // seed 2: holds the asked word
      "alpha three",         // would only be reachable through "alpha"
      "zeta beta four",
      "unrelated words entirely"
    ];
    for (const text of rows) {
      await svc.save({ namespace: NS, type: "semantic", text, importance: 0.6 });
    }
    const r = await retriever.search({ query: "zeta", namespace: NS, threshold: 0.35 });
    const texts = r.memories.map((m) => m.text);
    expect(texts.some((t) => t.includes("zeta alpha one"))).toBe(true);
    expect(texts.some((t) => t === "alpha three")).toBe(false);
  });
});
