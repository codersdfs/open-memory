import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteVectorStore } from "../src/core/store/sqlite.js";
import { PartitionCache, cacheBudgetBytes } from "../src/core/store/partitionCache.js";
import type { MemoryInput } from "../src/core/types.js";

const DIM = 16;

function dir(): string {
  return mkdtempSync(join(tmpdir(), "om-pcache-"));
}

function vec(seed: number): number[] {
  // Deterministic, unit-ish vectors that are far apart so top-k is unambiguous.
  return Array.from({ length: DIM }, (_, i) => Math.sin(seed * 1.7 + i * 0.31));
}

async function seeded(count: number, namespace = "proj:one"): Promise<SqliteVectorStore> {
  const store = new SqliteVectorStore(join(dir(), "m.db"));
  await store.init();
  const items: { input: MemoryInput; embedding: number[] }[] = [];
  for (let i = 0; i < count; i++) {
    items.push({
      input: { namespace, type: "semantic", text: `row ${i} parser budget`, source: "manual" },
      embedding: vec(i + 1),
    });
  }
  await store.insertMany(items);
  return store;
}

/** The cache is private state; the tests read its counters through it, not around it. */
function misses(store: SqliteVectorStore): number {
  return (store as unknown as { vectors: PartitionCache }).vectors.stats().misses;
}

/**
 * The cache is only acceptable because it cannot change an answer. These tests
 * exist to keep that true: every one of them compares a cached result against
 * what the store would have returned without it.
 */
