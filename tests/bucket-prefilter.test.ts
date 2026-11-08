import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { SqliteVectorStore } from "../src/core/store/sqlite.js";
import type { VectorStore, BucketSummaryInfo } from "../src/core/store/interface.js";
import type { EmbeddingProvider } from "../src/core/embedding/provider.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import { MemoryService } from "../src/core/memoryService.js";
import { reembedAll } from "../src/core/embedding/reembed.js";
import { startMaintenance } from "../src/core/lifecycle/maintenance.js";
import {
  BUCKET_REFRESH_RATIO,
  BUCKET_SMALL_TOTAL,
  bucketScanBound,
  pendingAfterRefresh,
  queryToCentroid,
} from "../src/core/store/buckets.js";
import { cosineSimilarity } from "../src/core/embedding/provider.js";

/**
 * P8 large half (ADR-0048): the bucket summaries and the vector-arm prefilter.
 *
 * The rules pinned here are the ones ADR-0029's failed index did not have, which is
 * why that attempt lost 56% of the vector top-5:
 *
 *  - the feature is OFF unless MEMORY_BUCKET_PREFILTER=on, and off costs nothing
 *    anywhere (no summary rows, no pending writes);
 *  - the scan set is decided from the DATA (a bucket with no summary is scanned in
 *    full, never skipped) and stale buckets are always scanned, so a summary can
 *    only cost time, never rows;
 *  - a fresh write is visible immediately (its bucket goes pending → full scan);
 *  - summaries never enter `memories`, `list` or a result set;
 *  - the prefilter refuses to filter when the summaries cannot discriminate (the
 *    hash-embedder guard);
 *  - the refresh thresholds: small buckets always, otherwise the OpenViking 10%
 *    ratio; a reembed drops every summary.
 *
 * Agreement is asserted as exact id equality per query on a clustered corpus; the
 * corpus-level ≥99% acceptance number is `bench/bucket-prefilter.mjs` (its output is
 * quoted in the ADR), not duplicated here.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* temp dir */ }
  }
});
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "om-buckets-"));
  dirs.push(dir);
  return dir;
}

const CLUSTERS = 12;
const DIM = 32;

/**
 * A deterministic clustered embedder: each `cluster:<n>` token maps to its own
 * unit basis vector, every text adds a small hash-derived jitter. Same-cluster
 * rows sit at cosine ~0.99, different clusters near 0 — the shape that makes
 * bucket summaries meaningful (and, per the spread gate, makes the hash embedder's
 * summaries meaningless instead).
 */
function clusterEmbedder(): EmbeddingProvider {
  const center = (c: number): number[] => {
    const v = new Array(DIM).fill(0);
    v[c % DIM] = 1;
    return v;
  };
  const one = (text: string): number[] => {
    const m = /cluster:(\d+)/.exec(text);
    const c = m ? Number(m[1]) % CLUSTERS : CLUSTERS;
    const v = center(c);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    for (let i = 0; i < DIM; i++) v[i] += (((h >>> i) & 7) - 3.5) / 100;
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map((x) => x / n);
  };
  return {
    name: "cluster-test",
    dim: DIM,
    model: null,
    async embed(text) { return one(text); },
    async embedBatch(texts) { return texts.map(one); }
  };
}

const NS = "buckets:main";
const PROJECTS = Array.from({ length: CLUSTERS }, (_, i) => `proj-${i}`);
const ROWS_PER_PROJECT = 24;

/** One cluster per project; the query names its cluster the way a real query names its topic. */
async function seedClusteredStore(store: VectorStore, embedder: EmbeddingProvider): Promise<void> {
  const items: { input: Parameters<VectorStore["insert"]>[0]; embedding: number[] }[] = [];
  for (let p = 0; p < PROJECTS.length; p++) {
    for (let i = 0; i < ROWS_PER_PROJECT; i++) {
      const text = `cluster:${p} fact ${p}-${i} about topic ${p}`;
      items.push({
        input: { namespace: NS, type: "semantic", text, project: PROJECTS[p]!, source: "bucket-test" },
        embedding: await embedder.embed(text)
      });
    }
  }
  if (typeof store.insertMany === "function") {
    await store.insertMany(items);
  } else {
    for (const it of items) await store.insert(it.input, it.embedding);
  }
}

