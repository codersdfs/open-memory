import { describe, it, expect } from "vitest";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";

const NS = "r2:1";

async function svc() {
  const s = new MemoryService({ store: new InMemoryVectorStore() });
  await s.init();
  return s;
}

describe("R1 explainable recall", () => {
  it("the weighted terms sum to the final score", async () => {
    const s = await svc();
    await s.save({ namespace: NS, type: "semantic", text: "user lives in Berlin", importance: 0.9 });
    const r = await s.search({ query: "Berlin", namespace: NS, explain: true, threshold: 0, k: 3 });
    const e = r.memories[0].explain!;
    const sum = e.weighted.vector + e.weighted.bm25 + e.weighted.recency + e.weighted.strength + e.pinBoost;
    expect(sum).toBeCloseTo(e.final, 10);
    expect(e.final).toBeCloseTo(r.memories[0].score, 10);
  });

  it("is absent unless asked, so the default payload is unchanged", async () => {
    const s = await svc();
    await s.save({ namespace: NS, type: "semantic", text: "user lives in Berlin", importance: 0.9 });
    const plain = await s.search({ query: "Berlin", namespace: NS, threshold: 0, k: 3 });
    expect(plain.memories[0].explain).toBeUndefined();
    expect("explain" in plain.memories[0]).toBe(false);
  });

  it("does not change ranking", async () => {
    const s = await svc();
    await s.save({ namespace: NS, type: "semantic", text: "the cat is named Mimi and sleeps on the keyboard", importance: 0.4 });
    await s.save({ namespace: NS, type: "semantic", text: "user lives in Berlin and loves currywurst", importance: 0.9 });
    const a = await s.search({ query: "Berlin currywurst", namespace: NS, threshold: 0, k: 5 });
    const b = await s.search({ query: "Berlin currywurst", namespace: NS, threshold: 0, k: 5, explain: true });
    expect(b.memories.map((m) => m.id)).toEqual(a.memories.map((m) => m.id));
  });

  it("names the signal that carried the hit", async () => {
    const s = await svc();
    await s.save({ namespace: NS, type: "semantic", text: "user lives in Berlin", importance: 0.9 });
    const r = await s.search({ query: "Berlin", namespace: NS, explain: true, threshold: 0, k: 3 });
    const e = r.memories[0].explain!;
    expect(e.bm25).toBeGreaterThan(0);
    expect(e.weighted.bm25).toBeGreaterThan(0);
  });
});

describe("R2 retrieval reinforcement", () => {
  it("grows on retrieval and clamps at 0.95", async () => {
    const s = await svc();
    const m = await s.save({ namespace: NS, type: "semantic", text: "user lives in Berlin", importance: 0.5 });
    for (let i = 0; i < 50; i++) {
      await s.search({ query: "Berlin", namespace: NS, threshold: 0, k: 3 });
    }
    const after = await s.get(m.id);
    expect(after!.strength).toBe(0.95);
    expect(after!.lastUsedAt).toBeGreaterThan(0);
  });

  it("does not touch importance — the judge still owns that number", async () => {
    const s = await svc();
    const m = await s.save({ namespace: NS, type: "semantic", text: "user lives in Berlin", importance: 0.5 });
    await s.search({ query: "Berlin", namespace: NS, threshold: 0, k: 3 });
    expect((await s.get(m.id))!.importance).toBe(0.5);
  });

  it("only reinforces what survived the budget, not what merely scored", async () => {
    const s = await svc();
    const used = await s.save({ namespace: NS, type: "semantic", text: "user lives in Berlin", importance: 0.5 });
    const other = await s.save({ namespace: NS, type: "semantic", text: "user lives in Lisbon", importance: 0.5 });
    await s.search({ query: "Berlin", namespace: NS, threshold: 0, k: 1, budgetTokens: 40 });
    // One slot, one memory in the prompt: only that one earned reinforcement.
    const touched = [(await s.get(used.id))!.lastUsedAt, (await s.get(other.id))!.lastUsedAt].filter((x) => x !== null);
    expect(touched).toHaveLength(1);
  });

  it("a repeatedly-used memory outlives an untouched higher-importance one", async () => {
    const s = await svc();
    const weak = await s.save({ namespace: NS, type: "semantic", text: "user lives in Berlin", importance: 0.4 });
    const strong = await s.save({ namespace: NS, type: "semantic", text: "user lives in Lisbon", importance: 0.3 });
    for (let i = 0; i < 10; i++) await s.search({ query: "Berlin", namespace: NS, threshold: 0, k: 3 });

    // Evict on a 0-day horizon at a strength the untouched one is under: strength
    // is what decay reads, and only the used one crossed it.
    const store = s.store;
    const evicted = await store.prune({ olderThanMs: -1, maxImportance: 0.55 });
    expect(evicted).toBe(1);
    expect((await s.get(weak.id))!.isDeleted).toBe(0);
    expect((await s.get(strong.id))!.isDeleted).toBe(1);
  });

  it("resets its clock on use, so age is time-since-last-use", async () => {
    const s = await svc();
    const m = await s.save({ namespace: NS, type: "semantic", text: "user lives in Berlin", importance: 0.5 });
    await s.search({ query: "Berlin", namespace: NS, threshold: 0, k: 3 });
    // Created long ago but used just now: a prune of 1-day-old rows must not take it.
    await s.store.prune({ olderThanMs: 24 * 60 * 60 * 1000, maxImportance: 1 });
    expect((await s.get(m.id))!.isDeleted).toBe(0);
  });
});