describe("partition vector cache", () => {
  it("returns the same top-k whether or not the vectors were cached", async () => {
    const store = await seeded(80);
    const query = vec(3);
    // First call is cold (decodes from SQLite); second is warm (scored from memory).
    const cold = await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 10 });
    const warm = await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 10 });
    expect(warm.map((r) => r.memory.id)).toEqual(cold.map((r) => r.memory.id));
    for (let i = 0; i < warm.length; i++) {
      expect(warm[i].vectorScore).toBeCloseTo(cold[i].vectorScore, 6);
    }
    await store.close();
  });

  it("serves the same cosines the exact scan would have", async () => {
    const store = await seeded(64);
    const query = vec(9);
    const cold = await store.cosineSpread({ namespace: "proj:one", queryEmbedding: query });
    const warm = await store.cosineSpread({ namespace: "proj:one", queryEmbedding: query });
    expect(warm).toEqual(cold);
    expect(cold.count).toBe(64);
    await store.close();
  });

  it("never serves a vector that a rewrite replaced", async () => {
    const store = await seeded(40);
    // A query that points at row 5's vector, so that row is the top hit.
    const query = vec(6);
    const before = await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 3 });
    expect(before[0].vectorScore).toBeGreaterThan(before[1].vectorScore);
    const changedId = before[0].memory.id;

    // Replace that row's vector with one pointing the other way; it must leave the
    // top of the ranking immediately, not after the next cache eviction.
    const flipped = vec(6).map((v) => -v);
    await store.updateEmbedding(changedId, flipped, before[0].memory.text);

    const after = await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 3 });
    const hit = after.find((r) => r.memory.id === changedId);
    expect(hit?.vectorScore ?? -1).toBeLessThan(before[0].vectorScore - 0.1);
    await store.close();
  });

  it("drops a soft-deleted row out of the cached answer", async () => {
    const store = await seeded(40);
    const query = vec(6);
    const before = await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 5 });
    const gone = before[0].memory.id;
    await store.deleteSoft(gone);
    const after = await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 5 });
    expect(after.map((r) => r.memory.id)).not.toContain(gone);
    await store.close();
  });

  it("keeps partitions apart, so one namespace's rows cannot leak into another's", async () => {
    const store = await seeded(30, "proj:one");
    await store.insertMany([
      { input: { namespace: "proj:two", type: "semantic", text: "other row", source: "manual" }, embedding: vec(101) },
    ]);
    const query = vec(7);
    const one = await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 30 });
    const two = await store.vectorSearch({ namespace: "proj:two", queryEmbedding: query, limit: 30 });
    expect(one).toHaveLength(30);
    expect(two).toHaveLength(1);
    expect(one.map((r) => r.memory.id)).not.toContain(two[0].memory.id);
    await store.close();
  });

  /**
   * ADR-0034. A plain insert touches no cached partition, so it must not expire one.
   * The store used to bump a global version on every vector write, which made a save
   * followed by a search rebuild the whole decode: at 20,000 rows a `saveDetailed`
   * cost 125 ms instead of 13 ms, and the reconcile search inside every save was the
   * thing paying it. This is measured as "how many times did the cache miss", not as
   * wall time, so it cannot go flaky on a slow machine.
   */
  it("does not expire the partition when a new row is inserted", async () => {
    const store = await seeded(40);
    const query = vec(6);
    await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 5 });
    const before = misses(store);

    await store.insertMany([
      { input: { namespace: "proj:one", type: "semantic", text: "brand new row", source: "manual" }, embedding: vec(200) },
    ]);
    await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 5 });

    expect(misses(store)).toBe(before);
    await store.close();
  });

  /**
   * ADR-0036, and the reversal of ADR-0034's second half.
   *
   * A rewrite used to expire the partition it touched, which was correct but ruinous:
   * `reembed` rewrites every row of a partition in turn, so each row cost a full
   * decode — measured at 20,000 rows, one rewrite-plus-search took 109.8 ms p50 and
   * 40 rewrites produced 41 misses. A rewrite is the one change the writer can
   * describe completely (same id, same membership, new numbers), so the snapshot is
   * patched in place instead of thrown away: no miss, and the ranking still moves.
   */
  it("patches a rewritten row in place instead of expiring the partition", async () => {
    const store = await seeded(40);
    const query = vec(6);
    const first = await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 5 });
    const before = misses(store);
    const changedId = first[0].memory.id;

    // Point the row the other way. It has to leave the top of the ranking at once,
    // and doing so must not cost a decode.
    await store.updateEmbedding(changedId, vec(6).map((v) => -v), first[0].memory.text);
    const after = await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 5 });

    expect(misses(store)).toBe(before);
    const hit = after.find((r) => r.memory.id === changedId);
    expect(hit?.vectorScore ?? -1).toBeLessThan(first[0].vectorScore - 0.1);
    await store.close();
  });

  /**
   * ADR-0035, and the regression that motivated it. ADR-0034 stopped an insert from
   * expiring any partition, which was right about cost and wrong about correctness:
   * the entry holds the row set it decoded, so a row inserted afterwards was not in
   * it and could not be returned — a row whose vector equalled the query scored 1.0
   * through the exact scan and was invisible through the cache. The append path is
   * what makes the saving honest.
   */
  it("finds a row that was inserted after the partition was decoded", async () => {
    const store = await seeded(40);
    // A vector none of the seeded rows holds, so "score 1.0" identifies the new row
    // and not one of the 40 that happen to share its direction.
    const query = vec(1000);
    await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 5 });

    // A vector identical to the query: it must come back first, and it must come
    // back without the partition being decoded again (that is the whole point).
    const cold = misses(store);
    const inserted = await store.insertMany([
      { input: { namespace: "proj:one", type: "semantic", text: "the exact answer", source: "manual" }, embedding: query },
    ]);
    const after = await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 5 });

    expect(after[0].memory.id).toBe(inserted[0].id);
    expect(after[0].vectorScore).toBeCloseTo(1, 5);
    expect(misses(store)).toBe(cold);
    await store.close();
  });

  /** An insert into a *different* namespace must not be pulled into this partition. */
  it("does not append a row that the partition's filter excludes", async () => {
    const store = await seeded(20, "proj:one");
    const query = vec(1000);
    await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 5 });

    // Identical to the query, so if the append leaked across the filter this row
    // would outrank everything the partition actually holds.
    const elsewhere = await store.insertMany([
      { input: { namespace: "proj:two", type: "semantic", text: "elsewhere", source: "manual" }, embedding: query },
    ]);
    const after = await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 25 });

    expect(after).toHaveLength(20);
    expect(after.map((r) => r.memory.id)).not.toContain(elsewhere[0].id);
    await store.close();
  });

  /** A row archived by `updateMeta` leaves the candidate set, so the entry must go. */
  it("drops a row out of the cached answer when its status changes", async () => {
    const store = await seeded(20);
    const query = vec(6);
    const before = await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 5 });
    const archived = before[0].memory.id;

    await store.updateMeta(archived, { status: "archived" });
    const after = await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 5 });

    expect(after.map((r) => r.memory.id)).not.toContain(archived);
    await store.close();
  });

  /** A rewrite of a row no partition holds must not cost anyone a decode. */
  it("keeps the cache warm when the rewritten row belongs to another namespace", async () => {
    const store = await seeded(40, "proj:one");
    await store.insertMany([
      { input: { namespace: "proj:two", type: "semantic", text: "elsewhere", source: "manual" }, embedding: vec(300) },
    ]);
    const query = vec(1000);
    // Both partitions are decoded before the measurement, so the only thing that
    // can move the counter is the rewrite itself.
    await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 5 });
    const two = await store.vectorSearch({ namespace: "proj:two", queryEmbedding: query, limit: 1 });
    const before = misses(store);

    await store.updateEmbedding(two[0].memory.id, vec(301), two[0].memory.text);
    await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 5 });

    expect(misses(store)).toBe(before);
    await store.close();
  });

  /**
   * The case ADR-0036 exists for: `reembed` walks a partition row by row, rewriting
   * every vector. Each rewrite used to expire the partition, so the run cost one full
   * decode per row and got worse as the partition grew — O(rows^2) for a re-embed.
   * With the patch path it costs one O(dim) copy per row and no decode at all.
   */
  it("survives a reembed run without decoding once per row", async () => {
    const store = await seeded(40);
    const query = vec(1000);
    const warm = await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 40 });
    const before = misses(store);

    // Rewrite every row in turn, searching after each one, exactly as a reembed pass
    // plus its verifier would.
    for (let i = 0; i < warm.length; i++) {
      const row = warm[i];
      await store.updateEmbedding(row.memory.id, vec(500 + i), row.memory.text);
      await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 5 });
    }

    expect(misses(store)).toBe(before);
    await store.close();
  });

  /**
   * `prune` flips `is_deleted` on a whole set at once, and `is_deleted` is part of the
   * candidate WHERE, so the scan stops seeing those rows immediately. A decoded
   * partition holds them and is never told one by one, which is the same staleness
   * ADR-0035 fixed for single writes in its bulk form: measured with 40 rows all
   * pruned, the cached search still returned five memories while the exact scan
   * returned none.
   */
  it("drops rows that prune removed from the candidate set", async () => {
    const store = new SqliteVectorStore(join(dir(), "m.db"));
    await store.init();
    const items: { input: MemoryInput; embedding: number[] }[] = [];
    for (let i = 0; i < 40; i++) {
      items.push({
        // Importance 0.1 is below the 0.5 gate, and strength starts at importance and
        // is never raised here, so `prune` is guaranteed to match all 40.
        input: { namespace: "proj:one", type: "semantic", text: `row ${i} parser budget`, source: "manual", importance: 0.1 },
        embedding: vec(i + 1),
      });
    }
    await store.insertMany(items);
    const query = vec(6);
    const before = await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 5 });
    expect(before.length).toBe(5);

    const pruned = await store.prune({ olderThanMs: 0, maxImportance: 0.5 });
    expect(pruned).toBe(40);

    const after = await store.vectorSearch({ namespace: "proj:one", queryEmbedding: query, limit: 5 });
    expect(after).toHaveLength(0);
    await store.close();
  });
});