/** The exact top-20, computed with the feature off — the definition the gate compares against. */
async function exactTop20(store: VectorStore, embedder: EmbeddingProvider, query: string): Promise<string[]> {
  const prev = process.env.MEMORY_BUCKET_PREFILTER;
  delete process.env.MEMORY_BUCKET_PREFILTER;
  try {
    const hits = await store.vectorSearch({
      namespace: NS,
      queryEmbedding: await embedder.embed(query),
      limit: 20,
      includeDeleted: false
    });
    return hits.map((h) => h.memory.id);
  } finally {
    restore(prev);
  }
}

function restore(prev: string | undefined): void {
  if (prev === undefined) delete process.env.MEMORY_BUCKET_PREFILTER;
  else process.env.MEMORY_BUCKET_PREFILTER = prev;
}

function withPrefilterOn(): void {
  process.env.MEMORY_BUCKET_PREFILTER = "on";
}

/** The prefiltered top-20 — the same call the retriever's vector arm makes. */
async function prefilteredTop20(store: VectorStore, embedder: EmbeddingProvider, query: string): Promise<string[]> {
  const hits = await store.vectorSearch({
    namespace: NS,
    queryEmbedding: await embedder.embed(query),
    limit: 20,
    includeDeleted: false
  });
  return hits.map((h) => h.memory.id);
}

async function summariesOf(store: VectorStore): Promise<BucketSummaryInfo[]> {
  if (typeof store.bucketSummaries !== "function") throw new Error("store has no bucketSummaries");
  return store.bucketSummaries();
}

describe("bucket prefilter — off by default (both stores)", () => {
  it.each([
    ["in memory", () => new InMemoryVectorStore()],
    ["sqlite", () => new SqliteVectorStore(join(tmpDir(), "off.db"))]
  ])("writes nothing and ranks identically when the flag is unset (%s)", async (_name, make) => {
    const prev = process.env.MEMORY_BUCKET_PREFILTER;
    delete process.env.MEMORY_BUCKET_PREFILTER;
    const store = make();
    try {
      await store.init();
      const embedder = clusterEmbedder();
      await seedClusteredStore(store, embedder);
      expect(await summariesOf(store)).toEqual([]);
      const hits = await store.vectorSearch({
        namespace: NS,
        queryEmbedding: await embedder.embed("cluster:3 fact 3-1 about topic 3"),
        limit: 20,
        includeDeleted: false
      });
      expect(hits.length).toBeGreaterThan(0);
      // A write with the feature off must not create pending rows either: the
      // default path's only cost is the write itself.
      expect(await summariesOf(store)).toEqual([]);
    } finally {
      await store.close();
      restore(prev);
    }
  });
});

