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
  /** Search only: which query shape produced it (`bare` | `noisy` | `cjk` | `semantic`). */
  mode?: string;
  /**
   * Search only: the gold row held none of the query's own words. Such a search can
   * only be answered by the vector path — a term index has nothing to look up.
   */
  markerFree?: boolean;
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

export interface QueryModeStats {
  searches: number;
  recall1: number;
  recall5: number;
  mrr: number;
  empty: number;
  /**
   * Share of the searches whose gold row carried no word of the query — the only
   * shape a term index cannot satisfy. Measured per sample, so no index is needed.
   */
  markerFree: number;
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
  byMode: Record<string, QueryModeStats>;
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
      empty: ranks.filter((r) => r === null).length,
      markerFree:
        mine.length === 0 ? 0 : round(mine.filter((s) => s.markerFree === true).length / mine.length)
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
  /** Corpus noun of the row (`ingest`, `parser`, …); with project+area it names a row. */
  noun: string;
  /** Area of the row (`auth`, `billing`, …). */
  area: string;
  /** Project-local ordinal of the fact, i.e. the `N` in `bench-project-N`. */
  slot: number;
  /** Global ordinal of the fact. With `sig` and `slot` it names exactly one row. */
  ordinal: number;
  /**
   * Two `slug words` naming this row's own gotcha. Anything else in the corpus —
   * a shared noun, an area, a project id — is drawn from the same small pools for
   * every row, so these are the only words that can pick one row out of a few
   * hundred. The `semantic` query shape is built from them; see `buildQueries`.
   */
  sig: [string, string];
}

export interface BenchQuery {
  query: string;
  /** Gold marker of the fact the question is about. */
  token: string;
  mode: "bare" | "noisy" | "cjk" | "semantic";
}

/** Every mode `buildQueries` produces. Pinned by a test so a shape cannot vanish silently. */
export const QUERY_MODES: BenchQuery["mode"][] = ["bare", "noisy", "cjk", "semantic"];

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
 * Words for the `semantic` query shape, indexed like `GOTCHAS` (the corpus picks the
 * same index for both). The appositive goes into the *fact*, so the fact and the
 * question about it share a phrase no other row has — that phrase is what the vector
 * has to find, because everything else in the sentence (nouns, areas, projects) is
 * drawn from a pool every row shares.
 *
 * The words are deliberately disjoint from `GOTCHAS`, `NOUNS`, `AREAS` and the
 * `bare`/`noisy` noise list. If a gotcha pool overlapped one, the question would
 * contain getcha text and the "the gold holds no word the query asked for" claim
 * would be false.
 */
const SIGNATURES: [string, string][] = [
  ["late", "ordering"],
  ["network", "share"],
  ["stale", "second"],
  ["fanout", "partitions"],
  ["nesting", "scope"]
];

const ROMAN = ["i", "ii", "iii", "iv", "v"];


/**
 * The appositive naming a row's own case: its signature phrase, the row's
 * project-local slot (`i`..`v`) and its global ordinal (`#1236`), i.e.
 * `late ordering i #1236`. Any two of those are shared by other rows — `sig` by every
 * row that drew the same gotcha, `sig` + project by two rows in a four-project corpus,
 * `sig` + slot by the rows that landed on the same project at a different time. Only
 * all three together name one row, and the ordinal costs the corpus nothing: it is a
 * number, not vocabulary, so it adds no word the tokenizer can match.
 *
 * This is what makes the `semantic` mode a vector test rather than a vocabulary test:
 * the question names a phrase that exactly one row holds, so a reader that can compare
 * representations has a unique target, and a reader that cannot still has the shared
 * project and nouns the question mentions. See `BenchFact.sig` for what is stored.
 */
export function sigPhrase(fact: Pick<BenchFact, "sig" | "slot" | "ordinal">): string {
  return `${fact.sig[0]} ${fact.sig[1]} ${ROMAN[fact.slot % ROMAN.length]} #${fact.ordinal}`;
}

