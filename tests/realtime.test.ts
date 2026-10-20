import { describe, it, expect } from "vitest";
import {
  BENCH_OPS,
  SEARCH_BUDGET,
  bucketSeries,
  buildCorpus,
  buildQueries,
  percentile,
  rankOf,
  rng,
  summarizeRun,
  type OpSample
} from "../src/bench/realtime.js";

/**
 * The real-time benchmark is only useful if its numbers mean what they say. These
 * tests pin the measurement rules, not the machine: percentile semantics, per-second
 * bucketing, the recall/stall/token accounting, and a corpus whose gold label cannot
 * be lost (the marker is in the text, so a miss is a retrieval miss).
 */

const sample = (over: Partial<OpSample>): OpSample => ({
  op: "search",
  at: 0,
  ms: 10,
  ok: true,
  ...over
});

describe("percentile", () => {
  it("is nearest-rank, so p99 of a short run is the slowest request", () => {
    const values = [1, 2, 3, 4];
    expect(percentile(values, 0.5)).toBe(2);
    expect(percentile(values, 0.95)).toBe(4);
    expect(percentile(values, 0.99)).toBe(4);
    // interpolating would have reported 3.97 for p99 of four points
    expect(percentile([10, 20, 30, 40, 50], 0.5)).toBe(30);
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([7], 0)).toBe(7);
  });
});

describe("bucketSeries", () => {
  it("keeps the time series, because an average hides a stall", () => {
    const samples = [
      sample({ at: 100, ms: 5 }),
      sample({ at: 900, ms: 15 }),
      sample({ at: 1200, ms: 400, ok: false, error: "boom" }),
      sample({ at: 2900, ms: 8 })
    ];
    const series = bucketSeries(samples, 3000);
    expect(series).toHaveLength(3);
    expect(series[0]!.count).toBe(2);
    expect(series[0]!.p50).toBe(5);
    expect(series[1]!.count).toBe(1);
    expect(series[1]!.errors).toBe(1);
    expect(series[1]!.p95).toBe(400);
    expect(series[2]!.count).toBe(1);
    expect(series[2]!.rate).toBe(1);
  });

  it("clamps samples past the reported duration into the last second", () => {
    const series = bucketSeries([sample({ at: 5000 })], 2000);
    expect(series).toHaveLength(2);
    expect(series[1]!.count).toBe(1);
  });
});

describe("summarizeRun", () => {
  it("separates throughput, stall, errors and recall", () => {
    const samples = [
      sample({ op: "search", at: 0, ms: 10, rank: 1, tokensUsed: 300 }),
      sample({ op: "search", at: 200, ms: 20, rank: 3, tokensUsed: 820 }),
      sample({ op: "search", at: 900, ms: 30, rank: null, tokensUsed: 100 }),
      sample({ op: "write", at: 1000, ms: 5 }),
      sample({ op: "sync", at: 1000, ms: 50, ok: false, error: "index locked" })
    ];
    const summary = summarizeRun(samples, { durationMs: 2000, issued: 6, dropped: 1 });

    expect(summary.completed).toBe(5);
    expect(summary.issued).toBe(6);
    expect(summary.dropped).toBe(1);
    expect(summary.throughput).toBe(2.5);
    expect(summary.errors).toBe(1);
    expect(summary.errorRate).toBe(0.2);
    // the largest gap between completions is the stall a caller would feel
    expect(summary.stallMs).toBe(700);
    expect(summary.ops.search!.count).toBe(3);
    expect(summary.ops.search!.max).toBe(30);
    expect(summary.ops.sync!.errors).toBe(1);

    expect(summary.quality.searches).toBe(3);
    expect(summary.quality.recall1).toBeCloseTo(1 / 3, 4);
    expect(summary.quality.recall5).toBeCloseTo(2 / 3, 4);
    expect(summary.quality.mrr).toBeCloseTo((1 + 1 / 3 + 0) / 3, 4);
    expect(summary.quality.empty).toBe(1);
    expect(summary.quality.tokensMean).toBe(407);
    // 820 > the 800-token budget: an overrun is a product bug, counted separately
    expect(summary.quality.budgetOverBudget).toBe(1);
  });

  it("splits recall by query shape instead of hiding one behind the average", () => {
    const summary = summarizeRun(
      [
        sample({ mode: "bare", rank: 1 }),
        sample({ mode: "noisy", rank: 3 }),
        sample({ mode: "noisy", rank: null }),
        sample({ mode: "cjk", rank: null }),
        sample({ mode: "cjk", rank: null })
      ],
      { durationMs: 1000, issued: 5, dropped: 0 }
    );
    expect(summary.quality.byMode.bare!.recall5).toBe(1);
    expect(summary.quality.byMode.noisy!.recall5).toBe(0.5);
    expect(summary.quality.byMode.cjk!.recall5).toBe(0);
    expect(summary.quality.byMode.cjk!.empty).toBe(2);
    // pooled recall: the average that would have hidden the CJK loss
    expect(summary.quality.recall5).toBe(0.4);
  });

  it("ignores failed searches when scoring quality", () => {    const summary = summarizeRun(
      [sample({ rank: 1, ok: false, error: "timeout" }), sample({ rank: 1 })],
      { durationMs: 1000, issued: 2, dropped: 0 }
    );
    expect(summary.quality.searches).toBe(1);
    expect(summary.quality.recall1).toBe(1);
  });

  it("survives an empty run without dividing by zero", () => {
    const summary = summarizeRun([], { durationMs: 0, issued: 0, dropped: 0 });
    expect(summary.throughput).toBe(0);
    expect(summary.errorRate).toBe(0);
    expect(summary.quality.recall5).toBe(0);
    expect(Object.keys(summary.ops)).toEqual([]);
  });
});