describe("bucket prefilter — agreement with the exact scan (both stores)", () => {
  it.each([
    ["in memory", () => new InMemoryVectorStore()],
    ["sqlite", () => new SqliteVectorStore(join(tmpDir(), "agree.db"))]
  ])("returns the exact top-20 for clustered queries after a refresh (%s)", async (_name, make) => {
    const prev = process.env.MEMORY_BUCKET_PREFILTER;
    withPrefilterOn();
    const store = make();
    try {
      await store.init();
      const embedder = clusterEmbedder();
      await seedClusteredStore(store, embedder);
      // Not warmed yet: zero summaries, so the prefilter must fall back to the
      // exact scan — and still answer correctly.
      const before = await prefilteredTop20(store, embedder, "cluster:3 fact 3-1 about topic 3");
      expect(before).toEqual(await exactTop20(store, embedder, "cluster:3 fact 3-1 about topic 3"));

      const report = await store.refreshBucketSummaries!();
      expect(report.total).toBe(CLUSTERS);
      expect(report.refreshed).toBe(CLUSTERS); // small buckets refresh regardless of ratio
      expect(await summariesOf(store)).toHaveLength(CLUSTERS);

      // Every bucket summary describes the right width and carries an embedding.
      for (const s of await summariesOf(store)) {
        expect(s.dim).toBe(DIM);
        expect(s.hasEmbedding).toBe(true);
        expect(s.total).toBe(ROWS_PER_PROJECT);
        expect(s.pending).toBe(0);
      }

      // One query per cluster plus cross-cluster pairs: the union the scan set
      // must cover. Agreement here is exact equality — ids AND order.
      const queries = [
        ...PROJECTS.map((_, c) => `cluster:${c} fact ${c}-1 about topic ${c}`),
        "cluster:2 cluster:9 what changed in both topics",
        "cluster:5 or cluster:7 status of the two topics"
      ];
      for (const q of queries) {
        const exact = await exactTop20(store, embedder, q);
        const got = await prefilteredTop20(store, embedder, q);
        expect(got).toEqual(exact);
      }
    } finally {
      await store.close();
      restore(prev);
    }
  });
});

describe("bucket prefilter — fresh writes are never skipped (both stores)", () => {
  it.each([
    ["in memory", () => new InMemoryVectorStore()],
    ["sqlite", () => new SqliteVectorStore(join(tmpDir(), "fresh.db"))]
  ])("a row written after its bucket's refresh is found (%s)", async (_name, make) => {
    const prev = process.env.MEMORY_BUCKET_PREFILTER;
    withPrefilterOn();
    const store = make();
    try {
      await store.init();
      const embedder = clusterEmbedder();
      await seedClusteredStore(store, embedder);
      await store.refreshBucketSummaries!();

      const text = "cluster:4 brand-new fact written moments ago";
      await store.insert({ namespace: NS, type: "semantic", text, project: "proj-4", source: "bucket-test" }, await embedder.embed(text));

      // The write marked proj-4 pending; the prefilter scans it in full, so the
      // self-query must return the new row first — not after a refresh, now.
      const hits = await store.vectorSearch({
        namespace: NS,
        queryEmbedding: await embedder.embed(text),
        limit: 20,
        includeDeleted: false
      });
      expect(hits[0]!.memory.text).toBe(text);

      // And the pending marker is visible as such.
      const summary = (await summariesOf(store)).find((s) => s.project === "proj-4");
      expect(summary?.pending).toBeGreaterThan(0);
      expect(summary?.hasEmbedding).toBe(true); // the old summary is still there, just stale

      // The refresh folds the drift back: pending resets, and the report reflects
      // the threshold decision (small bucket → refreshed regardless of the ratio).
      const report = await store.refreshBucketSummaries!();
      expect(report.refreshed).toBe(CLUSTERS);
      expect((await summariesOf(store)).every((s) => s.pending === 0)).toBe(true);
    } finally {
      await store.close();
      restore(prev);
    }
  });
});

