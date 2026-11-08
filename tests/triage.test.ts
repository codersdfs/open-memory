import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { SqliteVectorStore } from "../src/core/store/sqlite.js";
import { runTriage, renderTriageReport } from "../src/core/lifecycle/triage.js";
import { DEMOTE_IMPORTANCE } from "../src/core/write/curation.js";
import { normalizeText } from "../src/core/write/text.js";
import type { Memory } from "../src/core/types.js";
import type { VectorStore } from "../src/core/store/interface.js";
import { PartitionCache } from "../src/core/store/partitionCache.js";

/**
 * Retroactive curation (P3, ADR-0040 amendment 2026-11-08): the stock gets the
 * write-time verdict through `ai-memory triage`, diff first.
 *
 * Three promises, one per group: the dry run writes nothing (snapshot-compared,
 * not spot-checked), the apply pass archives junk and sinks weak rows while
 * leaving every row a contract protects — durable kinds (ADR-0021), pinned rows
 * (ADR-0011), drafts, knowledge indexes (ADR-0023), tombstones — exactly where it
 * was, and merge candidates are a report line, never a write, in either mode.
 * The store-level behaviour runs on BOTH stores: every action goes through
 * `updateMeta`, so the sqlite run pins the trailing noteChange (an archived row
 * must leave the decoded partitions) and the in-memory run pins parity.
 */

const JUNK_TABLE = "| 网卡 | MediaTek Wi-Fi 6 MT7902LEN | ✅ 卡不差 |";
const JUNK_COLON = "部署要点：";
const CLEAN = "the staging deploy runs only after the green build";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* temp dir */ }
  }
});

type StoreName = "memory" | "sqlite";

const stores: StoreName[] = ["memory", "sqlite"];

async function makeStore(which: StoreName): Promise<InMemoryVectorStore | SqliteVectorStore> {
  if (which === "memory") return new InMemoryVectorStore();
  const dir = mkdtempSync(join(tmpdir(), "om-triage-"));
  dirs.push(dir);
  const store = new SqliteVectorStore(join(dir, "store.db"));
  await store.init();
  return store;
}

/** One insert that needs no follow-up mutation: everything a test row needs is an input. */
async function put(
  store: VectorStore,
  row: Partial<Memory> & { text: string; namespace?: string }
): Promise<Memory> {
  return store.insert(
    {
      namespace: row.namespace ?? "agent:user",
      type: "semantic",
      text: row.text,
      kind: row.kind,
      importance: row.importance,
      tags: row.tags,
      status: row.status,
      pin: row.pin,
      knowledgeId: row.knowledgeId,
      knowledgeSection: row.knowledgeSection,
    },
    [0.1, 0.2, 0.3]
  );
}

/** The fixture gallery: one row per rule the pass must respect. */
async function seedGallery(store: VectorStore) {
  const junkTable = await put(store, { text: JUNK_TABLE, kind: "note", importance: 0.4 });
  const junkColon = await put(store, { text: JUNK_COLON, kind: "note", importance: 0.4 });
  const judgedJunk = await put(store, { text: "| judged | table | row |", kind: "note", importance: 0.4, tags: ["judged:jev"] });
  const progress = await put(store, { text: "我刚做完了登录的修复", kind: "note", importance: 0.6 });
  const selfNarration = await put(store, { text: "I can only work with local files here", kind: "note", importance: 0.5 });
  const progressAlreadyLow = await put(store, { text: "我刚部署完了 staging", kind: "note", importance: 0.3 });
  const durableDecision = await put(store, { text: "| decision | table |", kind: "decision", importance: 0.4 });
  const durableGotcha = await put(store, { text: "| gotcha | row |", kind: "gotcha", importance: 0.75 });
  const pinnedJunk = await put(store, { text: "| pinned | table |", kind: "note", importance: 0.4, pin: 1 });
  const draftJunk = await put(store, { text: "| draft | table |", kind: "note", importance: 0.4, status: "draft" });
  const knowledgeJunk = await put(store, {
    text: "| knowledge | table |", kind: "note", importance: 0.4,
    knowledgeId: "page", knowledgeSection: "sec",
  });
  const tombstoneJunk = await put(store, { text: "| dead | table |", kind: "note", importance: 0.4 });
  await store.deleteSoft(tombstoneJunk.id);
  const judgedClean = await put(store, { text: CLEAN, kind: "note", importance: 0.4, tags: ["judged:write-gate"] });

  // Merge candidates: same comparison form, shared entity facet. A third copy
  // holds the same claim under a different entity, and a fourth holds the claim
  // with no entity at all — neither joins the pnpm group.
  const mergeA = await put(store, { text: "Deploy uses pnpm run build.", kind: "note", importance: 0.4, tags: ["entity:pnpm"] });
  const mergeB = await put(store, { text: "deploy uses pnpm run build", kind: "note", importance: 0.4, tags: ["entity:pnpm"] });
  const otherEntity = await put(store, { text: "deploy uses pnpm run build", kind: "note", importance: 0.4, tags: ["entity:other"] });
  const noEntity = await put(store, { text: "deploy uses pnpm run build", kind: "note", importance: 0.4 });

  return { junkTable, junkColon, judgedJunk, progress, selfNarration, progressAlreadyLow, durableDecision, durableGotcha, pinnedJunk, draftJunk, knowledgeJunk, tombstoneJunk, judgedClean, mergeA, mergeB, otherEntity, noEntity };
}