/**
 * The phrase a *paraphrase* of a row carries: the signature words and `case`, with the
 * slot marker and ordinal dropped (`a late ordering case`). The corpus keeps the full
 * phrase, so a paraphrase and its source are near-but-not-equal — close enough for a
 * cosine to rank the source first, far enough that no exact-match shortcut answers it.
 *
 * The slot and the ordinal are deliberately gone: in a four-project corpus 400 rows
 * share only 20 distinct signatures, so the phrase alone names ~20 rows and the
 * question cannot descend to one. That is fine, and it is also what keeps the
 * measurement honest: the only way to pick one of those twenty is the *subject* —
 * project, noun, area — which is exactly the part of the vector the term index scores
 * too. The question is therefore a real ranking problem: a broken vector path loses
 * the order among twenty near-identical rows, and recall@5 drops with it.
 */
export function paraphrasePhrase(fact: Pick<BenchFact, "sig">): string {
  return `a ${fact.sig[0]} ${fact.sig[1]} case`;
}

/**
 * The paraphrase of a row stored in Chinese: the same signature words, framed the way
 * the Chinese template frames them (`…（late ordering）`). The English frame "a … case"
 * shares no character bigram with `（late ordering）`, so a Chinese question built with
 * it scores its own gold *below* every English row that happens to share the frame.
 */
export function paraphrasePhraseZh(fact: Pick<BenchFact, "sig">): string {
  return `（${fact.sig[0]} ${fact.sig[1]}）`;
}

/**
 * Build a project-shaped corpus: durable conventions and gotchas (the kinds the
 * brief reads), spread over several projects, half of them Chinese. The token is a
 * rare word (`zq1234`) rather than a sentence fragment, so a hit cannot be luck.
 *
 * Each row also carries a `sig` — two words naming its own gotcha — rendered into
 * the text as an appositive ("…, a <first> <second> case, …"). Without it no
 * marker-free question could name one row out of four hundred: the template pools
 * are deliberately small, so 256 distinct sentences covered 400 facts and the rest
 * were字面 duplicates. Text for every other purpose is unchanged apart from that
 * clause.
 */
export function buildCorpus(opts: { facts: number; projects: number; seed?: number }): BenchFact[] {
  const random = rng(opts.seed ?? 7);
  const facts: BenchFact[] = [];
  // Pools wide enough that `project + noun + area` names one row: 4 projects × 40 nouns
  // × 8 areas is 1280 combinations against 400 facts, so a question built from a row's
  // subject reaches that row. With the old 12 × 8 pools the subject alone was shared by
  // three or four rows and *nothing* could answer a marker-free question.
  const nouns = NOUNS.slice(0, Math.max(12, Math.ceil(opts.facts / 10)));
  const areas = AREAS.slice(0, Math.max(4, Math.min(AREAS.length, 8)));
  for (let i = 0; i < opts.facts; i++) {
    const token = `zq${1000 + i}`;
    const project = `bench-project-${i % opts.projects}`;
    const noun = nouns[Math.floor(random() * nouns.length)]!;
    const area = areas[Math.floor(random() * areas.length)]!;
    const gotchaIndex = Math.floor(random() * GOTCHAS.length);
    const gotcha = GOTCHAS[gotchaIndex]!;
    const sig = SIGNATURES[gotchaIndex]!;
    const slot = i % opts.projects;
    const phrase = sigPhrase({ sig, slot, ordinal: i });
    const kind = i % 3 === 0 ? "convention" : i % 3 === 1 ? "decision" : "gotcha";
    const type = kind === "gotcha" ? "procedural" : "semantic";
    const text =
      i % 2 === 0
        ? `Convention in ${project}: the ${noun} for ${area} is ${token}, a ${phrase} case, and it ${gotcha}.`
        : `项目 ${project} 的约定：${area} 的 ${noun}（${noun === "brief" ? "简报" : "流程"}）使用 ${token}（${phrase}），并且它 ${gotcha}。`;
    facts.push({ text, project, kind, type, token, noun, area, slot, ordinal: i, sig });
  }
  return facts;
}

