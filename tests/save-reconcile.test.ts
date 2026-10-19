import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import type { EmbeddingProvider } from "../src/core/embedding/provider.js";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

let svc: MemoryService;
beforeEach(async () => {
  process.env.MEMORY_RECONCILE = "on";
  process.env.MEMORY_JEV = "false";          // rules only: no network in this file
  svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider(), dedupThreshold: 0.92 });
  await svc.init();
});

const NS = "pi:u";
const active = async () => (await svc.list({ namespace: NS })).memories;

describe("saveDetailed", () => {
  it("folds three restatements of one fact into one row", async () => {
    await svc.saveDetailed({ namespace: NS, type: "semantic", text: "use pnpm not npm" });
    const dup = await svc.saveDetailed({ namespace: NS, type: "semantic", text: "USE pnpm, not npm!" });
    const refined = await svc.saveDetailed({ namespace: NS, type: "semantic", text: "use pnpm not npm for every install" });
    expect(dup.decision.action).toBe("reinforce");
    expect(refined.decision.action).toBe("supersede");
    const rows = await active();
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("use pnpm not npm for every install");
  });

  it("links the chain and keeps the old row recoverable", async () => {
    const first = await svc.save({ namespace: NS, type: "semantic", text: "use pnpm not npm", tags: ["entity:pnpm"] });
    const second = await svc.save({ namespace: NS, type: "semantic", text: "use pnpm not npm for every install" });
    expect(second.supersedesId).toBe(first.id);
    const tombstone = await svc.get(first.id);
    expect(tombstone?.isDeleted).toBe(1);
    expect(tombstone?.text).toBe("use pnpm not npm");
    expect(second.tags).toContain("entity:pnpm");
  });

  it("leaves identical text in another namespace untouched", async () => {
    const other = await svc.save({ namespace: "claude:u", type: "semantic", text: "use pnpm not npm" });
    await svc.save({ namespace: NS, type: "semantic", text: "use pnpm not npm for every install" });
    expect((await svc.get(other.id))?.isDeleted).toBe(0);
  });

  it("keeps episodic and extractor writes append-only", async () => {
    await svc.save({ namespace: NS, type: "episodic", text: "use pnpm not npm today" });
    await svc.save({ namespace: NS, type: "episodic", text: "use pnpm not npm today again" });
    await svc.save({ namespace: NS, type: "semantic", text: "use pnpm not npm", source: "extractor" });
    const extractor = await svc.saveDetailed({ namespace: NS, type: "semantic", source: "extractor", text: "use pnpm not npm for every install" });
    expect(extractor.decision.action).toBe("insert");
    expect(await active()).toHaveLength(4);
  });

  // A non-hash stub: the cosine gate exists only for real embedders, and this pair is
  // deliberately not a token-subset, so only the judge can decide it.
  const stubEmbedder = {
    name: "nim", dim: 4,
    embed: async () => [1, 0, 0, 0],
    embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]),
  } as unknown as EmbeddingProvider;

  it("supersedes a contradiction once the judge says so", async () => {
    const judged = new MemoryService({
      store: new InMemoryVectorStore(), embedder: stubEmbedder,
      relation: async () => "contradicts",
    });
    await judged.init();
    const old = await judged.save({ namespace: NS, type: "semantic", text: "the API listens on 8787" });
    const next = await judged.saveDetailed({ namespace: NS, type: "semantic", text: "the API now listens on 9090" });
    expect(next.decision.action).toBe("supersede");
    expect(next.decision.reason).toBe("model-contradicts");
    expect(next.memory.supersedesId).toBe(old.id);
    expect(next.memory.text).toBe("the API now listens on 9090 (previously: the API listens on 8787)");
    expect((await judged.get(old.id))?.isDeleted).toBe(1);
  });

  it("never asks the judge about a below-gate neighbour", async () => {
    let asked = 0;
    const judged = new MemoryService({
      store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider(),
      relation: async () => { asked++; return "contradicts"; },
    });
    await judged.init();
    await judged.save({ namespace: NS, type: "semantic", text: "deploy the memory service" });
    const other = await judged.saveDetailed({ namespace: NS, type: "semantic", text: "deploy the blog with hugo" });
    expect(asked).toBe(0);
    expect(other.decision).toMatchObject({ action: "insert", reason: "no-neighbour" });
  });

  it("treats MEMORY_RECONCILE=OFF as off", async () => {
    process.env.MEMORY_RECONCILE = "OFF";
    const a = await svc.saveDetailed({ namespace: NS, type: "semantic", text: "use pnpm not npm" });
    expect(a.decision.reason).toBe("disabled");
  });

  it("MEMORY_RECONCILE=off restores the old path", async () => {
    process.env.MEMORY_RECONCILE = "off";
    const a = await svc.saveDetailed({ namespace: NS, type: "semantic", text: "use pnpm not npm" });
    const b = await svc.saveDetailed({ namespace: NS, type: "semantic", text: "use pnpm not npm for every install" });
    expect(a.decision.reason).toBe("disabled");
    expect(b.decision.reason).toBe("disabled");
    expect((await active()).length).toBe(2);
  });
});