describe("bucket refresh — the ≥10% threshold (in memory, over the shared plan)", () => {
  it("skips a big bucket under the ratio and refreshes it at or above it", async () => {
    const prev = process.env.MEMORY_BUCKET_PREFILTER;
    withPrefilterOn();
    const store = new InMemoryVectorStore();
    try {
      await store.init();
      const embedder = clusterEmbedder();
      // One bucket over the small-bucket line, so the ratio rule is the only way
      // it refreshes.
      const texts: string[] = [];
      for (let i = 0; i < BUCKET_SMALL_TOTAL + 8; i++) {
        texts.push(`cluster:1 big-bucket fact ${i} about topic 1`);
      }
      for (const text of texts) {
        await store.insert({ namespace: NS, type: "semantic", text, project: "proj-big", source: "t" }, await embedder.embed(text));
      }
      await store.refreshBucketSummaries!();

      // One write: 1/(40) = 2.5% < 10% → skipped, pending keeps accumulating.
      await store.insert({ namespace: NS, type: "semantic", text: "cluster:1 one more fact", project: "proj-big", source: "t" }, await embedder.embed("cluster:1 one more fact"));
      let report = await store.refreshBucketSummaries!();
      expect(report.refreshed).toBe(0);
      expect(report.skipped).toBe(1);
      const ratioWrites = Math.ceil(BUCKET_REFRESH_RATIO * (BUCKET_SMALL_TOTAL + 9));
      for (let i = 1; i < ratioWrites; i++) {
        await store.insert({ namespace: NS, type: "semantic", text: `cluster:1 drift fact ${i}`, project: "proj-big", source: "t" }, await embedder.embed(`cluster:1 drift fact ${i}`));
      }
      report = await store.refreshBucketSummaries!();
      expect(report.refreshed).toBe(1);
      expect((await summariesOf(store)).find((s) => s.project === "proj-big")?.pending).toBe(0);
    } finally {
      await store.close();
      restore(prev);
    }
  });
});

describe("bucket prefilter — the summary is not a memory (both stores)", () => {
  it.each([
    ["in memory", () => new InMemoryVectorStore()],
    ["sqlite", () => new SqliteVectorStore(join(tmpDir(), "not-memory.db"))]
  ])("abstracts stay out of list() and out of search results (%s)", async (_name, make) => {
    const prev = process.env.MEMORY_BUCKET_PREFILTER;
    withPrefilterOn();
    const store = make();
    try {
      await store.init();
      const embedder = clusterEmbedder();
      await seedClusteredStore(store, embedder);
      const totalBefore = (await store.list({ namespace: NS, limit: 1 })).total;
      await store.refreshBucketSummaries!();
      // The refresh wrote summaries but no rows.
      expect((await store.list({ namespace: NS, limit: 1 })).total).toBe(totalBefore);
      // A search that asks for everything the store has still returns only rows —
      // every hit resolves to a real stored memory, which an abstract row would not.
      const hits = await store.vectorSearch({
        namespace: NS,
        queryEmbedding: await embedder.embed("cluster:3 about topic 3"),
        limit: 20,
        includeDeleted: false
      });
      expect(hits.length).toBe(20);
      for (const h of hits) expect(await store.getById(h.memory.id)).not.toBeNull();
    } finally {
      await store.close();
      restore(prev);
    }
  });
});

describe("bucket prefilter — the bound holds for any embedder (both stores)", () => {
  it.each([
    ["in memory", () => new InMemoryVectorStore()],
    ["sqlite", () => new SqliteVectorStore(join(tmpDir(), "hash.db"))]
  ])("hash embeddings, where the top-20 spans many buckets, still agree exactly (%s)", async (_name, make) => {
    const prev = process.env.MEMORY_BUCKET_PREFILTER;
    withPrefilterOn();
    const store = make();
    try {
      await store.init();
      const embedder = new HashEmbeddingProvider();
      await seedClusteredStore(store, embedder);
      await store.refreshBucketSummaries!();
      // Summaries exist and are fresh. Under the hash embedder the exact top-20 of
      // one of these queries spans several buckets while the centroids sit close
      // together — the shape that broke the first cut's top-b ranking (measured,
      // ADR-0048). The bound walk must agree with the exact scan anyway: the skip
      // rule is an upper bound, not a scent.
      expect((await summariesOf(store)).length).toBe(CLUSTERS);
      const queries = ["cluster:3 fact 3-1 about topic 3", "cluster:7 about topic 7"];
      for (const q of queries) {
        expect(await prefilteredTop20(store, embedder, q)).toEqual(await exactTop20(store, embedder, q));
      }
    } finally {
      await store.close();
      restore(prev);
    }
  });
});

