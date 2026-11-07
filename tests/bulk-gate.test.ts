import { describe, it, expect, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService, CurationRejected } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { SqliteVectorStore } from "../src/core/store/sqlite.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import { textHash } from "../src/core/write/text.js";

/**
 * The bulk gate (ADR-0018 amendment, 2026-11-07): `saveMany` stopped being the door
 * with no lock. Three promises, one per group below: the curation verdict runs on
 * every batch row (with per-row skips instead of a killed batch, and the `secret`
 * class has no escape hatch), exact duplicates fold in-batch and against live rows
 * per namespace, and the derived `text_hash` stays true to its row across every
 * write that can change the text.
 */

const SECRET = "api_key = sk-liveabcd1234efgh5678ijkl";
const CLEAN = "the staging deploy runs only after the green build";

function serviceOn(store: InMemoryVectorStore | SqliteVectorStore): MemoryService {
  const svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
  return svc;
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* temp dir */ }
  }
});

function tmpSqliteService(): { svc: MemoryService; store: SqliteVectorStore } {
  const dir = mkdtempSync(join(tmpdir(), "om-bulk-gate-"));
  dirs.push(dir);
  const store = new SqliteVectorStore(join(dir, "store.db"));
  const svc = serviceOn(store);
  return { svc, store };
}

describe("bulk curation gate", () => {
  const saved = new Map<string, string | undefined>();
  afterEach(() => {
    for (const k of ["MEMORY_CURATE"]) {
      if (saved.has(k)) {
        if (saved.get(k) === undefined) delete process.env[k];
        else process.env[k] = saved.get(k);
        saved.delete(k);
      }
    }
  });

  it("skips rejected rows with their index and reason, and lands the rest of the batch", async () => {
    const svc = serviceOn(new InMemoryVectorStore());
    await svc.init();
    const { memories, skipped, skipDetails } = await svc.saveMany([
      { namespace: "a:1", type: "semantic", text: CLEAN },
      { namespace: "a:1", type: "semantic", text: SECRET },
      { namespace: "a:1", type: "episodic", text: "好的" }
    ]);
    expect(memories).toHaveLength(1);
    expect(skipped).toBe(2);
    expect(skipDetails.map((d) => d.index)).toEqual([1, 2]);
    expect(skipDetails[0]!.reason).toContain("secret");
    expect(skipDetails[1]!.reason).toContain("phatic");
  });

  it("raw excuses every reject except secret and empty text", async () => {
    const svc = serviceOn(new InMemoryVectorStore());
    await svc.init();
    const { memories, skipped, skipDetails } = await svc.saveMany(
      [
        { namespace: "a:1", type: "semantic", text: "Things to remember:" }, // colon header: normally rejected
        { namespace: "a:1", type: "semantic", text: SECRET },
        { namespace: "a:1", type: "semantic", text: "   " } // blank: refused even under raw
      ],
      { raw: true }
    );
    expect(memories).toHaveLength(1);
    expect(memories[0]!.text).toBe("Things to remember:");
    expect(skipped).toBe(2);
    expect(skipDetails.map((d) => d.index)).toEqual([1, 2]);
  });

  it("the reconcile branch skips per row and honours raw the same way", async () => {
    const svc = serviceOn(new InMemoryVectorStore());
    await svc.init();
    const first = await svc.saveMany(
      [
        { namespace: "a:1", type: "semantic", text: CLEAN },
        { namespace: "a:1", type: "semantic", text: SECRET },
        { namespace: "a:1", type: "semantic", text: "Things to remember:" }
      ],
      { reconcile: true }
    );
    expect(first.memories).toHaveLength(1);
    expect(first.skipDetails.map((d) => d.index)).toEqual([1, 2]);
    const rawRun = await svc.saveMany(
      [
        { namespace: "a:1", type: "semantic", text: "Deploy checklist:" }, // excused by raw
        { namespace: "a:1", type: "semantic", text: SECRET }
      ],
      { reconcile: true, raw: true }
    );
    expect(rawRun.memories).toHaveLength(1);
    expect(rawRun.skipDetails).toEqual([{ index: 1, reason: expect.stringContaining("secret") }]);
  });

  it("raw skips the demotion ladder too", async () => {
    const svc = serviceOn(new InMemoryVectorStore());
    await svc.init();
    const { memories } = await svc.saveMany(
      [{ namespace: "a:1", type: "episodic", text: "我刚修好了登录的 bug" }],
      { raw: true }
    );
    expect(memories).toHaveLength(1);
    expect(memories[0]!.tags ?? []).not.toContain("curation:progress");
    expect(memories[0]!.importance).not.toBe(0.35);
  });

  it("MEMORY_CURATE=off turns the verdict off on the bulk path too", async () => {
    saved.set("MEMORY_CURATE", process.env.MEMORY_CURATE);
    process.env.MEMORY_CURATE = "off";
    const svc = serviceOn(new InMemoryVectorStore());
    await svc.init();
    const { memories, skipped } = await svc.saveMany([
      { namespace: "a:1", type: "semantic", text: "Things to remember:" }
    ]);
    expect(memories).toHaveLength(1);
    expect(skipped).toBe(0);
  });

  it("demotion keeps save's bargain: derived values sink with the tag, named values stand", async () => {
    const svc = serviceOn(new InMemoryVectorStore());
    await svc.init();
    const { memories } = await svc.saveMany([
      { namespace: "a:1", type: "episodic", text: "我刚修好了登录的 bug" },
      { namespace: "a:1", type: "episodic", text: "我刚修好了退款的 bug", kind: "task" }
    ]);
    expect(memories).toHaveLength(2);
    expect(memories[0]!.kind).toBe("note");
    expect(memories[0]!.importance).toBe(0.35);
    expect(memories[0]!.tags).toContain("curation:progress");
    // The caller named the kind: the store does not second-guess it (ADR-0040).
    expect(memories[1]!.kind).toBe("task");
    expect(memories[1]!.tags ?? []).not.toContain("curation:progress");
  });

  it("a single save still refuses secrets by throwing, as it always did", async () => {
    const svc = serviceOn(new InMemoryVectorStore());
    await svc.init();
    await expect(svc.save({ namespace: "a:1", type: "semantic", text: SECRET })).rejects.toBeInstanceOf(CurationRejected);
  });
});

