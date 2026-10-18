import { describe, it, expect } from "vitest";
import { reconcile } from "../src/core/write/reconciler.js";
import type { Memory } from "../src/core/types.js";

function mem(over: Partial<Memory> = {}): Memory {
  return {
    id: "old-1", namespace: "pi:u", type: "semantic", text: "use pnpm not npm",
    embedding: [], importance: 0.8, strength: 0.8, lastUsedAt: null,
    source: "mcp:pi", tags: ["entity:pnpm"], supersedesId: null, isDeleted: 0,
    visibility: "private", status: "active", pin: 0, createdAt: 1, updatedAt: 1, ...over
  };
}

const base = { type: "semantic" as const, embedderKind: "hash", source: "mcp:pi" };

describe("reconcile", () => {
  it("inserts when there is no neighbour", async () => {
    const d = await reconcile({ ...base, text: "anything", neighbours: [] });
    expect(d.action).toBe("insert");
    expect(d.reason).toBe("no-neighbour");
  });

  it("reinforces an exact duplicate", async () => {
    const d = await reconcile({ ...base, text: "USE pnpm, not npm!", neighbours: [{ memory: mem(), vectorScore: 0.9 }] });
    expect(d).toMatchObject({ action: "reinforce", reason: "exact-duplicate", oldId: "old-1" });
  });

  it("never gates on the hash embedder's ~0.9 cosine", async () => {
    const d = await reconcile({ ...base, text: "deploy the blog with hugo", neighbours: [{ memory: mem(), vectorScore: 0.95 }] });
    expect(d.action).toBe("insert");
  });

  it("gates on cosine when a real embedder is configured", async () => {
    const d = await reconcile({
      ...base, embedderKind: "nim", text: "we moved off npm",
      neighbours: [{ memory: mem(), vectorScore: 0.9 }],
      relation: async () => "contradicts"
    });
    expect(d).toMatchObject({ action: "supersede", reason: "model-contradicts", oldId: "old-1" });
    expect(d.text).toBe("we moved off npm (previously: use pnpm not npm)");
  });

  it("supersedes a refinement by rule, without a model", async () => {
    const d = await reconcile({ ...base, text: "use pnpm not npm for every install", neighbours: [{ memory: mem(), vectorScore: 0.9 }] });
    expect(d).toMatchObject({ action: "supersede", reason: "refinement" });
    expect(d.tags).toContain("entity:pnpm");
  });

  it("leaves an unpinned episodic pair alone", async () => {
    const d = await reconcile({ ...base, type: "episodic", text: "use pnpm not npm today", neighbours: [{ memory: mem({ type: "episodic" }), vectorScore: 0.9 }] });
    expect(d).toMatchObject({ action: "insert", reason: "episodic-no-delete" });
  });

  it("never deletes a pinned memory", async () => {
    const d = await reconcile({ ...base, text: "use pnpm not npm for every install", neighbours: [{ memory: mem({ pin: 1 }), vectorScore: 0.9 }] });
    expect(d).toMatchObject({ action: "insert", reason: "pinned-no-delete" });
  });

  it("gives an extractor write no delete privilege, even when it covers the old text", async () => {
    const d = await reconcile({ ...base, source: "extractor", text: "use pnpm not npm for every install", neighbours: [{ memory: mem(), vectorScore: 0.9 }] });
    expect(d).toMatchObject({ action: "insert", reason: "extractor-no-delete" });
  });

  it("treats a throwing judge as insert", async () => {
    const d = await reconcile({
      ...base, embedderKind: "nim", text: "unrelated wording",
      neighbours: [{ memory: mem(), vectorScore: 0.9 }],
      relation: async () => { throw new Error("down"); }
    });
    expect(d).toMatchObject({ action: "insert", reason: "model-unavailable" });
  });
});