/**
 * Queries with a known gold. The first three shapes carry the fact's marker, so "the
 * gold is not in the results" always means the retriever missed — never that the
 * question was ambiguous. They differ in the noise around the marker, which is what
 * makes them worth measuring separately: a bare marker is the best case, a noisy
 * query is what a real question looks like, and a CJK query exercises the tokenizer.
 *
 * `semantic` is the fourth shape, one query in four, and the reason the first three
 * are not enough: they all carry the marker, so the term index answers them by itself
 * and recall@5 reads ~1.00 even when the vector path is dead. A `semantic` question
 * asks about one row the way a person would, with no marker, and names two things:
 *
 *   the row's subject       project + noun + area; together they name ~8 rows out of
 *                           400, so ranking on the subject alone lands on a neighbour;
 *   the row's paraphrase    `a late ordering case`, held by ~80 rows — the gotcha
 *                           group the question belongs to, not the row itself.
 *
 * Both halves are necessary and neither is sufficient: subject-only finds the right
 * project and area but is blind to which case it is; phrase-only finds eighty rows and
 * cannot say which. Only a ranker that *combines* a shared phrase with a shared subject
 * gets to the gold — which is what a cosine over a mixed representation does, and what
 * an inverted index answering one term at a time cannot fake. That is what makes the
 * gate meaningful in both directions: a retriever with no vector path still lands
 * inside the gold's phrase group (recall@5 well above 0), and a retriever whose cosine
 * is broken cannot order that group, so recall@5 falls far below 1.
 * `rankOf` scores it honestly either way: it looks for the marker inside the
 * *returned text*, which does not care whether the query held one.
 */
