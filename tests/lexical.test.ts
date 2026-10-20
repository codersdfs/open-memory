import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";

/** A service whose vector half is deliberately blind: every hit must come from words. */
function blindVectorService() {
  const store = new InMemoryVectorStore();
  // The whole point of ADR-0012 is that lexical signal is not downstream of the
  // embedding. Emptying vectorSearch is the sharpest way to say that: if the row
  // still comes back, it came back on its terms alone.
  store.vectorSearch = async () => [];
  return new MemoryService({ store, embedder: new HashEmbeddingProvider() });
}

describe("lexical candidates (ADR-0012)", () => {
  let svc: MemoryService;
  beforeEach(async () => {
    svc = blindVectorService();
    await svc.init();
  });
  afterEach(() => {
    try { svc.close(); } catch {}
  });

  it("returns a memory the vector scan never offered", async () => {
    const saved = await svc.save({ namespace: "a:1", type: "semantic", text: "the deploy key lives in vault entry 7712" });
    await svc.save({ namespace: "a:1", type: "semantic", text: "the cat sleeps on the keyboard" });

    const res = await svc.search({ query: "vault entry", namespace: "a:1", k: 5, threshold: 0 });
    expect(res.memories.map((m) => m.id)).toContain(saved.id);
    // vectorScore 0 is the honest number: nothing about the embedding said this
    // row was relevant, and the explain view must not pretend otherwise.
    expect(res.memories.find((m) => m.id === saved.id)!.vectorScore).toBe(0);
  });

  it("works for Chinese queries the hash embedder cannot rank", async () => {
    const wanted = await svc.save({ namespace: "a:1", type: "semantic", text: "用户偏好简体中文回复。部署脚本放在D盘。" });
    await svc.save({ namespace: "a:1", type: "episodic", text: "今天天气不错，我们去公园散步了。" });

    const res = await svc.search({ query: "简体中文", namespace: "a:1", k: 5, threshold: 0 });
    expect(res.memories[0].id).toBe(wanted.id);
  });

  it("ranks the rare term above the common one", async () => {
    await svc.save({ namespace: "a:1", type: "semantic", text: "berlin is the capital of germany" });
    await svc.save({ namespace: "a:1", type: "semantic", text: "berlin has a famous currywurst stand" });
    const rare = await svc.save({ namespace: "a:1", type: "semantic", text: "quincy works in the basement lab" });

    // "quincy" appears in one row, "berlin" in two: idf is what makes the rare
    // word decisive instead of the common one winning on raw term count.
    const res = await svc.search({ query: "berlin quincy", namespace: "a:1", k: 3, threshold: 0 });
    expect(res.memories[0].id).toBe(rare.id);
  });

  it("does not resurrect forgotten or archived rows", async () => {
    const forgotten = await svc.save({ namespace: "a:1", type: "semantic", text: "obsolete quincy runbook" });
    const archived = await svc.save({ namespace: "a:1", type: "semantic", text: "archived quincy runbook" });
    await svc.delete(forgotten.id);
    await svc.updateMeta(archived.id, { status: "archived" });

    const res = await svc.search({ query: "quincy runbook", namespace: "a:1", k: 5, threshold: 0 });
    const ids = res.memories.map((m) => m.id);
    expect(ids).not.toContain(forgotten.id);
    expect(ids).not.toContain(archived.id);
  });

  it("respects the partition boundary", async () => {
    await svc.save({ namespace: "a:1", type: "semantic", text: "quincy in partition one" });
    const other = await svc.save({ namespace: "b:2", type: "semantic", text: "quincy in partition two" });

    const res = await svc.search({ query: "quincy", namespace: "a:1", k: 5, threshold: 0 });
    expect(res.memories.map((m) => m.id)).not.toContain(other.id);
  });

  it("honours k after the budget instead of only over-fetching", async () => {
    for (let i = 0; i < 8; i++) {
      await svc.save({ namespace: "a:1", type: "semantic", text: `berlin fact number ${i} about the city` });
    }
    const res = await svc.search({ query: "berlin", namespace: "a:1", k: 2, threshold: 0, budgetTokens: 800 });
    expect(res.memories).toHaveLength(2);
    expect(res.tokensUsed).toBeLessThanOrEqual(800);
  });
});

describe("lexical index on the sqlite store", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("backfills rows written before the index existed", async () => {
    dir = mkdtempSync(join(tmpdir(), "open-memory-lex-"));
    const dbPath = join(dir, "memory.db");

    const first = new MemoryService({ dbPath });
    await first.init();
    const saved = await first.save({ namespace: "a:1", type: "semantic", text: "the deploy key lives in vault entry 7712" });
    first.close();

    // Simulate a store from an older build: the rows are there, the postings are not.
    const DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
    const raw = new DatabaseSync(dbPath);
    raw.exec("DELETE FROM memory_terms");
    raw.close();

    const second = new MemoryService({ dbPath });
    await second.init();
    try {
      const res = await second.search({ query: "vault entry", namespace: "a:1", k: 5, threshold: 0 });
      expect(res.memories.map((m) => m.id)).toContain(saved.id);
    } finally {
      second.close();
    }
  });

  it("keeps the postings in step with an edited text", async () => {
    dir = mkdtempSync(join(tmpdir(), "open-memory-lex2-"));
    const svc = new MemoryService({ dbPath: join(dir, "memory.db") });
    await svc.init();
    try {
      const saved = await svc.save({ namespace: "a:1", type: "semantic", text: "quincy runs the old pipeline" });
      const embedding = saved.embedding;
      // reembed rewrites text; a stale posting list would keep answering "old".
      // ("pipeline" survives by design — the row still contains it.)
      await svc.store.updateEmbedding(saved.id, embedding, "quincy runs the new pipeline");

      const stale = await svc.search({ query: "old", namespace: "a:1", k: 5, threshold: 0 });
      expect(stale.memories.map((m) => m.id)).not.toContain(saved.id);

      const fresh = await svc.search({ query: "new pipeline", namespace: "a:1", k: 5, threshold: 0 });
      expect(fresh.memories.map((m) => m.id)).toContain(saved.id);
    } finally {
      svc.close();
    }
  });
});
