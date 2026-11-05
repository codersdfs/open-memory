import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import { STATUSES } from "../src/core/types.js";

function freshService() {
  return new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
}

describe("store", () => {
  let svc: MemoryService;
  beforeEach(async () => { svc = freshService(); await svc.init(); });
  afterEach(() => { try { svc.close(); } catch {} });

  // The advertised statuses and the schema are one set: `superseded` sat in STATUSES while
  // the CHECK rejected it, so the console dropdown and `meta --status superseded` failed at
  // the row. This fails the moment the two drift apart again.
  it("stores every advertised status — STATUSES and the CHECK constraint agree", async () => {
    const sqlite = new MemoryService({ dbPath: ":memory:" });
    await sqlite.init();
    try {
      for (const status of STATUSES) {
        const saved = await sqlite.save({ namespace: "a:1", type: "semantic", text: `a row whose status is ${status}` });
        await expect(sqlite.updateMeta(saved.id, { status })).resolves.toBeTruthy();
      }
    } finally {
      try { sqlite.close(); } catch {}
    }
  });

  // ADR-0042: the management statements run over the `project` column in both
  // stores, so this is the SQL half of the contract the project-memory suite pins
  // on the in-memory one.
  it("sqlite: listProjects, renameProject and forgetProject ride the project column", async () => {
    const sqlite = new MemoryService({ dbPath: ":memory:" });
    await sqlite.init();
    try {
      await sqlite.save({ namespace: "a:1", type: "semantic", text: "alpha convention row", kind: "convention", project: "alpha" });
      await sqlite.save({ namespace: "a:1", type: "semantic", text: "alpha decision row", kind: "decision", project: "alpha" });
      await sqlite.save({ namespace: "b:2", type: "semantic", text: "beta row in another partition", project: "beta" });
      const tomb = await sqlite.save({ namespace: "a:1", type: "semantic", text: "alpha row later forgotten", project: "alpha" });
      await sqlite.delete(tomb.id);

      const alpha = (await sqlite.listProjects()).find((p) => p.project === "alpha")!;
      expect(alpha.rows).toBe(2);
      expect(alpha.byKind).toEqual({ convention: 1, decision: 1 });

      // The rename moves tombstones too — three rows, though only two are live.
      expect((await sqlite.renameProject("alpha", "gamma")).renamed).toBe(3);
      expect((await sqlite.get(tomb.id))!.project).toBe("gamma");
      expect((await sqlite.listProjects()).find((p) => p.project === "gamma")!.rows).toBe(2);

      const forgotten = await sqlite.forgetProject("gamma", { mode: "delete" });
      expect(forgotten).toEqual({ detached: 0, deleted: 2, project: "gamma" });
      const kept = (await sqlite.list({ namespace: "a:1", includeDeleted: true, limit: 10 })).memories;
      expect(kept.every((m) => m.project !== "gamma" || m.isDeleted === 1)).toBe(true);

      const detached = await sqlite.forgetProject("beta", { mode: "detach" });
      expect(detached).toEqual({ detached: 1, deleted: 0, project: "beta" });
      expect((await sqlite.list({ namespace: "b:2", project: null, limit: 10 })).total).toBe(1);
    } finally {
      try { sqlite.close(); } catch {}
    }
  });

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
