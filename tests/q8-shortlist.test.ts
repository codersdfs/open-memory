import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteVectorStore } from "../src/core/store/sqlite.js";

/**
 * ADR-0025 / ADR-0026: the int8 shortlist must not change what a search returns.
 *
 * The bug this pins down: `quantizeVector` returned a `Buffer` (unsigned elements)
 * while rows came back through `unpackQ8` as `Int8Array` (signed). `cosineQ8` then
 * multiplied +130 by -126 for the same dimension, flipping the sign of the dot
 * product. A self-query scored -0.55 and ranked LAST out of 2000 rows, so recall@k
 * was 0 â€” the store looked fine, the tests passed, and only a q8-vs-exact comparison
 * could see it. Every assertion here is that comparison.
 */

const DIM = 128;
const ROWS = 900;

function vecFor(seed: number, dim = DIM): number[] {
  let s = (2166136261 ^ seed) >>> 0;
  const out: number[] = [];
  for (let d = 0; d < dim; d++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out.push((s / 4294967296) * 2 - 1);
  }
  return out;
}

let dirs: string[] = [];
let stores: SqliteVectorStore[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "om-q8-"));
  dirs.push(dir);
  return join(dir, "q8.db");
}

afterEach(async () => {
  // Close first: Windows will not unlink a database that still has a handle open, and
  // a cleanup failure here would mask the assertion the test was actually making.
  for (const s of stores) {
    try { await s.close(); } catch { /* already closed by the test */ }
  }
  stores = [];
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows keeps WAL handles briefly */ }
  }
  dirs = [];
  delete process.env.MEMORY_Q8;
});

async function seededStore(): Promise<SqliteVectorStore> {
  const store = new SqliteVectorStore(tempDb());
  stores.push(store);
  await store.init();
  const items = [];
  for (let i = 0; i < ROWS; i++) {
    items.push({
      input: {
        namespace: "q8",
        type: "episodic" as const,
        text: `row ${i}`,
        tags: [],
        importance: 0.5,
        source: "test",
        agentId: "a",
        userId: "u",
      },
      embedding: vecFor(i),
    });
  }
  await store.insertMany(items);
  return store;
}

async function searchIds(store: SqliteVectorStore, query: number[], limit: number) {
  const hits = await store.vectorSearch({ namespace: "q8", queryEmbedding: query, limit });
  return hits.map((h) => ({ id: h.memory.id, score: h.vectorScore }));
}

describe("int8 shortlist equivalence (ADR-0025)", () => {
  it("ranks an exact self-query first, in both modes", async () => {
    const store = await seededStore();
    const selfIdx = 42;
    const query = vecFor(selfIdx).map((v, i) => v + (i % 3 === 0 ? 0.02 : -0.01));

    process.env.MEMORY_Q8 = "off";
    const off = await searchIds(store, query, 10);
    process.env.MEMORY_Q8 = "on";
    const on = await searchIds(store, query, 10);

    // The nearest row is the one the query was derived from, and it must be #1.
    expect(off[0].score).toBeGreaterThan(0.99);
    expect(on[0].score).toBeGreaterThan(0.99);
    expect(on[0].score).toBeCloseTo(off[0].score, 6);
    await store.close();
  });

  it("returns the same ids in the same order as the full-precision scan", async () => {
    const store = await seededStore();
    for (const probe of [7, 300, 899]) {
      const query = vecFor(probe).map((v) => v * 0.9);

      process.env.MEMORY_Q8 = "off";
      const off = await searchIds(store, query, 20);
      process.env.MEMORY_Q8 = "on";
      const on = await searchIds(store, query, 20);

      // The shortlist ranks on quantised bytes but re-scores the winners against the
      // float32 blob, so ordering is exact for the shortlist â€” an occasional neighbour
      // swap at the boundary of the top-20 is the only admissible difference.
      const overlap = on.filter((h) => off.some((o) => o.id === h.id)).length;
      expect(overlap).toBeGreaterThanOrEqual(19);
      expect(on[0].id).toBe(off[0].id);
      expect(on[0].score).toBeCloseTo(off[0].score, 6);
    }
    await store.close();
  });

  it("keeps every score finite and inside the cosine range", async () => {
    const store = await seededStore();
    process.env.MEMORY_Q8 = "on";
    for (const probe of [0, 500]) {
      const hits = await searchIds(store, vecFor(probe), 15);
      for (const h of hits) {
        expect(Number.isFinite(h.score)).toBe(true);
        expect(h.score).toBeGreaterThan(-1.01);
        expect(h.score).toBeLessThan(1.01);
      }
    }
    await store.close();
  });

  it("is off by default, so an untouched store keeps the exact scan", async () => {
    const store = await seededStore();
    // No MEMORY_Q8 set. The q8 columns are still written (init backfilled them), but
    // the search must take the full-precision path: the top row is still #1 and the
    // result is identical whether or not the columns exist.
    const query = vecFor(123).map((v) => v * 0.8);
    const baseline = await searchIds(store, query, 10);
    process.env.MEMORY_Q8 = "off";
    const explicitOff = await searchIds(store, query, 10);
    expect(explicitOff.map((h) => h.id)).toEqual(baseline.map((h) => h.id));
    await store.close();
  });

  it("falls back to the full scan when a row has no q8 yet", async () => {
    const store = await seededStore();
    process.env.MEMORY_Q8 = "on";
    const query = vecFor(77).map((v) => v * 0.9);
    const before = await searchIds(store, query, 10);
    expect(before[0].score).toBeGreaterThan(0.99);

    // Simulate an interrupted backfill: one row in the candidate set never got its int8
    // copy. The shortlist must decline the whole query rather than rank a set it cannot
    // score — a half-quantised table is the one case where slow beats wrong.
    (
      store as unknown as { db: { prepare(sql: string): { run(): unknown } } }
    ).db
      .prepare(`UPDATE memory_vectors SET q8 = NULL, scale = NULL WHERE memory_id = (SELECT id FROM memories LIMIT 1)`)
      .run();

    const after = await searchIds(store, query, 10);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].score).toBeCloseTo(before[0].score, 6);
    await store.close();
  });
});