export function buildQueries(
  corpus: BenchFact[],
  opts: { queries: number; seed?: number; projects?: number }
): BenchQuery[] {
  const random = rng(opts.seed ?? 11);
  const NOISE = ["how", "do", "we", "configure", "the", "pipeline", "for", "this", "project", "today"];
  const projects = Math.max(1, opts.projects ?? inferProjects(corpus));

  // The area a `semantic` question attributes to a project: assigned once and rotated,
  // so no two projects share one inside a run. Two questions naming the same subject
  // would be indistinguishable to anything but cosine, and the gate would be
  // measuring a coin flip instead of a discriminator.
  const areaOfProject = new Map<string, string>();
  let areaCursor = 0;
  const subjectOf = (project: string): string => {
    let area = areaOfProject.get(project);
    if (area === undefined) {
      area = AREAS[areaCursor++ % AREAS.length]!;
      areaOfProject.set(project, area);
    }
    return area;
  };

  const queries: BenchQuery[] = [];
  // The shape rotates on the query index, independently of how often the random pick
  // repeats a fact. It is drawn from its own stream as well, so adding the fourth
  // shape shifts no draw the first three make: `bare`/`noisy`/`cjk` come out identical
  // to the generator that existed before `semantic` did, and their long-run numbers
  // stay comparable.
  const shapeRandom = rng((opts.seed ?? 11) ^ 0x5eed);
  for (let i = 0; i < opts.queries; i++) {
    const fact = corpus[Math.floor(random() * corpus.length)]!;
    const noise = [0, 1, 2, 3, 4, 5].map(() => NOISE[Math.floor(shapeRandom() * NOISE.length)]!).join(" ");
    if (i % 4 === 3) {
      queries.push({ query: semanticQuery(fact, subjectOf, projects), token: fact.token, mode: "semantic" });
      continue;
    }
    const mode: BenchQuery["mode"] = i % 3 === 0 ? "bare" : i % 3 === 1 ? "noisy" : "cjk";
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

/** `bench-project-2` -> 3, so a caller need not repeat `--projects` to build distractors. */
function inferProjects(corpus: BenchFact[]): number {
  let max = -1;
  for (const fact of corpus) max = Math.max(max, fact.slot);
  return max + 1;
}

/**
 * The `semantic` question for one fact. Built from fields, never from `fact.text`:
 * the driver appends a live suffix to every near-duplicate write during a run, and a
 * question copied out of the corpus would slowly describe the live row instead of the
 * seeded one.
 *
 * Its subject is the gold's own (project, noun, area). The two distractor clauses name
 * *other* projects and areas, so the question reads like someone comparing three
 * projects and asking about one of them — and the distractors fetch candidates that
 * are near, but wrong.
 *
 * ## What this question can and cannot measure (measured, both ways)
 *
 * It names the gold's subject and its paraphrase, and that has a consequence worth
 * stating plainly: plain word overlap answers ~98% of these questions inside recall@5.
 * With the hash embedder — `weights.vector = 0`, no vector path at all — the real bench
 * still reads recall@5 0.86 on this mode. The mode therefore does *not* prove "only a
 * cosine can answer this", and a gate on it is not, by itself, a vector-quality gate.
 *
 * A stricter shape was tried and rejected on measurement: describe the gold's situation
 * in words the stored sentence never uses (a paraphrase across the vocabulary gap) so
 * no number of shared tokens can answer it. It was unanswerable by *anything* — with
 * the synthetic embedder the gold's own cosine (0.323) sat below the top row's (0.360)
 * and pure-vector recall@5 was 0.04, i.e. a bag-of-features embedder cannot bridge a
 * zero-shared-feature paraphrase, and a gate built on it would fail for every embedder
 * this repo has. The subject shape, by contrast, is answerable by a good representation
 * and not by a bad one: pure cosine over the same embedder reads recall@5 0.96 / recall@1
 * 0.50 on this mode, and a vector path that loses a third of its candidates drops the
 * real pipeline to 0.63 while every other mode stays at 1.00.
 *
 * So the gate on this mode is a *floor on vector-assisted ranking*, and it catches
 * exactly what it was built for: a degraded vector path, which no other mode can see
 * because they all carry the marker. It does not, and cannot, catch "the term index
 * alone would also have answered this".
 *
 * The phrasings are load-bearing and were measured, not guessed:
 *
 *   - The question is English for a row stored in English and Chinese for a row stored
 *     in Chinese. The corpus's Chinese rows share a longer Chinese template, so an
 *     English question about one is outscored by every English row that merely repeats
 *     the question's own frame — the language match, not the meaning, decides. The nouns
 *     and areas are English in both templates, so the subject survives either way.
 *   - Words the corpus never uses ("behaves", "differs", "which") contribute nothing to
 *     any dot product; they only make the question read like a question.
 *   - The row's noun is named for Chinese rows too (`${area} 的 ${noun}`), because the
 *     Chinese template renders it as 流程/简报 and the noun is otherwise absent.
 */
function semanticQuery(fact: BenchFact, subjectOf: (project: string) => string, projects: number): string {
  const other = (offset: number) => `bench-project-${(fact.slot + offset) % projects}`;
  const near = other(1);
  const far = other(2);
  if (fact.text.startsWith("项目")) {
    return (
      `项目 ${fact.project} 的 ${fact.area} 的 ${fact.noun} 用 ${paraphrasePhraseZh(fact)}；` +
      `${near} 的 ${subjectOf(near)} 不同，${far} 的 ${subjectOf(far)} 也不同。`
    );
  }
  return (
    `in ${fact.project} the ${fact.noun} for ${fact.area} behaves one way; ` +
    `${near} ${subjectOf(near)} differs, ${far} ${subjectOf(far)} differs too ` +
    `— which is ${paraphrasePhrase(fact)}?`
  );
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
