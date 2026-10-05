import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";

function freshService() {
  return new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
}

describe("store", () => {
  let svc: MemoryService;
  beforeEach(async () => { svc = freshService(); await svc.init(); });
  afterEach(() => { try { svc.close(); } catch {} });

  it("saves and retrieves by namespace", async () => {
    await svc.save({ namespace: "a:1", type: "semantic", text: "user lives in Berlin" });
    await svc.save({ namespace: "a:1", type: "semantic", text: "user likes TypeScript" });
    await svc.save({ namespace: "b:2", type: "semantic", text: "other user data" });
    const { memories, total } = await svc.list({ namespace: "a:1" });
    expect(total).toBe(2);
    expect(memories.every(m => m.namespace === "a:1")).toBe(true);
  });

  it("soft delete hides from list but keeps when includeDeleted", async () => {
    const m = await svc.save({ namespace: "a:1", type: "episodic", text: "episodic event" });
    await svc.delete(m.id);
    const { total } = await svc.list({ namespace: "a:1" });
    expect(total).toBe(0);
    const withDel = await svc.list({ namespace: "a:1", includeDeleted: true });
    expect(withDel.total).toBe(1);
  });

  it("supersede links and soft-deletes old", async () => {
    const old = await svc.save({ namespace: "a:1", type: "semantic", text: "user lives in Berlin", importance: 0.9 });
    const neu = await svc.supersede(old.id, { namespace: "a:1", type: "semantic", text: "user lives in Tokyo", importance: 0.9 });
    expect(neu.supersedesId).toBe(old.id);
    const fetchedOld = await svc.get(old.id);
    expect(fetchedOld?.isDeleted).toBe(1);
    const { total } = await svc.list({ namespace: "a:1" });
    expect(total).toBe(1);
    expect((await svc.list({ namespace: "a:1", includeDeleted: true })).total).toBe(2);
  });

  it("dedup prevents identical insert", async () => {
    const a = await svc.save({ namespace: "a:1", type: "semantic", text: "duplicate text" });
    const b = await svc.save({ namespace: "a:1", type: "semantic", text: "duplicate text" });
    expect(b.id).toBe(a.id);
    const { total } = await svc.list({ namespace: "a:1" });
    expect(total).toBe(1);
  });
});