describe("exact-duplicate folding", () => {
  it("folds in-batch and cross-run, per namespace, and lets a deleted text back in", async () => {
    const { svc, store } = tmpSqliteService();
    await svc.init();
    const first = await svc.saveMany([
      { namespace: "a:1", type: "semantic", text: CLEAN },
      { namespace: "a:1", type: "semantic", text: CLEAN }
    ]);
    expect(first.memories).toHaveLength(1);
    expect(first.skipDetails).toEqual([{ index: 1, reason: "duplicate in this batch (exact text)" }]);

    const replay = await svc.saveMany([
      { namespace: "a:1", type: "semantic", text: CLEAN },
      { namespace: "a:2", type: "semantic", text: CLEAN }
    ]);
    expect(replay.memories).toHaveLength(1); // the other partition may hold the same sentence
    expect(replay.skipDetails).toEqual([{ index: 0, reason: "already stored (exact text)" }]);

    // Tombstones do not block: what the user deleted, a re-import may store again.
    const listed = await svc.list({ namespace: "a:1" });
    await store.deleteSoft(listed.memories[0]!.id);
    const afterForget = await svc.saveMany([{ namespace: "a:1", type: "semantic", text: CLEAN }]);
    expect(afterForget.memories).toHaveLength(1);

    // Both stores answer the same question identically (repository rule).
    const mem = new InMemoryVectorStore();
    const memSvc = serviceOn(mem);
    await memSvc.init();
    await memSvc.saveMany([{ namespace: "a:1", type: "semantic", text: CLEAN }]);
    const found = await mem.findExistingHashes({ namespace: "a:1", hashes: [textHash(CLEAN), textHash("never stored")] });
    expect(found.has(textHash(CLEAN))).toBe(true);
    expect(found.has(textHash("never stored"))).toBe(false);
  });

  it("the fold never crosses the partition: project and type divide copies", async () => {
    const { svc } = tmpSqliteService();
    await svc.init();
    const both = await svc.saveMany([
      { namespace: "a:1", project: "repo-alpha", type: "semantic", text: CLEAN },
      { namespace: "a:1", project: "repo-beta", type: "semantic", text: CLEAN },
      { namespace: "a:1", project: "repo-alpha", type: "episodic", text: CLEAN }
    ]);
    // The same sentence under two repositories is two facts with two lifetimes
    // (ADR-0020) — and a semantic fact and its episodic echo are different rows.
    expect(both.memories).toHaveLength(3);
    expect(both.skipped).toBe(0);
    const replay = await svc.saveMany([{ namespace: "a:1", project: "repo-alpha", type: "semantic", text: CLEAN }]);
    expect(replay.skipped).toBe(1);
  });

  it("rows no read can show do not block a re-import", async () => {
    const { svc, store } = tmpSqliteService();
    await svc.init();
    await svc.saveMany([{ namespace: "a:1", type: "semantic", text: CLEAN }]);
    const id = (await svc.list({ namespace: "a:1" })).memories[0]!.id;
    await store.updateMeta(id, { status: "archived" });
    const again = await svc.saveMany([{ namespace: "a:1", type: "semantic", text: CLEAN }]);
    expect(again.memories).toHaveLength(1); // the archived copy is invisible to reads; the fold agrees
  });

  it("normalization folds noise that is not a different fact", async () => {
    const { svc } = tmpSqliteService();
    await svc.init();
    await svc.saveMany([{ namespace: "a:1", type: "semantic", text: "Deploy uses pnpm run build." }]);
    const again = await svc.saveMany([{ namespace: "a:1", type: "semantic", text: "deploy uses pnpm run build" }]);
    expect(again.memories).toHaveLength(0);
    expect(again.skipped).toBe(1);
  });

  it("the derived hash follows every write that changes the text", async () => {
    const { svc, store } = tmpSqliteService();
    await svc.init();
    await svc.saveMany([{ namespace: "a:1", type: "semantic", text: CLEAN }]);
    const listed = await svc.list({ namespace: "a:1" });
    const id = listed.memories[0]!.id;
    const moved = "the staging deploy moved to Tuesday nights";
    const movedEmbedding = await svc.embedder.embed(moved, { inputType: "passage" });
    await store.updateEmbedding(id, movedEmbedding, moved); // `reembed` with different text
    const oldGone = await svc.saveMany([{ namespace: "a:1", type: "semantic", text: CLEAN }]);
    expect(oldGone.memories).toHaveLength(1); // the row is no longer described by that hash
    const newBlocked = await svc.saveMany([{ namespace: "a:1", type: "semantic", text: moved }]);
    expect(newBlocked.skipped).toBe(1); // and the new text folds
  });
});
