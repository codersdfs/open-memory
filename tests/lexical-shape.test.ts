import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteVectorStore } from "../src/core/store/sqlite.js";

/**
 * ADR-0033: the lexical arm must be driven by the token index, not by the partition.
 *
 * These tests pin the *plan*, not just the answer. The old query returned the same
 * rows and the same scores in every one of these cases; it was simply 2,000x slower,
 * because SQLite chose `idx_memories_ns_deleted` as the driver and probed
 * `memory_terms` once per row in the partition. A result-only test cannot see that,
 * so it cannot protect against a future `JOIN` creeping back in.
 */

const DIM = 16;

function vec(seed: number): number[] {
  return Array.from({ length: DIM }, (_, i) => Math.sin(seed * 1.7 + i * 0.31));
}

describe("lexical candidate query shape", () => {
  let dir = "";
  let store: SqliteVectorStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "om-shape-"));
    store = new SqliteVectorStore(join(dir, "store.db"));
    await store.init();
    // The partition has to be big enough that scanning it is the *expensive* option,
    // otherwise SQLite picks the token index with or without `CROSS JOIN` and this
    // whole file passes vacuously. 4,000 rows is where the old `JOIN` shape tipped
    // over on this machine; each row carries ~90 terms so the postings table is big
    // too.
    const items = Array.from({ length: 4000 }, (_, i) => ({
      input: {
        namespace: "proj:one",
        type: "semantic" as const,
        text: `convention: the parser for module ${i % 4} is parser${i % 4}, row ${i}, marker ${"filler ".repeat(60)}`
      },
      embedding: vec(i)
    }));
    await store.insertMany!(items);
  }, 60_000);

  afterEach(() => {
    try { store.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  // `db` is private; the plan is the one thing the outside is allowed to inspect.
  function planOf(sql: string, params: unknown[]): string {
    const db = (store as unknown as { db: { prepare(sql: string): { all(...p: unknown[]): unknown[] } } }).db;
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
      .map((r) => r.detail)
      .join(" | ");
  }

  it("seeks the token index before touching memories", async () => {
    // The exact statement `lexicalCandidates` runs for its postings read. Kept in
    // sync by `postingsByToken`; if that method changes shape, this must change too,
    // which is the point — the plan is the contract.
    const plan = planOf(
      `SELECT t.memory_id AS id, t.token AS token, t.tf AS tf
         FROM memory_terms t
        CROSS JOIN memories m
        WHERE t.token IN (?) AND m.id = t.memory_id
          AND m.namespace = ? AND m.is_deleted = 0
          AND m.status NOT IN ('archived','draft')`,
      ["parser1", "proj:one"]
    );
    expect(plan).toMatch(/SEARCH (t|memory_terms) USING (COVERING )?INDEX sqlite_autoindex_memory_terms/);
    // The failure mode this pins: driving from the partition index and probing the
    // token index per row. `SEARCH m` may appear afterwards to fetch the row, but it
    // must never be the driver.
    expect(plan.indexOf("memory_terms")).toBeLessThan(plan.indexOf("m USING"));
  });

  it("answers with the rows the postings point at", async () => {
    const hits = await store.lexicalCandidates!({ namespace: "proj:one", query: "parser1 convention", limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.memory.text.includes("parser1"))).toBe(true);
    // Descending by lexical score, so the caller can rely on the order.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.lexicalScore).toBeGreaterThanOrEqual(hits[i]!.lexicalScore);
    }
  });

  it("scores a rare word above a word every row shares", async () => {
    // Σ tf/df: `convention` is in all 4,000 rows and `parser1` in a quarter of them,
    // so a row holding parser1 must outrank one that only holds the shared word.
    // The cap matters here: at this size a token in more than a third of the store is
    // dropped before it can win anything (MIN_ROWS_FOR_DF_CAP + DF_CAP_RATIO), which
    // is why asking for `convention` alone returns nothing rather than ranking by it.
    const both = await store.lexicalCandidates!({ namespace: "proj:one", query: "convention parser1", limit: 3 });
    const sharedOnly = await store.lexicalCandidates!({ namespace: "proj:one", query: "convention", limit: 1 });
    expect(both[0]!.lexicalScore).toBeGreaterThan(0);
    expect(sharedOnly).toHaveLength(0);
  });

  it("applies the namespace filter to postings, not to the whole store", async () => {
    // A token present in another partition must not pull that partition's rows in
    // through the join.
    await store.insertMany!([
      {
        input: { namespace: "proj:two", type: "semantic" as const, text: "convention: a note only proj:two holds, marker zz9" },
        embedding: vec(999)
      }
    ]);
    const hits = await store.lexicalCandidates!({ namespace: "proj:one", query: "zz9", limit: 5 });
    expect(hits).toHaveLength(0);
    const there = await store.lexicalCandidates!({ namespace: "proj:two", query: "zz9", limit: 5 });
    expect(there).toHaveLength(1);
  });
});