describe("bucket prefilter — populations wider than the summaries (both stores)", () => {
  // The summaries describe the DEFAULT population only (`is_deleted = 0 AND
  // status = 'active'`). A search over a wider one — tombstones, archived, drafts,
  // an explicit status slice — ranks buckets by caps that do not cover those rows'
  // directions, so it must fall back to the exact scan (independent review,
  // 2026-11-08: without the guard an archived row was the exact scan's top-1 and
  // ABSENT from the prefiltered result, on both stores).
  const widerCases: [string, object][] = [
    ["includeArchived", { includeArchived: true }],
    ["includeDeleted", { includeDeleted: true }],
    ["explicit status=archived", { status: "archived" }]
  ];

  it.each([
    ["in memory", () => new InMemoryVectorStore()],
    ["sqlite", () => new SqliteVectorStore(join(tmpDir(), "wider.db"))]
  ])("falls back to the exact scan and still returns the outside rows (%s)", async (_name, make) => {
    const prev = process.env.MEMORY_BUCKET_PREFILTER;
    withPrefilterOn();
    const store = make();
    try {
      await store.init();
      const embedder = clusterEmbedder();
      await seedClusteredStore(store, embedder);
      await store.refreshBucketSummaries!();

      // Two rows the summaries' population does not cover, each the unambiguous
      // top-1 of its own self-query.
      const aText = "cluster:2 archived fact 2-99 about topic 2";
      const a = await store.insert({ namespace: NS, type: "semantic", text: aText, project: "proj-2", source: "t" }, await embedder.embed(aText));
      await store.updateMeta(a.id, { status: "archived" });
      const dText = "cluster:5 deleted fact 5-99 about topic 5";
      const d = await store.insert({ namespace: NS, type: "semantic", text: dText, project: "proj-5", source: "t" }, await embedder.embed(dText));
      await store.deleteSoft(d.id);

      const runTop20 = async (flag: boolean, text: string, extra: object): Promise<string[]> => {
        if (flag) process.env.MEMORY_BUCKET_PREFILTER = "on";
        else delete process.env.MEMORY_BUCKET_PREFILTER;
        try {
          const hits = await store.vectorSearch({
            namespace: NS,
            queryEmbedding: await embedder.embed(text),
            limit: 20,
            includeDeleted: false,
            ...extra
          });
          return hits.map((h) => h.memory.id);
        } finally {
          process.env.MEMORY_BUCKET_PREFILTER = "on";
        }
      };

      // Control: the DEFAULT-population search (the summaries' population) agrees
      // with its exact scan and does not contain the archived row — the population
      // difference is real, which is what makes the guard below load-bearing.
      const defaultExact = await runTop20(false, aText, {});
      const defaultPre = await runTop20(true, aText, {});
      expect(defaultPre).toEqual(defaultExact);
      expect(defaultExact).not.toContain(a.id);

      for (const [name, extra] of widerCases) {
        const text = name === "includeDeleted" ? dText : aText;
        const outsideId = name === "includeDeleted" ? d.id : a.id;
        const exact = await runTop20(false, text, extra);
        const pre = await runTop20(true, text, extra);
        // The wider exact scan genuinely reaches the outside row.
        expect(exact[0]).toBe(outsideId);
        // The prefiltered arm returns the same list: it took the exact path.
        expect(pre, `wider population "${name}" must not be bucket-filtered`).toEqual(exact);
      }
    } finally {
      await store.close();
      restore(prev);
    }
  });
});