/** Full-row snapshot: the dry-run comparison is over every mutable column, not spot checks. */
async function snapshot(store: VectorStore, ids: string[]): Promise<Map<string, Pick<Memory, "status" | "importance" | "isDeleted" | "updatedAt" | "pin">>> {
  const out = new Map<string, Pick<Memory, "status" | "importance" | "isDeleted" | "updatedAt" | "pin">>();
  for (const id of ids) {
    const m = (await store.getById(id))!;
    out.set(id, { status: m.status, importance: m.importance, isDeleted: m.isDeleted, updatedAt: m.updatedAt, pin: m.pin });
  }
  return out;
}

describe.each(stores)("runTriage dry-run writes nothing (%s store)", (which) => {
  it("reports the diff and leaves every row byte-identical", async () => {
    const store = await makeStore(which);
    const rows = await seedGallery(store);
    const allIds = Object.values(rows).map((r: Memory) => r.id);
    const before = await snapshot(store, allIds);

    const report = await runTriage(store);

    // The diff is the product: counts and the ids behind them.
    expect(report.applied).toBe(false);
    expect(report.archives.map((c) => c.id).sort()).toEqual([rows.junkTable.id, rows.junkColon.id, rows.judgedJunk.id].sort());
    expect(report.demotions.map((c) => c.id).sort()).toEqual([rows.progress.id, rows.selfNarration.id].sort());
    expect(report.merges).toEqual([
      { entity: "pnpm", text: normalizeText("Deploy uses pnpm run build."), ids: [rows.mergeA.id, rows.mergeB.id].sort() },
    ]);
    // Unjudged: every live row without a judged:* tag. 17 rows in the gallery,
    // minus the knowledge row, the tombstone, the draft (the population the pass
    // can act on is `active`), and the two rows a judge priced.
    expect(report.unjudged).toBe(17 - 1 - 1 - 1 - 2);
    expect(report.partitions).toBe(1);

    // …and nothing moved: status, importance, tombstone, pin, even updated_at.
    const after = await snapshot(store, allIds);
    expect([...after.entries()]).toEqual([...before.entries()]);
    // The write contract still holds on the rows the pass WOULD touch:
    expect((await store.getById(rows.junkTable.id))!.isDeleted).toBe(0);
    expect((await store.getById(rows.progress.id))!.status).toBe("active");

    // The human summary names the counts and carries samples with ids + reasons.
    const text = renderTriageReport(report);
    expect(text).toContain("dry run — nothing written");
    expect(text).toContain("would archive 3");
    expect(text).toContain("would demote 2");
    expect(text).toContain("merge candidates 1 group(s) / 2 row(s)");
    expect(text).toContain("unjudged");
    expect(text).toContain(`archive [${rows.junkTable.id}] (table-row)`);
    expect(text).toContain(`demote [${rows.progress.id}] (progress, importance 0.6 → 0.35)`);
    expect(text).toContain(`merge candidate entity:pnpm ×2: [${rows.mergeA.id}] ↔ [${rows.mergeB.id}]`);
    await store.close();
  });
});

