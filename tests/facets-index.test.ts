/**
 * P4 (ADR-0046): the facet index (`memory_facets`) and the third candidate arm.
 *
 * Three things are pinned here, in the order the ADR argues them:
 *   1. The invariant — a row's facet postings count exactly the facet tags the row
 *      itself carries, on every path that can move facets (insert, insertMany,
 *      updateEmbedding, updateMeta's tags patch, supersede) and after the startup
 *      self-heal. This is the property P5's conflict window will stand on.
 *   2. The store capability answers "same entity, this partition" in both backends,
 *      whether or not the search flag is on — the flag owns retrieval, not the table.
 *   3. The retrieval arm changes nothing by default (`MEMORY_LINKS` off), and when
 *      on, joins rows into the pool under the SAME relevance gate as every other
 *      candidate — a facet hit with no lexical support is dropped exactly like any
 *      other zero-overlap row, and `w.entity` stays 0 in the breakdown.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
// vite's builtin list predates `node:sqlite`, so a static import is rewritten to a
// `require` at build time and fails at runtime — the same workaround the other
// suites that read the raw file use.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { SqliteVectorStore } from "../src/core/store/sqlite.js";
import type { VectorStore } from "../src/core/store/interface.js";
import { facetTagsOf, deriveFacets, rederiveTags } from "../src/core/write/facets.js";
import { MemoryService } from "../src/core/memoryService.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";

const NS = "p4:1";

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "om-facets-"));
  dirs.push(dir);
  return dir;
}
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The raw file, opened beside the store the way `tests/maintenance.test.ts` reads it. */
function raw(file: string): DatabaseSync {
  return new DatabaseSync(file);
}
function facetCount(db: DatabaseSync, id: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM memory_facets WHERE memory_id = ?`).get(id) as { n: number }).n;
}

// ---------------------------------------------------------------------------
// 1. The invariant, on the SQL store where the table actually lives.
// ---------------------------------------------------------------------------

describe("memory_facets invariant (sqlite)", () => {
  it("facet postings == the row's facet tags, through insert", async () => {
    const dir = tmpDir();
    const file = join(dir, "store.db");
    const store = new SqliteVectorStore(file);
    await store.init();
    try {
      const a = await store.insert(
        { namespace: NS, type: "semantic", text: "alpha", tags: ["entity:melanie", "topic:sqlite", "plain note"] },
        [0.1]
      );
      const b = await store.insert({ namespace: NS, type: "semantic", text: "beta with no tags at all" }, [0.2]);
      const db = raw(file);
      try {
        // Two facet tags -> two postings; the plain tag is nobody's join key.
        expect(facetCount(db, a.id)).toBe(facetTagsOf(a.tags).length);
        expect(facetCount(db, a.id)).toBe(2);
        // A zero-facet row keeps zero postings — "no facets" is a state, not a gap.
        expect(facetCount(db, b.id)).toBe(0);
        // The denormalized namespace answers "same entity, this partition" without a join.
        const ns = db.prepare(`SELECT DISTINCT namespace FROM memory_facets WHERE memory_id = ?`).get(a.id) as {
          namespace: string;
        };
        expect(ns.namespace).toBe(NS);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it("holds through insertMany, supersede, updateMeta's tags patch, and updateEmbedding", async () => {
    const dir = tmpDir();
    const file = join(dir, "store.db");
    const store = new SqliteVectorStore(file);
    await store.init();
    const db = raw(file);
    try {
      const expectInvariant = async (id: string): Promise<void> => {
        const row = (await store.getById(id))!;
        expect(facetCount(db, id)).toBe(facetTagsOf(row.tags).length);
      };

      // insertMany: the bulk path is not a second class of index consistency.
      const made = await store.insertMany([
        { input: { namespace: NS, type: "semantic", text: "one", tags: ["entity:ada", "note"] }, embedding: [0.1] },
        { input: { namespace: NS, type: "semantic", text: "two", tags: ["topic:sqlite"] }, embedding: [0.2] }
      ]);
      for (const m of made) await expectInvariant(m.id);

      // supersede: the successor inherits facets and commits with its own postings.
      const successor = await store.supersede(
        made[0]!.id,
        { namespace: NS, type: "semantic", text: "one, rewritten", tags: made[0]!.tags },
        [0.3]
      );
      await expectInvariant(successor.id);

      // updateMeta tags patch — the knowledge sync's relabel arrives exactly here,
      // and so will P5's conflict marker: the postings follow the column in the
      // same transaction, both directions.
      await store.updateMeta(successor.id, { tags: ["knowledge", "wiki:page"] });
      await expectInvariant(successor.id);
      expect(facetCount(db, successor.id)).toBe(0); // plain tags only -> the entity left the index
      await store.updateMeta(successor.id, { tags: ["entity:ada", "entity:grace"] });
      await expectInvariant(successor.id);
      expect(facetCount(db, successor.id)).toBe(2);

      // updateEmbedding: the facets follow the text — the row re-derives them from
      // what it now says, the caller's plain tags survive, one transaction. The
      // expected value is computed from the same function the store applies, so the
      // real assertion is the count above and what survives below.
      await store.updateEmbedding(successor.id, [0.4], "the `ada` section moved to src/core");
      await expectInvariant(successor.id);
      const after = (await store.getById(successor.id))!;
      expect(after.tags).toContain("entity:ada"); // stated by the new text again
      expect(after.tags).toEqual(rederiveTags(["entity:ada", "entity:grace"], "the `ada` section moved to src/core"));

      // Every row of the store, once, at the end: the invariant is global, not per path.
      for (const m of (await store.list({ namespace: NS, limit: 100 })).memories) {
        await expectInvariant(m.id);
      }
    } finally {
      db.close();
      store.close();
    }
  });

  it("self-heals rows whose postings are missing on the next open, and purge removes them", async () => {
    const dir = tmpDir();
    const file = join(dir, "store.db");
    const store = new SqliteVectorStore(file);
    await store.init();
    const kept = await store.insert({ namespace: NS, type: "semantic", text: "kept", tags: ["entity:ada"] }, [0.1]);
    const purged = await store.insert({ namespace: NS, type: "semantic", text: "purged", tags: ["entity:ada"] }, [0.2]);
    await store.deleteSoft(purged.id);
    await store.purgeDeleted!({ olderThanMs: -1 });
    store.close();

    // Simulate the pre-P4 store and a crashed heal: the rows exist, the postings do not.
    const setup = raw(file);
    setup.prepare(`DELETE FROM memory_facets WHERE memory_id = ?`).run(kept.id);
    setup.close();

    const reopened = new SqliteVectorStore(file);
    await reopened.init(); // the anti-join backfill runs on open
    try {
      const db = raw(file);
      try {
        const n = facetCount(db, kept.id);
        expect(n).toBe(1);
        const row = (await reopened.getById(kept.id))!;
        expect(n).toBe(facetTagsOf(row.tags).length);
        // A hard delete took its postings with it — a purged row joins nothing.
        expect(facetCount(db, purged.id)).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      reopened.close();
    }
  });

  it("zero-facet rows cannot shadow an injured row: the 5000 cap is on repairs, never on the scan", async () => {
    // The blind spot a small store can never show: a zero-facet row is a PERMANENT
    // member of the anti-join (it will never earn postings), so a scan-side LIMIT
    // would let 5000 of them — all ordered before the injured row here — occupy the
    // window on every open, and this row would never be repaired. The scan is
    // chunked to exhaustion; only repairs are capped.
    const dir = tmpDir();
    const file = join(dir, "store.db");
    const store = new SqliteVectorStore(file);
    await store.init();
    const fillers = Array.from({ length: 5100 }, (_, i) => ({
      input: { namespace: NS, type: "semantic" as const, text: `plain filler row ${i} with nothing to name`, tags: ["plain"] },
      embedding: [0.1]
    }));
    // The tagged row is inserted LAST, so its rowid sits behind every filler: 5,100
    // zero-facet anti-join members ahead of it, which is exactly the shadow a
    // scan-side LIMIT could never look past.
    await store.insertMany(fillers);
    const last = await store.insert(
      { namespace: NS, type: "semantic", text: "the `ada` note at the very end", tags: ["entity:ada"] },
      [0.2]
    );
    store.close();

    // Leave exactly one injured row: facets in tags, no postings.
    const setup = raw(file);
    const before = setup.prepare(`SELECT rowid FROM memories WHERE id = ?`).get(last.id) as { rowid: number };
    const zeroFacetAhead = setup
      .prepare(
        `SELECT COUNT(*) AS n FROM memories m
          WHERE m.rowid < ? AND NOT EXISTS (SELECT 1 FROM memory_facets f WHERE f.memory_id = m.id)`
      )
      .get(before.rowid) as { n: number };
    setup.prepare(`DELETE FROM memory_facets WHERE memory_id = ?`).run(last.id);
    setup.close();
    // The shadow this test exists for: more zero-facet members ahead than one
    // scan-side LIMIT would ever look past.
    expect(zeroFacetAhead.n).toBeGreaterThanOrEqual(5000);

    const reopened = new SqliteVectorStore(file);
    await reopened.init();
    try {
      const db = raw(file);
      try {
        const row = (await reopened.getById(last.id))!;
        expect(facetCount(db, last.id)).toBe(facetTagsOf(row.tags).length);
        expect(facetCount(db, last.id)).toBe(1);
        // And the fillers stay un-indexed: no facets means no postings. (`list`
        // orders newest-first, which is the repaired row — pick a filler by text.)
        const fillerId = (
          db.prepare(`SELECT id FROM memories WHERE text = ?`).get("plain filler row 0 with nothing to name") as {
            id: string;
          }
        ).id;
        expect(facetCount(db, fillerId)).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      reopened.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 2. The store capability, on both backends, independent of the search flag.
// ---------------------------------------------------------------------------

describe("facetCandidates store capability (both stores)", () => {
  const cases = (): { name: string; make: () => VectorStore; close: (s: VectorStore) => void }[] => [
    { name: "memory", make: () => new InMemoryVectorStore(), close: () => {} },
    {
      name: "sqlite",
      make: () => new SqliteVectorStore(join(tmpDir(), "store.db")),
      close: (s) => (s as SqliteVectorStore).close()
    }
  ];

  for (const c of cases()) {
    it(`[${c.name}] ranks by shared facets, applies the visibility filters, and needs no flag`, async () => {
      // Deliberately no MEMORY_LINKS in the environment: P5 consumes the store
      // capability, not the search arm's on/off state.
      delete process.env.MEMORY_LINKS;
      const store = c.make();
      await store.init();
      try {
        const ada = await store.insert(
          { namespace: NS, type: "semantic", text: "ada row", tags: ["entity:ada", "topic:sqlite"] },
          [0.1]
        );
        const mel = await store.insert({ namespace: NS, type: "semantic", text: "mel row", tags: ["entity:ada"] }, [0.2]);
        const other = await store.insert(
          { namespace: "p4:2", type: "semantic", text: "another partition", tags: ["entity:ada"] },
          [0.3]
        );
        const tomb = await store.insert({ namespace: NS, type: "semantic", text: "forgotten", tags: ["entity:ada"] }, [0.4]);
        await store.deleteSoft(tomb.id);

        // One shared facet: both live rows of this partition, tombstone and
        // other-partition rows excluded — the same candidate population search has.
        const one = await store.facetCandidates!({ namespace: NS, facets: ["entity:ada"], limit: 10 });
        expect(one.map((h) => h.memory.id).sort()).toEqual([ada.id, mel.id].sort());
        expect(one.find((h) => h.memory.id === ada.id)!.sharedFacets).toEqual(["entity:ada"]);

        // Two query facets: the row holding both leads, ties break by id.
        const two = await store.facetCandidates!({ namespace: NS, facets: ["entity:ada", "topic:sqlite"], limit: 10 });
        expect(two[0]!.memory.id).toBe(ada.id);
        expect(two[0]!.sharedFacets).toEqual(["entity:ada", "topic:sqlite"]);

        // An unknown facet is an empty answer, not an error; so is an empty list.
        expect(await store.facetCandidates!({ namespace: NS, facets: ["entity:nobody"], limit: 10 })).toEqual([]);
        expect(await store.facetCandidates!({ namespace: NS, facets: [], limit: 10 })).toEqual([]);
        expect(other).toBeTruthy();
      } finally {
        c.close(store);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 3. The retrieval arm: off by default, same gate when on.
// ---------------------------------------------------------------------------

/**
 * The A/B instrument: the facet arm's row is hidden from the two existing arms, so
 * any appearance of it is the third arm's doing, and its absence with the flag off
 * is the default-shape proof.
 */
class FacetArmStore extends InMemoryVectorStore {
  constructor(
    public hiddenId: string,
    public facetCalls: { armQueries: number }
  ) {
    super();
  }
  override async vectorSearch(opts: Parameters<InMemoryVectorStore["vectorSearch"]>[0]) {
    return (await super.vectorSearch(opts)).filter((h) => h.memory.id !== this.hiddenId);
  }
  override async lexicalCandidates(opts: Parameters<InMemoryVectorStore["lexicalCandidates"]>[0]) {
    return (await super.lexicalCandidates(opts)).filter((h) => h.memory.id !== this.hiddenId);
  }
  override async facetCandidates(opts: Parameters<InMemoryVectorStore["facetCandidates"]>[0]) {
    this.facetCalls.armQueries++;
    return super.facetCandidates(opts);
  }
}

describe("the third candidate arm", () => {
  const QUERY = "what does @melanie read";

  it("is off by default: the capability is never consulted and nothing changes", async () => {
    // The contract the arm joins on: the query derives its facets with the SAME
    // function the write path used to build the rows' tags.
    expect(deriveFacets(QUERY)).toContain("entity:melanie");

    delete process.env.MEMORY_LINKS;
    const calls = { armQueries: 0 };
    const store = new FacetArmStore("unused", calls);
    const svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
    await svc.init();
    try {
      const hit = await svc.save({
        namespace: NS,
        type: "semantic",
        text: "Melanie will read tonight",
        tags: ["entity:melanie"],
        importance: 0.5
      });
      store.hiddenId = hit.id;
      const r = await svc.search({ query: QUERY, namespace: NS, threshold: 0, k: 5 });
      expect(calls.armQueries).toBe(0);
      // The row is in the store but the two arms it is hidden from cannot surface it.
      expect(r.memories.map((m) => m.id)).not.toContain(hit.id);
    } finally {
      svc.close();
    }
  });

  it("MEMORY_LINKS=on joins a facet-reachable row, and it must still clear the gate", async () => {
    process.env.MEMORY_LINKS = "on";
    try {
      const calls = { armQueries: 0 };
      const store = new FacetArmStore("", calls);
      const svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
      await svc.init();
      try {
        // The target shares the query's facet AND its words — it clears `relevant`
        // (bm25 > 0) and the gate, so it is admitted exactly as a lexical candidate
        // would be. `threshold: 0` keeps every other door wide open on purpose: the
        // only thing standing between this row and the result must be the arms.
        const target = await svc.save({
          namespace: NS,
          type: "semantic",
          text: "Melanie will read tonight",
          tags: ["entity:melanie"],
          importance: 0.5
        });
        store.hiddenId = target.id;
        const r = await svc.search({ query: QUERY, namespace: NS, threshold: 0, k: 5, explain: true });
        expect(calls.armQueries).toBeGreaterThan(0);
        const item = r.memories.find((m) => m.id === target.id);
        expect(item).toBeTruthy();
        // The join is visible in the breakdown, and the weight is silent by default.
        expect(item!.explain!.entity).toBe(1);
        expect(item!.explain!.weighted.entity).toBe(0);
      } finally {
        svc.close();
      }
    } finally {
      delete process.env.MEMORY_LINKS;
    }
  });

  it("a facet hit with no lexical support stays out — no free channel", async () => {
    process.env.MEMORY_LINKS = "on";
    try {
      const calls = { armQueries: 0 };
      const store = new FacetArmStore("", calls);
      const svc = new MemoryService({ store, embedder: new HashEmbeddingProvider() });
      await svc.init();
      try {
        // Shares the entity facet, shares ZERO words with the question: the same
        // `relevant` floor that drops any zero-overlap row drops this one. The facet
        // arm reaches; it does not admit.
        const stranger = await svc.save({
          namespace: NS,
          type: "semantic",
          text: "borrowed a ladder from the neighbour",
          tags: ["entity:melanie"],
          importance: 0.5
        });
        store.hiddenId = stranger.id;
        const r = await svc.search({ query: QUERY, namespace: NS, threshold: 0, k: 5 });
        expect(calls.armQueries).toBeGreaterThan(0); // the arm ran and proposed it
        expect(r.memories.map((m) => m.id)).not.toContain(stranger.id);
      } finally {
        svc.close();
      }
    } finally {
      delete process.env.MEMORY_LINKS;
    }
  });
});
