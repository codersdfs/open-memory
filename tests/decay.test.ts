import { describe, it, expect } from "vitest";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { archiveStale, runDecay, runDecayDetailed } from "../src/core/lifecycle/decay.js";
import { MemoryService } from "../src/core/memoryService.js";
import { callTool } from "../src/mcp/tools.js";
import { resolveRequestScope } from "../src/core/scope.js";
import type { MemoryStatus, MemoryType } from "../src/core/types.js";

/**
 * The lifecycle contract: lose nothing by default, prune only on request.
 *
 * Ages are pinned through `now` and mutation of `createdAt` rather than by sleeping or
 * relying on the wall clock, so these assertions do not rot.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 19, 0, 0, 0);

interface Row {
  namespace?: string;
  type?: MemoryType;
  importance?: number;
  strength?: number;
  ageDays?: number;
  status?: MemoryStatus;
  lastUsedAt?: number | null;
}

async function add(store: InMemoryVectorStore, row: Row = {}) {
  const memory = await store.insert(
    {
      namespace: row.namespace ?? "agent:user",
      type: row.type ?? "semantic",
      text: `row-${Math.random()}`,
      importance: row.importance ?? 0.4,
      strength: row.strength ?? row.importance ?? 0.4,
      status: row.status ?? "active"
    },
    [0.1, 0.2, 0.3]
  );
  memory.createdAt = NOW - (row.ageDays ?? 40) * DAY;
  if (row.lastUsedAt !== undefined) memory.lastUsedAt = row.lastUsedAt;
  return memory;
}

describe("archiveStale", () => {
  it("archives only active, never-retrieved, older-than-30d, sub-0.6 rows", async () => {
    const store = new InMemoryVectorStore();
    const stale = await add(store, { ageDays: 40, importance: 0.4 });
    const staleOtherPartition = await add(store, { namespace: "other:user", ageDays: 31, importance: 0.59 });
    const fresh = await add(store, { ageDays: 10, importance: 0.4 });
    const retrieved = await add(store, { ageDays: 40, importance: 0.4, lastUsedAt: NOW - DAY });
    const important = await add(store, { ageDays: 40, importance: 0.6 }); // boundary: kept
    const atAgeBoundary = await add(store, { ageDays: 30, importance: 0.1 }); // "30d old" is not ">30d"
    const alreadyArchived = await add(store, { ageDays: 40, importance: 0.1, status: "archived" });

    // Two partitions, because staleness is a cross-partition property.
    expect(await archiveStale(store, { now: NOW })).toBe(2);
    expect((await store.getById(stale.id))!.status).toBe("archived");
    expect((await store.getById(staleOtherPartition.id))!.status).toBe("archived");

    expect((await store.getById(fresh.id))!.status).toBe("active");
    expect((await store.getById(retrieved.id))!.status).toBe("active");
    expect((await store.getById(important.id))!.status).toBe("active");
    expect((await store.getById(atAgeBoundary.id))!.status).toBe("active");

    // Archiving is a status flip, never a delete: rows are still there and readable.
    for (const memory of [stale, fresh, retrieved, important, atAgeBoundary, alreadyArchived]) {
      expect((await store.getById(memory.id))!.isDeleted).toBe(0);
    }
    const includingArchived = await store.list({ namespace: "agent:user", includeArchived: true, limit: 100 });
    expect(includingArchived.total).toBe(6);
    expect(includingArchived.memories.filter((m) => m.status === "archived").map((m) => m.id).sort()).toEqual(
      [stale.id, alreadyArchived.id].sort()
    );

    // Idempotent: an archived row is not archived (or counted) again.
    expect(await archiveStale(store, { now: NOW })).toBe(0);
  });

  it("pages past the 100-row default of list()", async () => {
    const store = new InMemoryVectorStore();
    for (let i = 0; i < 510; i++) await add(store, { ageDays: 40, importance: 0.3 });
    expect(await archiveStale(store, { now: NOW })).toBe(510);
    const page = await store.list({ namespace: "agent:user", includeArchived: true, limit: 1 });
    expect(page.total).toBe(510);
    expect(page.memories[0]!.status).toBe("archived");
  });
});

describe("runDecay", () => {
  it("archives by default and keeps the destructive pass opt-in", async () => {
    const store = new InMemoryVectorStore();
    const minorOld = await add(store, { ageDays: 40, importance: 0.4 });
    const oldEpisodic = await add(store, { type: "episodic", ageDays: 100, importance: 0.2, strength: 0.2 });
    const youngWorking = await add(store, { type: "working", ageDays: 8, importance: 0.2 });

    // The old prune rule would have deleted the 100-day episodic row; the new default
    // only demotes it, and an 8-day working note is not stale yet.
    expect(await runDecay(store, { now: NOW })).toBe(2);
    expect((await store.getById(oldEpisodic.id))!.status).toBe("archived");
    expect((await store.getById(oldEpisodic.id))!.isDeleted).toBe(0);
    expect((await store.getById(minorOld.id))!.status).toBe("archived");
    expect((await store.getById(youngWorking.id))!.isDeleted).toBe(0);
    expect((await store.getById(youngWorking.id))!.status).toBe("active");

    // A scheduled caller invoking decay repeatedly must not keep "finding" work.
    expect(await runDecay(store, { now: NOW })).toBe(0);
  });

  it("with hard:true prunes on both importance and strength, then archives survivors", async () => {
    const store = new InMemoryVectorStore();
    const minorEpisodic = await add(store, { type: "episodic", ageDays: 100, importance: 0.2, strength: 0.2 });
    // Reinforced: high strength with low importance must survive the prune (R2).
    const reinforced = await add(store, { type: "episodic", ageDays: 100, importance: 0.2, strength: 0.9, lastUsedAt: NOW - DAY });
    const importantEpisodic = await add(store, { type: "episodic", ageDays: 100, importance: 0.6, strength: 0.6 });
    const oldWorking = await add(store, { type: "working", ageDays: 8, importance: 0.2, strength: 0.2 });

    expect(await runDecayDetailed(store, { now: NOW, hard: true })).toEqual({ archived: 0, pruned: 2 });
    expect((await store.getById(minorEpisodic.id))!.isDeleted).toBe(1);
    expect((await store.getById(oldWorking.id))!.isDeleted).toBe(1);
    expect((await store.getById(reinforced.id))!.isDeleted).toBe(0);
    expect((await store.getById(importantEpisodic.id))!.isDeleted).toBe(0);

    // `runDecay` keeps its number-shaped return for the CLI and the API route.
    const second = new InMemoryVectorStore();
    await add(second, { type: "working", ageDays: 8, importance: 0.2 });
    await add(second, { type: "episodic", ageDays: 100, importance: 0.2 });
    expect(typeof (await runDecay(second, { now: NOW, hard: true }))).toBe("number");
  });
});

describe("memory_stats", () => {
  it("reports archived and never-retrieved rows without changing total/byType", async () => {
    const service = new MemoryService({ store: new InMemoryVectorStore() });
    await service.init();
    const { namespaces } = resolveRequestScope({ agent: "stats-agent", scope: "private" });
    const ns = namespaces[0]!;

    const used = await service.save({ namespace: ns, type: "semantic", text: "A fact that gets retrieved.", importance: 0.5 });
    const neverUsed = await service.save({ namespace: ns, type: "semantic", text: "A fact nobody ever asks for.", importance: 0.5 });
    const archived = await service.save({ namespace: ns, type: "procedural", text: "An archived note.", importance: 0.4 });
    await service.store.reinforce([used.id]);
    await service.store.updateMeta(archived.id, { status: "archived" });

    const res = await callTool({ service, defaultAgent: "stats-agent" }, "memory_stats", { scope: "private" });
    const stats = res.structured as {
      perScope: Record<
        string,
        { total: number; byType: Record<string, number>; archived: number; archivedRatio: number; neverRetrieved: number; neverRetrievedRatio: number }
      >;
    };
    const entry = stats.perScope[ns]!;
    // Existing fields keep their old meaning: live rows only, by type.
    expect(entry.total).toBe(2);
    expect(entry.byType.semantic).toBe(2);
    expect(entry.byType.procedural).toBe(0);
    // New: archived is the half total() cannot see, over the full partition.
    expect(entry.archived).toBe(1);
    expect(entry.archivedRatio).toBeCloseTo(1 / 3);
    // New: of the live rows, one has never been retrieved.
    expect(entry.neverRetrieved).toBe(1);
    expect(entry.neverRetrievedRatio).toBeCloseTo(0.5);

    expect(res.text).toContain(`${ns}: 2 (+1 archived)`);
    expect(res.text).toContain("never retrieved 1/2");
  });
});