describe("corpus and queries", () => {
  it("is deterministic for a seed and different across seeds", () => {
    const a = buildCorpus({ facts: 12, projects: 3, seed: 7 });
    const b = buildCorpus({ facts: 12, projects: 3, seed: 7 });
    const c = buildCorpus({ facts: 12, projects: 3, seed: 8 });
    expect(a).toEqual(b);
    expect(a.map((f) => f.text)).not.toEqual(c.map((f) => f.text));
  });

  it("carries one unique marker per fact, inside the text", () => {
    const corpus = buildCorpus({ facts: 40, projects: 4, seed: 7 });
    expect(new Set(corpus.map((f) => f.token)).size).toBe(40);
    for (const fact of corpus) expect(fact.text).toContain(fact.token);
    expect(corpus.every((f) => f.project.startsWith("bench-project-"))).toBe(true);
    // durable kinds: the ones the brief and decay treat specially
    expect(new Set(corpus.map((f) => f.kind))).toEqual(new Set(["convention", "decision", "gotcha"]));
  });

  it("asks about a real fact in three shapes, all carrying the marker", () => {
    const corpus = buildCorpus({ facts: 30, projects: 3, seed: 7 });
    const queries = buildQueries(corpus, { queries: 9, seed: 11 });
    const tokens = new Set(corpus.map((f) => f.token));
    expect(queries).toHaveLength(9);
    expect(new Set(queries.map((q) => q.mode))).toEqual(new Set(["bare", "noisy", "cjk"]));
    for (const q of queries) {
      expect(tokens.has(q.token)).toBe(true);
      expect(q.query).toContain(q.token);
    }
    expect(queries).toEqual(buildQueries(corpus, { queries: 9, seed: 11 }));
  });

  it("ranks by the marker, so a reconciled id cannot fake a hit", () => {
    expect(rankOf(["unrelated", "the answer is zq1042 here"], "zq1042")).toBe(2);
    expect(rankOf([], "zq1042")).toBeNull();
    expect(rankOf(["zq1042"], "zq1042")).toBe(1);
  });

  it("pins the operation set and the budget the run is judged against", () => {
    expect(BENCH_OPS).toContain("search");
    expect(BENCH_OPS).toContain("sync");
    expect(SEARCH_BUDGET).toBe(800);
  });
});

describe("rng", () => {
  it("is reproducible and stays in [0,1)", () => {
    const a = rng(42);
    const b = rng(42);
    for (let i = 0; i < 5; i++) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