describe("bucket invalidation — reembed and the sweeps", () => {
  it("reembed drops every summary, and the next search is still exact", async () => {
    const prev = process.env.MEMORY_BUCKET_PREFILTER;
    withPrefilterOn();
    const dir = tmpDir();
    const store = new SqliteVectorStore(join(dir, "reembed.db"));
    try {
      await store.init();
      const embedder = clusterEmbedder();
      await seedClusteredStore(store, embedder);
      await store.refreshBucketSummaries!();
      expect((await summariesOf(store)).length).toBe(CLUSTERS);

      const result = await reembedAll(store, embedder, {});
      expect(result.failed).toEqual([]);
      expect(await summariesOf(store)).toEqual([]);
      const hits = await store.vectorSearch({
        namespace: NS,
        queryEmbedding: await embedder.embed("cluster:3 fact 3-1 about topic 3"),
        limit: 20,
        includeDeleted: false
      });
      expect(hits.length).toBe(20);
    } finally {
      await store.close();
      restore(prev);
    }
  });

  it("renameProject and forgetProject(drop) strand no stale summary (sqlite)", async () => {
    const prev = process.env.MEMORY_BUCKET_PREFILTER;
    withPrefilterOn();
    const dir = tmpDir();
    const store = new SqliteVectorStore(join(dir, "sweep.db"));
    try {
      await store.init();
      const embedder = clusterEmbedder();
      await seedClusteredStore(store, embedder);
      await store.refreshBucketSummaries!();
      expect((await summariesOf(store)).length).toBe(CLUSTERS);

      await store.renameProject("proj-3", "proj-renamed");
      let names = (await summariesOf(store)).map((s) => s.project).sort();
      expect(names).not.toContain("proj-3");
      expect(names).not.toContain("proj-renamed"); // the move stranded both; the next refresh rebuilds
      await store.refreshBucketSummaries!();
      names = (await summariesOf(store)).map((s) => s.project).sort();
      expect(names).toContain("proj-renamed");

      await store.forgetProject("proj-4", { mode: "delete" });
      expect((await summariesOf(store)).map((s) => s.project)).not.toContain("proj-4");
    } finally {
      await store.close();
      restore(prev);
    }
  });
});

describe("bucket refresh wiring — the P2 maintenance pass", () => {
  it("runs the refresh after the decay on the scheduler's chain", async () => {
    const prev = process.env.MEMORY_BUCKET_PREFILTER;
    withPrefilterOn();
    const service = new MemoryService({ store: new InMemoryVectorStore(), embedder: clusterEmbedder() });
    const logs: string[] = [];
    try {
      await service.init();
      await seedClusteredStore(service.store, clusterEmbedder());
      const handle = startMaintenance(service.store, {
        env: { MEMORY_MAINTAIN_HOURS: "24" },
        intervalMs: 5,
        log: (l) => logs.push(l),
        refreshBuckets: () => service.refreshBucketSummaries()
      });
      // The startup catch-up is fired detached (an async getMeta precedes runOnce),
      // so give it a beat before waiting on the chain — the same settle the
      // maintenance tests use.
      await new Promise((r) => setTimeout(r, 100));
      await handle.untilIdle();
      expect((await summariesOf(service.store)).length).toBe(CLUSTERS);
      expect(logs.some((l) => l.includes("ai-memory buckets: refreshed 12"))).toBe(true);
      handle.stop();

      // And with the flag off the same hook reports "not running" and writes nothing.
      delete process.env.MEMORY_BUCKET_PREFILTER;
      expect(await service.refreshBucketSummaries()).toBeNull();
      expect((await summariesOf(service.store)).length).toBe(CLUSTERS); // unchanged
    } finally {
      service.close();
      restore(prev);
    }
  });
});