describe.each(stores)("runTriage --apply (%s store)", (which) => {
  it("archives junk and sinks weak rows, and leaves every protected row exactly where it was", async () => {
    const store = await makeStore(which);
    const rows = await seedGallery(store);

    const report = await runTriage(store, { apply: true });
    expect(report.applied).toBe(true);

    // Junk: archived by a status flip, never a delete — the row stays readable.
    for (const id of [rows.junkTable.id, rows.junkColon.id, rows.judgedJunk.id]) {
      const m = (await store.getById(id))!;
      expect(m.status).toBe("archived");
      expect(m.isDeleted).toBe(0);
    }
    // Weak classes: the write-time demotion ladder's floor, on stock rows.
    expect((await store.getById(rows.progress.id))!.importance).toBe(DEMOTE_IMPORTANCE);
    expect((await store.getById(rows.progress.id))!.status).toBe("active");
    expect((await store.getById(rows.selfNarration.id))!.importance).toBe(DEMOTE_IMPORTANCE);
    // Already at or under the floor: nothing to sink, nothing done.
    expect((await store.getById(rows.progressAlreadyLow.id))!.importance).toBe(0.3);

    // The protected rows: durable kinds (ADR-0021), pin (ADR-0011), knowledge
    // indexes (ADR-0023) — untouched, still active.
    for (const id of [rows.durableDecision.id, rows.durableGotcha.id, rows.pinnedJunk.id, rows.knowledgeJunk.id]) {
      const m = (await store.getById(id))!;
      expect(m.status).toBe("active");
      expect(m.isDeleted).toBe(0);
    }
    expect((await store.getById(rows.durableGotcha.id))!.importance).toBe(0.75);
    // A draft is a governance state (ADR-0006): the pass leaves it a draft.
    expect((await store.getById(rows.draftJunk.id))!.status).toBe("draft");
    expect((await store.getById(rows.draftJunk.id))!.isDeleted).toBe(0);
    expect((await store.getById(rows.tombstoneJunk.id))!.isDeleted).toBe(1);

    // Merge candidates were listed, not merged — in either mode.
    for (const m of [rows.mergeA, rows.mergeB]) {
      const after = (await store.getById(m.id))!;
      expect(after.status).toBe("active");
      expect(after.isDeleted).toBe(0);
      expect(after.supersedesId ?? null).toBeNull();
    }

    // Idempotent: an archived junk row is not proposed (or written) again.
    const second = await runTriage(store, { apply: true });
    expect(second.archives).toHaveLength(0);
    expect(second.demotions).toHaveLength(0);
    await store.close();
  });

  it("sweeps every partition, not just the first one", async () => {
    const store = await makeStore(which);
    await put(store, { text: JUNK_TABLE, kind: "note", importance: 0.4 });
    await put(store, { text: JUNK_TABLE, kind: "note", importance: 0.4, namespace: "other:user" });
    const report = await runTriage(store, { apply: true });
    expect(report.partitions).toBe(2);
    expect(report.archives).toHaveLength(2);
    await store.close();
  });
});

describe("runTriage paging", () => {
  it("pages past list()'s 100-row default and applies across pages", async () => {
    const store = new InMemoryVectorStore();
    for (let i = 0; i < 505; i++) {
      await put(store, { text: `| row ${i} | junk |`, kind: "note", importance: 0.4 });
    }
    const report = await runTriage(store, { apply: true });
    expect(report.scanned).toBe(505);
    expect(report.archives).toHaveLength(505);
    const page = await store.list({ namespace: "agent:user", includeArchived: true, limit: 1 });
    expect(page.memories[0]!.status).toBe("archived");
    await store.close();
  });
});

describe("updateMeta importance patch (P3 prerequisite)", () => {
  it("patches importance on both stores and nothing else moves", async () => {
    for (const which of stores) {
      const store = await makeStore(which);
      const m = await put(store, { text: CLEAN, kind: "note", importance: 0.6 });
      const updated = await store.updateMeta(m.id, { importance: 0.2 });
      expect(updated).not.toBeNull();
      expect(updated!.importance).toBe(0.2);
      expect(updated!.status).toBe("active");
      const reread = (await store.getById(m.id))!;
      expect(reread.importance).toBe(0.2);
      expect(reread.updatedAt).toBeGreaterThanOrEqual(m.updatedAt);
      await store.close();
    }
  });

  it("an importance patch expires the cached partitions it rode in (sqlite)", async () => {
    const store = await makeStore("sqlite");
    try {
      const m = await put(store, { text: "a row about the parser budget", kind: "note", importance: 0.6 });
      const query = [0.1, 0.2, 0.3];
      await store.vectorSearch({ namespace: m.namespace, queryEmbedding: query, limit: 5 });
      const misses = (store as unknown as { vectors: PartitionCache }).vectors.stats().misses;

      // importance is not in the candidate WHERE, but the noteChange contract is
      // unconditional: the row must leave the decoded snapshots, so the next
      // search pays a decode again instead of serving a stale one.
      await store.updateMeta(m.id, { importance: 0.2 });
      await store.vectorSearch({ namespace: m.namespace, queryEmbedding: query, limit: 5 });
      expect((store as unknown as { vectors: PartitionCache }).vectors.stats().misses).toBeGreaterThan(misses);
    } finally {
      store.close();
    }
  });
});