describe("PartitionCache", () => {
  const entry = (key: string, rows: number, dim = 8) => {
    const ids = Array.from({ length: rows }, (_, i) => `${key}-${i}`);
    return {
      key,
      flat: new Float32Array(rows * dim),
      dim,
      ids,
      norms: new Float64Array(rows),
      rows,
      index: new Map(ids.map((id, slot) => [id, slot] as const)),
      stale: false,
      seq: 0,
    };
  };

  it("is a no-op when the budget is zero, so MEMORY_VECTOR_CACHE_MB=off restores the scan", () => {
    const cache = new PartitionCache(0);
    expect(cache.enabled).toBe(false);
    cache.set(entry("a", 10));
    expect(cache.get("a")).toBeUndefined();
  });

  it("evicts the least recently used partition, not an arbitrary one", () => {
    // Room for exactly two 40-row entries, so a third has to evict exactly one and
    // the test can tell which: 40*8*4 flat + 40*8 norms + 40*48 ids each, doubled.
    const one = 40 * 8 * 4 + 40 * 8 + 40 * 48;
    const cache = new PartitionCache(one * 2);
    cache.set(entry("a", 40));
    cache.set(entry("b", 40));
    cache.get("a"); // a is now the most recently used, so b becomes the eviction target
    cache.set(entry("c", 40));
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.stats().evictions).toBe(1);
  });

  it("refuses a partition bigger than the whole budget instead of evicting everything", () => {
    const cache = new PartitionCache(2000);
    cache.set(entry("small", 5));
    cache.set(entry("huge", 1000));
    expect(cache.get("small")).toBeDefined();
    expect(cache.get("huge")).toBeUndefined();
  });

  it("marks an entry unusable when one of its rows is rewritten", () => {
    const cache = new PartitionCache(1024 * 1024);
    cache.set(entry("a", 20));
    expect(cache.dropRow("a-3")).toBe(true);
    expect(cache.get("a")?.stale).toBe(true);
    // A row from another partition must not damage this one.
    cache.set(entry("b", 20));
    expect(cache.dropRow("z-9")).toBe(false);
    expect(cache.get("b")?.stale).toBe(false);
  });

  /**
   * ADR-0035. The entry is a snapshot of a row set, so an insert makes it incomplete
   * rather than wrong; `absorb` closes the gap in place. This is the operation that
   * makes "an insert expires nothing" (ADR-0034) also mean "and the new row is
   * visible", which the version-number design got wrong.
   */
  it("absorbs new rows in place instead of making the caller decode again", () => {
    const cache = new PartitionCache(1024 * 1024);
    cache.set(entry("a", 4, 2));
    const absorbed = cache.absorb(
      "a",
      [
        { id: "a-new", vec: new Float32Array([1, 2]), norm: 1 },
        { id: "a-newer", vec: new Float32Array([3, 4]), norm: 1 },
      ],
      7
    );
    expect(absorbed).toBeDefined();
    expect(absorbed!.rows).toBe(6);
    expect(absorbed!.seq).toBe(7);
    expect(absorbed!.ids.slice(0, 6)).toEqual(["a-0", "a-1", "a-2", "a-3", "a-new", "a-newer"]);
    // The absorbed vector lands at the absorbed row's slot, not at the end of the
    // capacity-sized allocation.
    expect(Array.from(absorbed!.flat.subarray(4 * 2, 6 * 2))).toEqual([1, 2, 3, 4]);
    expect(absorbed!.index.get("a-newer")).toBe(5);
  });

  /**
   * A row the entry already holds keeps its slot and takes the new numbers. That is
   * the rewrite path (ADR-0036) as seen from the cache: no duplicate, no growth.
   */
  it("overwrites a row it already holds instead of appending a duplicate", () => {
    const cache = new PartitionCache(1024 * 1024);
    cache.set(entry("a", 4, 2));
    const absorbed = cache.absorb("a", [{ id: "a-1", vec: new Float32Array([7, 9]), norm: 3 }], 3);
    expect(absorbed).toBeDefined();
    expect(absorbed!.rows).toBe(4);
    expect(absorbed!.seq).toBe(3);
    expect(absorbed!.index.get("a-1")).toBe(1);
    expect(Array.from(absorbed!.flat.subarray(1 * 2, 2 * 2))).toEqual([7, 9]);
    expect(absorbed!.norms[1]).toBe(3);
  });

  it("refuses an absorb that would push the entry past the budget, leaving it intact", () => {
    // Room for a 4-row, dim-2 entry plus a little, not for one twice the size.
    const perRow = 2 * 4 + 8 + 48;
    const cache = new PartitionCache(perRow * 6);
    cache.set(entry("a", 4, 2));
    const grown = Array.from({ length: 8 }, (_, i) => ({
      id: `a-extra-${i}`,
      vec: new Float32Array([1, 2]),
      norm: 1,
    }));
    expect(cache.absorb("a", grown, 9)).toBeUndefined();
    const kept = cache.get("a")!;
    expect(kept.rows).toBe(4);
    expect(kept.seq).toBe(0);
  });

  it("advances the sequence without touching rows when nothing new belongs here", () => {
    const cache = new PartitionCache(1024 * 1024);
    cache.set(entry("a", 4, 2));
    const synced = cache.markSynced("a", 12);
    expect(synced?.rows).toBe(4);
    expect(synced?.seq).toBe(12);
    // A key that is gone must not resurrect: the caller decodes instead.
    expect(cache.markSynced("missing", 12)).toBeUndefined();
  });

  it("reads the budget from MEMORY_VECTOR_CACHE_MB, with off disabling it", () => {
    const prev = process.env.MEMORY_VECTOR_CACHE_MB;
    try {
      process.env.MEMORY_VECTOR_CACHE_MB = "off";
      expect(cacheBudgetBytes()).toBe(0);
      process.env.MEMORY_VECTOR_CACHE_MB = "128";
      expect(cacheBudgetBytes()).toBe(128 * 1024 * 1024);
      delete process.env.MEMORY_VECTOR_CACHE_MB;
      expect(cacheBudgetBytes()).toBe(64 * 1024 * 1024);
    } finally {
      if (prev === undefined) delete process.env.MEMORY_VECTOR_CACHE_MB;
      else process.env.MEMORY_VECTOR_CACHE_MB = prev;
    }
  });
});
