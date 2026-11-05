import { describe, it, expect } from "vitest";
import {
  BENCH_OPS,
  QUERY_MODES,
  SEARCH_BUDGET,
  bucketSeries,
  buildCorpus,
  buildQueries,
  paraphrasePhrase,
  paraphrasePhraseZh,
  percentile,
  rankOf,
  rng,
  sigPhrase,
  summarizeRun,
  type BenchFact,
  type BenchQuery,
  type OpSample
} from "../src/bench/realtime.js";

/**
 * The real-time benchmark is only useful if its numbers mean what they say. These
 * tests pin the measurement rules, not the machine: percentile semantics, per-second
 * bucketing, the recall/stall/token accounting, and a corpus whose gold label cannot
 * be lost (the marker is in the text, so a miss is a retrieval miss).
 */

/**
 * The pre-`semantic` query generator, verbatim, so the test can prove the three
 * original shapes are unchanged rather than assuming it. If `buildQueries` ever
 * drifts for `bare`/`noisy`/`cjk`, this comparison is what fails.
 */
function buildQueriesWithoutSemantic(corpus: BenchFact[], queries: number, seed: number): BenchQuery[] {
  const random = rng(seed);
  const shapeRandom = rng(seed ^ 0x5eed);
  const NOISE = ["how", "do", "we", "configure", "the", "pipeline", "for", "this", "project", "today"];
  const out: BenchQuery[] = [];
  for (let i = 0; i < queries; i++) {
    const fact = corpus[Math.floor(random() * corpus.length)]!;
    const mode: BenchQuery["mode"] = i % 3 === 0 ? "bare" : i % 3 === 1 ? "noisy" : "cjk";
    const noise = [0, 1, 2, 3, 4, 5].map(() => NOISE[Math.floor(shapeRandom() * NOISE.length)]!).join(" ");
    const query =
      mode === "bare"
        ? fact.token
        : mode === "noisy"
          ? `${noise} ${fact.token} ${fact.project}`
          : `${fact.project} 里的 ${fact.token} 是怎么配置的`;
    out.push({ query, token: fact.token, mode });
  }
  return out;
}

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
    // Three queries is exactly one bare/noisy/cjk rotation, so the semantic shape
    // (every fourth) does not appear and this test keeps measuring what it always did.
    const queries = buildQueries(corpus, { queries: 3, seed: 11 });
    const tokens = new Set(corpus.map((f) => f.token));
    expect(queries).toHaveLength(3);
    expect(new Set(queries.map((q) => q.mode))).toEqual(new Set(["bare", "noisy", "cjk"]));
    for (const q of queries) {
      expect(tokens.has(q.token)).toBe(true);
      expect(q.query).toContain(q.token);
    }
    expect(queries).toEqual(buildQueries(corpus, { queries: 3, seed: 11 }));
  });

  it("adds a marker-free semantic shape without touching the other three", () => {
    const corpus = buildCorpus({ facts: 40, projects: 4, seed: 7 });
    const mix = buildQueries(corpus, { queries: 40, seed: 11 });
    expect(new Set(mix.map((q) => q.mode))).toEqual(new Set(QUERY_MODES));

    const tokens = new Set(corpus.map((f) => f.token));
    const semantic = mix.filter((q) => q.mode === "semantic");
    expect(semantic.length).toBe(10);
    for (const q of semantic) {
      // The whole point: nothing the term index can look up.
      expect(tokens.has(q.token)).toBe(true);
      expect(q.query.includes(q.token)).toBe(false);
      expect(q.query).not.toMatch(/zq\d+/);
    }

    // Every fourth slot is semantic, and it draws nothing from the generator the first
    // three slots use. On the same index the non-semantic queries come out identical,
    // so bare/noisy/cjk stay comparable to every reading taken before this mode existed.
    const before = buildQueriesWithoutSemantic(corpus, 40, 11);
    const shape = (i: number) => (i % 4 === 3 ? "semantic" : i % 3 === 0 ? "bare" : i % 3 === 1 ? "noisy" : "cjk");
    const nonSemantic = mix.filter((q) => q.mode !== "semantic");
    const runnable = before.filter((_, i) => shape(i) !== "semantic");
    expect(nonSemantic).toEqual(runnable);
  });

  it("makes the semantic gold row identifiable by its own signature phrase", () => {
    const corpus = buildCorpus({ facts: 400, projects: 4, seed: 7 });
    const byToken = new Map(corpus.map((f) => [f.token, f]));
    const semantic = buildQueries(corpus, { queries: 80, seed: 11, projects: 4 }).filter((q) => q.mode === "semantic");

    // Spans both scripts, so project ids are compared after stripping Chinese
    // particles: `bench-project-2 的` must still read as `bench-project-2`.
    const terms = (s: string) => [...new Set(s.toLowerCase().replace(/[的（）；，。]/g, " ").split(/\s+/).filter(Boolean))];

    for (const q of semantic) {
      const gold = byToken.get(q.token)!;
      const inChinese = gold.text.startsWith("项目");
      const zh = inChinese ? paraphrasePhraseZh(gold) : paraphrasePhrase(gold);
      const en = paraphrasePhrase(gold);

      // 1. The corpus holds the full phrase, the question holds the paraphrase of it —
      //    near enough for a cosine, far enough that no exact match answers it.
      const full = sigPhrase(gold);
      expect(gold.text).toContain(full);
      expect(q.query).not.toContain(full);
      expect(q.query).toContain(inChinese ? zh : en);
      // Both signature words are in the question either way, which is what a cosine
      // needs to pull the row to the top of its phrase group. Chinese inherits the
      // English word beside a Chinese measure word ("的 late"), hence the
      // substring test there.
      for (const word of gold.sig) {
        expect(inChinese ? q.query.replace(/[的（）]/g, " ") : q.query).toContain(word);
      }
      // 2. The full phrase is one row's own: matched with the corpus's framing
      //    (`a … case` / （…）), because `fanout partitions i` is a substring of `iii`.
      const framed = new RegExp(`(?:a ${full} case|（${full}）)`);
      expect(corpus.filter((f) => framed.test(f.text)).map((f) => f.token)).toEqual([gold.token]);
      // 3. The phrase minus its `#n` ordinal still names a whole clause group — 12-17
      //    rows for a convention, ~90 for a gotcha — so even the phrase's subject is
      //    not one row's own, and a question that only paraphrased it would be ambiguous.
      const words = full.split(" ");
      const subject = inChinese ? `${words[0]} ${words[1]}` : words.slice(0, 2).join(" ");
      expect(corpus.filter((f) => f.text.includes(subject)).length).toBeGreaterThan(8);
      // The ordinal is what makes the gold row alone. Matched as written, digits and all,
      // and anchored at a space so `#22` does not match the `#222` of another row: the
      // ordinal is the row's *own*, but it is also a numeric prefix of later ordinals.
      //    `（` is U+FF08 and NOT whitespace in a JS regex, so the leading anchor accepts
      //    an ASCII space (English framing) or that bracket (Chinese framing).
      const anchored = new RegExp(`(?: |\uFF08)${full.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!#?\\d)`);
      expect(corpus.filter((f) => anchored.test(f.text)).map((f) => f.token)).toEqual([gold.token]);
      // 4. The question names the gold's own project and, when the corpus has one to
      //    spare, another — so matching on "some project" is not enough.
      const queryWords = terms(q.query);
      expect(queryWords).toContain(gold.project);
      const others = queryWords.filter((w) => w.startsWith("bench-project-") && w !== gold.project);
      expect(new Set(others).size).toBe(inChinese ? 2 : 2);
    }
  });

  it("names each row's subject without naming its marker", () => {
    const corpus = buildCorpus({ facts: 400, projects: 4, seed: 7 });
    const byToken = new Map(corpus.map((f) => [f.token, f]));
    const semantic = buildQueries(corpus, { queries: 80, seed: 11, projects: 4 }).filter((q) => q.mode === "semantic");
    for (const q of semantic) {
      const gold = byToken.get(q.token)!;
      // The question says what the row is about: project, noun and area. Measured, this
      // is what lifts the gold out of its phrase group — without the noun a Chinese
      // query ranked 16th of 400.
      expect(gold.text).toContain(gold.noun === "brief" ? "brief" : gold.noun);
      expect(gold.text).toContain(gold.area);
      expect(q.query).toContain(gold.project);
      expect(q.query).toContain(gold.area);
      expect(q.query).toContain(gold.noun);
      // The marker is what makes it a *semantic* question: absent from the query,
      // present in the text, so `rankOf` can score it.
      expect(q.query).not.toMatch(/zq\d+/);
      expect(gold.text).toContain(q.token);
    }
  });

  it("keeps the three original shapes byte-identical to the pre-existing generator", () => {
    const corpus = buildCorpus({ facts: 400, projects: 4, seed: 7 });
    const mix = buildQueries(corpus, { queries: 40, seed: 11, projects: 4 });
    const before = buildQueriesWithoutSemantic(corpus, 40, 11);
    const shape = (i: number) => (i % 4 === 3 ? "semantic" : i % 3 === 0 ? "bare" : i % 3 === 1 ? "noisy" : "cjk");
    const runnable = before.filter((_, i) => shape(i) !== "semantic");
    expect(mix.filter((q) => q.mode !== "semantic")).toEqual(runnable);
    // ...which is the whole reason the old gates on bare/noisy/cjk stay comparable.
    for (const q of mix.filter((x) => x.mode !== "semantic")) expect(q.query).toContain(q.token);
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