describe("the refresh's pending reset (review 2026-11-09)", () => {
  it("keeps the drift that accumulated between the geometry read and the summary write", async () => {
    const prev = process.env.MEMORY_BUCKET_PREFILTER;
    withPrefilterOn();
    const dir = tmpDir();
    const store = new SqliteVectorStore(join(dir, "race.db"));
    try {
      await store.init();
      const embedder = clusterEmbedder();
      await seedClusteredStore(store, embedder);
      await store.refreshBucketSummaries!();
      expect((await summariesOf(store)).every((s) => s.pending === 0)).toBe(true);

      // One write, then a refresh whose geometry for proj-3 is read BEFORE a second
      // write lands and whose summary write lands AFTER it — the retry-backoff window
      // the review found. The unconditional `pending = 0` the first cut used erased
      // the second write's marker here, and the bucket then trusted a cap without the
      // row. (The seam hands in the target: the window is per bucket.)
      const w1 = "cluster:3 fact written before the refresh pass about topic 3";
      await store.insert({ namespace: NS, type: "semantic", text: w1, project: "proj-3", source: "t" }, await embedder.embed(w1));
      const w2 = "cluster:3 fact written inside the race window about topic 3";
      const report = await store.refreshBucketSummaries!({
        beforeWrite: async (t) => {
          if (t.project === "proj-3") {
            await store.insert({ namespace: NS, type: "semantic", text: w2, project: "proj-3", source: "t" }, await embedder.embed(w2));
          }
        }
      });
      expect(report.refreshed).toBe(CLUSTERS);

      // The in-window write's marker SURVIVED the reset: the bucket is stale, not
      // freshly-trusted.
      const proj3 = (await summariesOf(store)).find((s) => s.project === "proj-3")!;
      expect(proj3.pending).toBe(1);
      // ...and the row the old cap cannot contain is still returned by the bucketed
      // search (stale bucket → full scan).
      const hits = await store.vectorSearch({ namespace: NS, queryEmbedding: await embedder.embed(w2), limit: 20, includeDeleted: false });
      expect(hits[0]!.memory.text).toBe(w2);
      // A pass with nothing in the window settles the drift back to zero.
      await store.refreshBucketSummaries!();
      expect((await summariesOf(store)).find((s) => s.project === "proj-3")!.pending).toBe(0);
    } finally {
      await store.close();
      restore(prev);
    }
  });

  it("writes in OTHER buckets' windows do not leak into this bucket's reset", async () => {
    const prev = process.env.MEMORY_BUCKET_PREFILTER;
    withPrefilterOn();
    const store = new SqliteVectorStore(join(tmpDir(), "race-scoped.db"));
    try {
      await store.init();
      const embedder = clusterEmbedder();
      await seedClusteredStore(store, embedder);
      await store.refreshBucketSummaries!();
      let n = 0;
      await store.refreshBucketSummaries!({
        beforeWrite: async (t) => {
          // One write inside each bucket's own window: each bucket's reset must
          // subtract only its own baseline, so every bucket ends at 1 (its own
          // in-window write), not at the total number of writes.
          const p = n++;
          const text = `cluster:${p} fact in-window ${p} about topic ${p}`;
          await store.insert({ namespace: NS, type: "semantic", text, project: t.project, source: "t" }, await embedder.embed(text));
        }
      });
      const sums = await summariesOf(store);
      expect(sums.every((s) => s.pending === 1)).toBe(true);
      expect(sums.reduce((acc, s) => acc + s.pending, 0)).toBe(CLUSTERS);
    } finally {
      await store.close();
      restore(prev);
    }
  });
});

describe("pendingAfterRefresh (the reset arithmetic the write transaction applies)", () => {
  it("subtracts the plan baseline, and treats any generation anomaly as drift", () => {
    // Same generation, no post-plan writes: reset to zero.
    expect(pendingAfterRefresh({ pending: 5, updatedAt: 100 }, { pending: 5, updatedAt: 100 })).toBe(0);
    // Same generation, three post-plan writes: keep exactly three.
    expect(pendingAfterRefresh({ pending: 5, updatedAt: 100 }, { pending: 8, updatedAt: 100 })).toBe(3);
    // No summary at plan time and none at write time: nothing to lose.
    expect(pendingAfterRefresh(null, null)).toBe(0);
    // No summary at plan time but a placeholder at write time: a post-plan write — drift.
    expect(pendingAfterRefresh(null, { pending: 1, updatedAt: 0 })).toBe(1);
    // The row vanished or was swept mid-refresh: drift, never trust the snapshot.
    expect(pendingAfterRefresh({ pending: 5, updatedAt: 100 }, null)).toBe(1);
    // Another refresher wrote the row (generation moved): drift.
    expect(pendingAfterRefresh({ pending: 5, updatedAt: 100 }, { pending: 9, updatedAt: 200 })).toBe(1);
    // Counter below the plan baseline can only mean drop-and-recreate: drift.
    expect(pendingAfterRefresh({ pending: 5, updatedAt: 100 }, { pending: 2, updatedAt: 100 })).toBe(1);
  });
});

