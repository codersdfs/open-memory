/**
 * Real-time benchmark primitives (ADR-0024).
 *
 * "Real-time" here means the run is *open loop*: requests are scheduled at a fixed
 * rate whether or not the previous one finished, and latency is sampled per request
 * as it completes. A closed-loop driver (the usual `for` loop) reports the latency of
 * a client that politely waits, which hides queueing — the number you actually feel.
 *
 * Everything in this file is pure and deterministic so the driver can stay a script
 * and the measurement rules can be unit-tested: percentiles, per-second buckets, the
 * run summariser, and the seeded corpus the run measures recall against.
 */

/** A single completed request. `token` is the gold marker for a search. */
export interface OpSample {
  op: BenchOp;
  /** Wall-clock offset from the start of the run, in ms. */
  at: number;
  ms: number;
  ok: boolean;
  error?: string;
  /** Search only: 1-based rank of the gold row in the returned list, or null. */
  rank?: number | null;
  /** Search only: which query shape produced it (`bare` | `noisy` | `cjk`). */
  mode?: string;
  /** Search only: tokens the budget admitted, and whether the budget was the limit. */
  tokensUsed?: number;
  truncated?: boolean;
  /** Write only: what reconcile decided (`insert` | `reinforce` | `supersede`). */
  action?: string;
}

export type BenchOp = "search" | "write" | "list" | "brief" | "knowledge" | "sync";

export const BENCH_OPS: BenchOp[] = ["search", "write", "list", "brief", "knowledge", "sync"];

/**
 * Nearest-rank percentile over an unsorted list. `p` is 0..1. Nearest-rank is used
 * rather than interpolation on purpose: p99 of 40 samples should be the slowest
 * request, not an average of the top two.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1]!;
}

export interface Bucket {
  /** Seconds since the start of the run. */
  second: number;
  count: number;
  errors: number;
  p50: number;
  p95: number;
  /** Requests per second inside this bucket. */
  rate: number;
}

/**
 * One-second buckets over the samples, so the report carries a time series and not
 * just a total: a run that is fast on average and stalls for two seconds is a
 * failed run, and only the series shows it.
 */
export function bucketSeries(samples: OpSample[], durationMs: number): Bucket[] {
  const buckets = new Map<number, number[]>();
  const errors = new Map<number, number>();
  const seconds = Math.max(1, Math.ceil(durationMs / 1000));
  for (let s = 0; s < seconds; s++) buckets.set(s, []);
  for (const sample of samples) {
    const second = Math.min(seconds - 1, Math.floor(sample.at / 1000));
    const list = buckets.get(second);
    if (!list) continue;
    list.push(sample.ms);
    if (!sample.ok) errors.set(second, (errors.get(second) ?? 0) + 1);
  }
  const series: Bucket[] = [];
  for (let s = 0; s < seconds; s++) {
    const list = buckets.get(s)!;
    series.push({
      second: s,
      count: list.length,
      errors: errors.get(s) ?? 0,
      p50: Math.round(percentile(list, 0.5)),
      p95: Math.round(percentile(list, 0.95)),
      rate: Math.round(list.length * 10) / 10
    });
  }
  return series;
}