describe("the bound itself", () => {
  it("covers the cap: inside the cap the bound is 1, outside it is cos(δ−θ)", () => {
    // The query direction inside the cap (a ≥ cosTheta): some row direction can
    // equal the query's — the bound is 1 and the bucket can never be skipped. This
    // is the case the first cut got wrong (a self-query scored 1.0 against a bound
    // of 0.9999), and the reason the case is pinned first.
    expect(bucketScanBound(0.9, 0.8)).toBe(1);
    expect(bucketScanBound(0.8, 0.8)).toBe(1);
    // cosTheta → 1 (all rows on the centroid direction): the bound collapses to the
    // query-to-centroid cosine — nothing in the bucket can score above it.
    expect(bucketScanBound(0.9, 1)).toBeCloseTo(0.9, 12);
    // Outside the cap: the worst row leans its complement fully into the query's —
    // cos(δ−θ) = a·cosTheta + √(1−a²)·√(1−cosTheta²).
    expect(bucketScanBound(0.5, 0.8)).toBeCloseTo(0.5 * 0.8 + Math.sqrt(1 - 0.25) * Math.sqrt(1 - 0.64), 12);
    // Out-of-range inputs clamp instead of producing NaN.
    expect(Number.isFinite(bucketScanBound(1.5, -0.5))).toBe(true);
  });

  it("never lets a real row exceed its bucket's bound (the exactness premise)", async () => {
    const prev = process.env.MEMORY_BUCKET_PREFILTER;
    withPrefilterOn();
    const store = new InMemoryVectorStore();
    try {
      await store.init();
      const embedder = clusterEmbedder();
      await seedClusteredStore(store, embedder);
      await store.refreshBucketSummaries!();
      // For every query and every bucket: max row cosine ≤ bound. This is the one
      // line the skip rule's correctness hangs on, so it is pinned against the real
      // summaries (read through the private mirror, which is exactly the SQL table's
      // shape) and the real rows.
      const queries = [
        "cluster:0 fact 0-2 about topic 0",
        "cluster:3 fact 3-1 about topic 3",
        "cluster:7 about topic 7",
        "cluster:2 cluster:9 what changed in both topics"
      ];
      const rows = [...(store as unknown as { map: Map<string, { project: string | null; embedding: number[]; isDeleted: number; status: string }> }).map.values()].filter(
        (m) => m.isDeleted === 0 && m.status === "active"
      );
      expect(rows.length).toBe(CLUSTERS * ROWS_PER_PROJECT);
      for (const qtext of queries) {
        const q = await embedder.embed(qtext);
        for (const s of (store as unknown as { buckets: Map<string, { centroid: number[]; norm: number; cosTheta: number }> }).buckets.values()) {
          const bound = bucketScanBound(queryToCentroid(q, s.centroid!, s.norm), s.cosTheta);
          for (const m of rows) {
            if ((m.project ?? "") !== (s.projectKey === "" ? null : s.projectKey)) continue;
            expect(cosineSimilarity(q, m.embedding)).toBeLessThanOrEqual(bound + 1e-9);
          }
        }
      }
    } finally {
      await store.close();
      restore(prev);
    }
  });
});