export interface OpStats {
  count: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface QualityStats {
  searches: number;
  /** Searches that returned no rows at all. */
  empty: number;
  recall1: number;
  recall5: number;
  /** Mean reciprocal rank of the gold row; 0 for a miss. */
  mrr: number;
  /** Mean admitted tokens per search and the share of searches the budget trimmed. */
  tokensMean: number;
  /** Results the `k` cap trimmed (not a budget overflow — the budget has its own counter). */
  truncatedResults: number;
  budgetOverBudget: number;
  /** recall@5 per query shape: the same retriever can be fine in English and broken in CJK. */
  byMode: Record<string, { searches: number; recall1: number; recall5: number; mrr: number; empty: number }>;
}

export interface RunSummary {
  durationMs: number;
  /** Requests actually issued per second, including the ones that were dropped. */
  issued: number;
  completed: number;
  dropped: number;
  throughput: number;
  errors: number;
  errorRate: number;
  /** Longest gap between two completions, in ms: the worst stall a caller would see. */
  stallMs: number;
  ops: Record<string, OpStats>;
  quality: QualityStats;
}

/** Aggregate samples into the report the driver prints and writes. */
export function summarizeRun(samples: OpSample[], opts: { durationMs: number; issued: number; dropped: number }): RunSummary {
  const completed = samples.length;
  const errors = samples.filter((s) => !s.ok).length;
  let stallMs = 0;
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  for (let i = 1; i < sorted.length; i++) stallMs = Math.max(stallMs, sorted[i]!.at - sorted[i - 1]!.at);

  const ops: Record<string, OpStats> = {};
  for (const op of BENCH_OPS) {
    const forOp = samples.filter((s) => s.op === op);
    if (forOp.length === 0) continue;
    const durations = forOp.map((s) => s.ms);
    ops[op] = {
      count: forOp.length,
      errors: forOp.filter((s) => !s.ok).length,
      p50: Math.round(percentile(durations, 0.5)),
      p95: Math.round(percentile(durations, 0.95)),
      p99: Math.round(percentile(durations, 0.99)),
      max: Math.round(Math.max(...durations))
    };
  }

  const searches = samples.filter((s) => s.op === "search" && s.ok);
  const ranks = searches.map((s) => s.rank ?? null);
  const hit1 = ranks.filter((r) => r === 1).length;
  const hit5 = ranks.filter((r) => r !== null && r <= 5).length;
  const rr = ranks.reduce<number>((sum, r) => sum + (r === null ? 0 : 1 / r), 0);
  const tokens = searches.map((s) => s.tokensUsed ?? 0);

  const quality: QualityStats = {
    searches: searches.length,
    empty: ranks.filter((r) => r === null).length,
    recall1: searches.length === 0 ? 0 : round(hit1 / searches.length),
    recall5: searches.length === 0 ? 0 : round(hit5 / searches.length),
    mrr: searches.length === 0 ? 0 : round(rr / searches.length),
    tokensMean: searches.length === 0 ? 0 : Math.round(tokens.reduce((a, b) => a + b, 0) / searches.length),
    truncatedResults: searches.filter((s) => s.truncated === true).length,
    budgetOverBudget: tokens.filter((t) => t > SEARCH_BUDGET).length,
    byMode: modeQuality(searches)
  };

  const duration = Math.max(1, opts.durationMs);
  return {
    durationMs: opts.durationMs,
    issued: opts.issued,
    completed,
    dropped: opts.dropped,
    throughput: round(completed / (duration / 1000)),
    errors,
    errorRate: completed === 0 ? 0 : round(errors / completed),
    stallMs,
    ops,
    quality
  };
}

/** The budget every benchmark search asks for; overruns are a product bug, not noise. */
export const SEARCH_BUDGET = 800;

/**
 * Recall per query shape. Pooled recall hides the case that matters: a retriever can
 * score 0.98 on English wording and lose a fifth of the Chinese markers because the
 * embedder cannot represent the script, and the average still looks healthy.
 */
function modeQuality(searches: OpSample[]): QualityStats["byMode"] {
  const out: QualityStats["byMode"] = {};
  for (const mode of [...new Set(searches.map((s) => s.mode ?? "unknown"))].sort()) {
    const mine = searches.filter((s) => (s.mode ?? "unknown") === mode);
    const ranks = mine.map((s) => s.rank ?? null);
    const hit5 = ranks.filter((r) => r !== null && r! <= 5).length;
    const rr = ranks.reduce<number>((sum, r) => sum + (r === null ? 0 : 1 / r), 0);
    out[mode] = {
      searches: mine.length,
      recall1: mine.length === 0 ? 0 : round(ranks.filter((r) => r === 1).length / mine.length),
      recall5: mine.length === 0 ? 0 : round(hit5 / mine.length),
      mrr: mine.length === 0 ? 0 : round(rr / mine.length),
      empty: ranks.filter((r) => r === null).length
    };
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Corpus and queries: the run measures recall against facts it wrote itself, so
// "the search missed" is a missing row, never a missing label.
// ---------------------------------------------------------------------------

export interface BenchFact {
  text: string;
  project: string;
  kind: string;
  type: string;
  /** Unique marker; a search hit is counted by finding this token in a result. */
  token: string;
}

export interface BenchQuery {
  query: string;
  /** Gold marker of the fact the question is about. */
  token: string;
  mode: "bare" | "noisy" | "cjk";
}

/** Deterministic PRNG (mulberry32) so two runs of the same command see the same corpus. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOUNS = [
  "ingest", "retrieval", "brief", "decay", "reconcile", "migration", "budget",
  "index", "sync", "parser", "queue", "cache"
];
const AREAS = ["auth", "billing", "search", "console", "storage", "sync", "cli", "api"];
const GOTCHAS = [
  "must run after the schema migration",
  "fails silently when the WAL is on a network drive",
  "returns stale rows until the second pass",
  "needs an explicit namespace or it fans out to every partition",
  "must not be called inside a transaction"
];

/**
 * Build a project-shaped corpus: durable conventions and gotchas (the kinds the
 * brief reads), spread over several projects, half of them Chinese. The token is a
 * rare word (`zq1234`) rather than a sentence fragment, so a hit cannot be luck.
 */
export function buildCorpus(opts: { facts: number; projects: number; seed?: number }): BenchFact[] {
  const random = rng(opts.seed ?? 7);
  const facts: BenchFact[] = [];
  for (let i = 0; i < opts.facts; i++) {
    const token = `zq${1000 + i}`;
    const project = `bench-project-${i % opts.projects}`;
    const noun = NOUNS[Math.floor(random() * NOUNS.length)]!;
    const area = AREAS[Math.floor(random() * AREAS.length)]!;
    const gotcha = GOTCHAS[Math.floor(random() * GOTCHAS.length)]!;
    const kind = i % 3 === 0 ? "convention" : i % 3 === 1 ? "decision" : "gotcha";
    const type = kind === "gotcha" ? "procedural" : "semantic";
    const text =
      i % 2 === 0
        ? `Convention in ${project}: the ${noun} for ${area} is ${token}, and it ${gotcha}.`
        : `项目 ${project} 的约定：${area} 的${noun === "brief" ? "简报" : "流程"}使用 ${token}，并且它 ${gotcha}。`;
    facts.push({ text, project, kind, type, token });
  }
  return facts;
}

/**
 * Queries with a known gold. Every shape carries the fact's marker, so "the gold is
 * not in the results" always means the retriever missed — never that the question was
 * ambiguous. The shapes differ in the noise around the marker, which is what makes
 * them worth measuring separately: a bare marker is the best case, a noisy query is
 * what a real question looks like, and a CJK query exercises the tokenizer.
 */
export function buildQueries(corpus: BenchFact[], opts: { queries: number; seed?: number }): BenchQuery[] {
  const random = rng(opts.seed ?? 11);
  const NOISE = ["how", "do", "we", "configure", "the", "pipeline", "for", "this", "project", "today"];
  const queries: BenchQuery[] = [];
  for (let i = 0; i < opts.queries; i++) {
    const fact = corpus[Math.floor(random() * corpus.length)]!;
    const mode: BenchQuery["mode"] = i % 3 === 0 ? "bare" : i % 3 === 1 ? "noisy" : "cjk";
    const noise = [0, 1, 2, 3, 4, 5].map(() => NOISE[Math.floor(random() * NOISE.length)]!).join(" ");
    const query =
      mode === "bare"
        ? fact.token
        : mode === "noisy"
          ? `${noise} ${fact.token} ${fact.project}`
          : `${fact.project} 里的 ${fact.token} 是怎么配置的`;
    queries.push({ query, token: fact.token, mode });
  }
  return queries;
}

/**
 * Rank of the gold row: the first result whose text carries the gold token, 1-based.
 * Matching on the marker instead of an id keeps the measurement honest when a write
 * is reconciled into an existing row and its id changes.
 */
export function rankOf(texts: string[], token: string): number | null {
  for (let i = 0; i < texts.length; i++) if (texts[i]!.includes(token)) return i + 1;
  return null;
}
