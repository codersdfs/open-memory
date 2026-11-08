import type { EmbeddingProvider } from "../embedding/provider.js";
import type { VectorStore } from "../store/interface.js";
import type {
  Memory,
  ScoreBreakdown,
  SearchDiagnostics,
  SearchNearMiss,
  SearchOptions,
  SearchPartitionCount,
  SearchResult,
  SearchResultItem
} from "../types.js";
import { bm25Score, tokenize, type Bm25CorpusStats } from "./bm25.js";
import { coverage, coverageWeighted, indexTerms, queryTerms } from "./terms.js";
import { deriveFacets, facetTagsOf } from "../write/facets.js";
import { assembleFragment } from "./assemble.js";
import { mmr } from "./mmr.js";
import { budgetEnforce, countTokens } from "./tokens.js";
import { allPartitions, LEGACY_NAMESPACE } from "../scope.js";

/**
 * Minimum cosine to count as a vector signal. With MEMORY_VECTOR_WEIGHT=0 the
 * default hash embedder cannot clear this for anything (it returns ~0.9 to
 * everything), so lexical overlap is the only relevance gate — which is correct,
 * because that is the only signal it has ever had.
 */
const VECTOR_FLOOR = 0.95;
/**
 * How much of the query a row must hold to count, whatever BM25 says. See the gate
 * in `searchOne`: three quarters of the words asked for is where the bench's gold
 * rows sat while filler that only rhymed with the question's grammar stayed at 0.50.
 */
const COVERAGE_FLOOR = 0.75;
/**
 * How many rejected candidates an empty result explains itself with (ADR-0037).
 * Enough to show that the wording was close; small enough that the explanation
 * never costs more than the answer would have.
 */
const NEAR_MISS_LIMIT = 5;
/** Characters of a rejected candidate's stored text kept in a near miss (ADR-0037). */
const NEAR_MISS_TEXT_CHARS = 200;

/**
 * Pseudo-relevance feedback (ADR-0028): the second hop a multi-hop question
 * needs. The first pass answers "what matches the question's words"; the terms
 * those matches share name the topic, and a second lexical pass on those terms
 * reaches the rows that hold the rest of the answer but none of the question's
 * vocabulary — "What books has Melanie read?" does not say `Nothing is
 * Impossible`, but the row the first pass finds about Melanie's reading does.
 * Bounded on every axis: two seed rows, five terms, each held by the partition
 * but not by more than a third of it (the DF_CAP_RATIO rule), and the merged
 * rows are still ordered by coverage against the *original* question, so an
 * expansion hit can never outrank a row that answered the question itself.
 *
 * **Off by default, and the measurement is why.** On the LoCoMo evidence audit
 * (conv-26, 152 questions, NIM embeddings) the second pass reached rows the
 * first pass had missed — and cost more than it reached: the merged rows
 * crowded a fixed 800-token budget that whole first-pass rows needed, and the
 * any-evidence share fell 76% → 72% with PRF on. Built, measured, kept behind
 * `MEMORY_PRF=on` — the same path the int8 shortlist took (ADR-0026). The
 * shape it loses on is a partition of long, topically-similar rows; the shape
 * it wins on is short rows where the second hop's terms are rare.
 */
const PRF_SEED_DOCS = 2;
const PRF_MAX_TERMS = 5;
const PRF_MIN_DF = 2;

/**
 * The predecessor pointer a search hit may carry (Stage C chain half, P6/ADR-0045).
 *
 * Shape: `前身(2026-10-18): the claim this row replaced…` — the event date the
 * predecessor itself states (`valid_at`, falling back to `created_at` when the text
 * names no date) plus at most 80 characters of its text on one line. The full chain
 * is deliberately *not* here: that is the explicit walk (`?drill=1`,
 * `ai-memory get <id> --history`), because a chain the caller did not ask for is
 * context the caller must pay for reading.
 */
const PREDECESSOR_SUMMARY_CHARS = 80;
/** Below this the clipped summary is a stub, not a pointer — leave the space unspent. */
const PREDECESSOR_MIN_SUMMARY_CHARS = 12;

/** The local calendar, the same one `formatLocalDate` wrote the `at:` stamp in. */
function localDate(ms: number): string {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** The longest prefix (≤ `max` chars) of `text` that fits `tokens` — `countTokens` is monotonic in length. */
function clipToTokens(text: string, max: number, tokens: number): string {
  if (countTokens(text) <= tokens) return text;
  let lo = 0;
  let hi = Math.min(max, text.length);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    if (countTokens(text.slice(0, mid)) <= tokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

export interface RetrievalConfig {
  weights?: { vector: number; bm25: number; recency: number; strength: number; entity?: number };
  recencyHalfLifeDays?: number;
  mmrLambda?: number;
}

/** One scored candidate before threshold/MMR. */
type Scored = {
  memory: Memory;
  vectorScore: number;
  bm25Score: number;
  /** Share of the query's own words this row holds (see `coverage`). Gates. */
  coverageScore: number;
  /**
   * The same share with each asked word weighted by its df (ADR-0028). Orders —
   * the sort, MMR and the budget — but never gates: a partition that knows only
   * one of the question's five words would score a row holding that one word at
   * 1.0 weighted, and the gate is the one place a single-word overlap must not
   * count as three quarters of an answer.
   */
  coverageWeightedScore: number;
  /**
   * The share of the query's own facets the row holds (P4, ADR-0046), from the same
   * `deriveFacets` the write path built the row's tags with. Orders (through
   * `w.entity`, default 0) and is reported in the breakdown; it never gates — a
   * facet-only candidate still has to clear the same relevance gate as everything
   * else, which is what keeps the third arm from being a free channel.
   */
  entityScore: number;
  recencyScore: number;
  score: number;
  breakdown: ScoreBreakdown;
};

/**
 * A row the gate threw away, with the number it was judged on (ADR-0037).
 *
 * The relevance is captured where it is computed rather than recomputed downstream:
 * the explanation has to report the number the gate actually compared, and a second
 * copy of `Math.max(bm25, vectorWeight > 0 ? vector : 0)` is how the two would drift.
 */
interface RejectedCandidate {
  scored: Scored;
  relevance: number;
}

/**
 * What one partition's gate decided (ADR-0037).
 *
 * `rejected` exists so an empty result can explain itself: it is the same rows the
 * gate threw away, with the same numbers it compared, and it is computed on every
 * path because the gate already had them in hand — carrying them costs a push, not
 * a second query. Only `search` decides whether they are ever serialized.
 */
interface SearchOneResult {
  kept: Scored[];
  rejected: RejectedCandidate[];
  threshold: number;
}

export class HybridRetriever {
  private weights: { vector: number; bm25: number; recency: number; strength: number; entity: number };
  private halfLifeDays: number;
  private mmrLambda: number;
  /** How far the best vector hit must lead its partition's median cosine to count. */
  private semanticMargin: number;
  /** Read-time projection of long memories onto their matching lines (ADR-0014). */
  private assembleEnabled: boolean;
  /** Second lexical pass on the seeds' shared terms (ADR-0028). */
  private prfEnabled: boolean;
  /**
   * The third candidate arm (P4, ADR-0046). Off by default, like PRF before it and
   * for the same discipline: the arm widens the candidate pool, and ADR-0028 measured
   * what a wider pool does to a fixed 800-token budget before. `MEMORY_LINKS=on` opts
   * in; the measurement that decides whether it ever flips is the evidence ruler.
   */
  private linksEnabled: boolean;
  constructor(
    private store: VectorStore,
    private embedder: EmbeddingProvider,
    private config: RetrievalConfig = {}
  ) {
    // The vector term is noise with the hash embedder (~0.9 cosine to everything)
    // and load-bearing with a real one, so the default follows the embedder rather
    // than being a number every user has to discover and set. A real provider that
    // silently contributed nothing would be worse than no provider: it costs a
    // network hop per save and buys no ranking.
    const envWeight = process.env.MEMORY_VECTOR_WEIGHT;
    const vectorWeight = envWeight === undefined
      ? (embedder.name === "hash" ? 0 : 0.6)
      : Number(envWeight);
    this.weights = {
      ...(config.weights ?? {
        vector: Number.isFinite(vectorWeight) ? vectorWeight : 0,
        bm25: 0.6,
        recency: 0.25,
        // Reads `strength`, which starts at the judge's importance and grows with
        // use (R2). The field name is the contract: this term must not be fed the
        // write-time number, or reinforcement would have no effect on ranking.
        strength: 0.15
      }),
      // The entity term exists to be measurable (it is in the breakdown), not to
      // rank: default 0 means the facet arm can only change results through the
      // gate, the same way the lexical arm's rows do — never through a boost
      // nobody asked for. mem0's entity boost is the cautionary tale here
      // (bench/REPORT.md: 14.5% overall, 6% multi-hop on this repo's bench).
      entity: config.weights?.entity ?? 0
    };
    this.halfLifeDays = config.recencyHalfLifeDays ?? 30;
    this.mmrLambda = config.mmrLambda ?? 0.6;
    // Calibrated on 53 rows, six paraphrases against six unrelated queries; the note in
    // searchOne carries the numbers. Raise it to be stricter about admitting a memory
    // with no shared words, lower it to reach further.
    const margin = Number(process.env.MEMORY_SEMANTIC_MARGIN ?? 0.2);
    this.semanticMargin = Number.isFinite(margin) ? margin : 0.2;
    // Rollback for the read-time projection, same shape as MEMORY_RECONCILE=off:
    // `off` returns whole memories exactly as v0.3 did. It is also the A/B arm.
    this.assembleEnabled = process.env.MEMORY_ASSEMBLE !== "off";
    // Opt-in (ADR-0028): measured net-negative on the LoCoMo audit — merged rows
    // crowd a fixed budget — so the second pass runs only when asked for.
    this.prfEnabled = process.env.MEMORY_PRF === "on";
    this.linksEnabled = process.env.MEMORY_LINKS === "on";
  }

  /**
   * Stage 1 for a single partition: vector-seeded candidate fetch, then hybrid
   * scoring, then the relevance gate (ADR-0002). Partition-local on purpose: BM25
   * and cosine are only comparable inside one corpus, so they are combined with
   * the other signals *before* cross-partition merging (`search` below).
   *
   * `hints.lexicalOnly` (the PRF second pass) skips the vector arm and the
   * cosine spread: the second pass exists to widen the *lexical* reach, the
   * first pass's vector hits are already in the pool, and skipping them keeps
   * the extra pass at the cost of two posting-list reads.
   *
   * The facet arm (P4, ADR-0046, `MEMORY_LINKS=on`) is skipped on that pass for
   * the same reason, and joins the pool under the lexical arm's own entry rule:
   * `vectorScore` 0, the same `relevant` floor, the same threshold/coverage gate.
   */
  private async searchOne(
    namespace: string,
    opts: SearchOptions,
    queryEmbedding: number[],
    hints?: { lexicalOnly?: boolean }
  ): Promise<SearchOneResult> {
    const k = opts.k ?? 5;
    const threshold = opts.threshold ?? 0.72;

    // over-fetch to allow rerank; governance-lite: archived/draft excluded unless asked
    const overFetch = Math.max(20, k * 4);
    const vectorHits = hints?.lexicalOnly
      ? []
      : await this.store.vectorSearch({
      namespace,
      queryEmbedding,
      type: opts.type,
      limit: overFetch,
      includeDeleted: opts.includeDeleted ?? false,
      status: opts.status,
      includeArchived: opts.includeArchived,
      includeDraft: opts.includeDraft,
      project: opts.project,
      kind: opts.kind,
      knowledge: opts.knowledge
    });

    // v0.4 candidate union (ADR-0012). Until now the only way into `scored` was
    // this vector list, and BM25 only re-ranked what the embedding had already
    // chosen — so a row with the query's exact words could never come back if
    // its cosine fell outside the top-20. Measured on a real 295-row partition:
    // 32.5% of targets sat outside the vector top-20 and recall@5 *equalled*
    // P(target in vector top-20) exactly; joining lexical candidates recovered
    // 65.0% -> 95.0% recall@5 (CJK queries 7.5% -> 100%, because the hash
    // embedder tokenizes on [^a-z0-9]+ and scores Chinese at random). The union
    // is bounded on purpose: merging every query term's candidates instead of
    // the top-`overFetch` dropped recall back to 82.1%, because the extra
    // candidates crowded real matches out of the budget.
    const lexicalHits = this.store.lexicalCandidates
      ? await this.store.lexicalCandidates({
          namespace,
          query: opts.query,
          limit: overFetch,
          type: opts.type,
          includeDeleted: opts.includeDeleted ?? false,
          status: opts.status,
          includeArchived: opts.includeArchived,
          includeDraft: opts.includeDraft,
          project: opts.project,
          kind: opts.kind,
          knowledge: opts.knowledge
        })
      : [];
    // P4 (ADR-0046): the third candidate arm. The query goes through the SAME
    // `deriveFacets` the write path built the rows' tags with, so both sides of the
    // join speak one vocabulary; rows sharing a query facet join the pool exactly
    // the way the lexical arm's rows join — with `vectorScore` 0 and no exemption:
    // the `relevant` floor and the threshold/coverage gate below read them
    // identically to every other candidate, so a facet hit with no lexical support
    // dies where any other zero-overlap row dies. What the arm buys is reach, not
    // rank: `w.entity` defaults to 0, so the join can lift nothing on its own — and
    // that is deliberate, because mem0's entity boost measured 14.5% overall / 6%
    // multi-hop on this repo's bench (bench/REPORT.md) and is not a number to copy.
    // Like the vector arm, skipped in the PRF second pass: `lexicalOnly` exists to
    // widen the lexical reach at posting-list cost, and a third query per pass
    // would price the expansion at more than ADR-0028 already measured it losing.
    const queryFacets = this.linksEnabled ? deriveFacets(opts.query) : [];
    const facetHits =
      this.linksEnabled && !hints?.lexicalOnly && queryFacets.length > 0 && typeof this.store.facetCandidates === "function"
        ? await this.store.facetCandidates({
            namespace,
            facets: queryFacets,
            limit: overFetch,
            type: opts.type,
            includeDeleted: opts.includeDeleted ?? false,
            status: opts.status,
            includeArchived: opts.includeArchived,
            includeDraft: opts.includeDraft,
            project: opts.project,
            kind: opts.kind,
            knowledge: opts.knowledge
          })
        : [];
    const candidates = new Map<string, { memory: Memory; vectorScore: number }>();
    for (const hit of vectorHits) candidates.set(hit.memory.id, hit);
    for (const hit of lexicalHits) {
      // A row only the words found gets vectorScore 0: it still has to clear the
      // same relevance gate, so being lexically plausible is not a free pass.
      if (!candidates.has(hit.memory.id)) {
        candidates.set(hit.memory.id, { memory: hit.memory, vectorScore: 0 });
      }
    }
    for (const hit of facetHits) {
      // Same entry rule as the lexical-only rows above: vectorScore 0, same gate,
      // no free channel. The shared facets are kept on the hit for callers that
      // want the join named (P5); scoring recomputes the share from the row's own
      // tags below so every candidate's `entityScore` has exactly one definition.
      if (!candidates.has(hit.memory.id)) {
        candidates.set(hit.memory.id, { memory: hit.memory, vectorScore: 0 });
      }
    }

    // BM25 corpus statistics for this candidate set, not for an imagined corpus
    // of one-sentence memories. The hardcoded avgLen of 20 tokens in bm25.ts was
    // calibrated on short rows; against 1,200-character session chunks (~275
    // tokens) the length penalty divided every term by ~14 and BM25 collapsed to
    // ~0.01 on rows holding the query verbatim — which is how exact-match
    // evidence failed the relevance gate. df likewise makes a rare term decisive.
    // Terms come from `terms.ts`, not from raw `tokenize`, so the scorer measures
    // the same vocabulary the inverted index stored (ADR-0027). Both sides apply
    // the same function-word filter; `indexTerms(text) ⊆ queryTerms(text)` keeps
    // every indexed term reachable from a query. `bm25Score` re-tokenizes
    // internally and is unaffected: it only sees terms this loop already counted.
    const queryTokens = new Set(queryTerms(opts.query));
    let totalDocLen = 0;
    const df = new Map<string, number>();
    for (const { memory } of candidates.values()) {
      const terms = indexTerms(memory.text);
      totalDocLen += terms.length;
      for (const term of new Set(terms)) {
        if (queryTokens.has(term)) df.set(term, (df.get(term) ?? 0) + 1);
      }
    }
    const stats: Bm25CorpusStats = {
      avgLen: candidates.size > 0 ? totalDocLen / candidates.size : 20,
      docs: candidates.size,
      df,
      // The question as asked (post-filter, pre-expansion is not a thing here:
      // `queryTerms` already dropped the function words) — the scale a score is
      // normalized against, see `Bm25CorpusStats.queryTerms`.
      queryTerms: [...queryTokens]
    };

    // ADR-0028: coverage is weighted by the partition's own df when the store can
    // answer for it, falling back to the candidate-set df the BM25 loop just
    // built. The candidate set is rows sharing at least one query word, so its
    // df overestimates rarity — which only softens the weighting, never inverts
    // it. A df read that fails costs nothing: coverage is a weighting, not a gate.
    let coverageDf = df;
    if (queryTokens.size > 0 && typeof this.store.termDf === "function") {
      try {
        const storeDf = await this.store.termDf([...queryTokens]);
        if (storeDf.size > 0) coverageDf = storeDf;
      } catch {
        // keep the candidate-set estimate
      }
    }

    // enrich with BM25 + recency + importance + pin boost (ADR-0006)
    const now = Date.now();
    // The query's own facets, once: `entityScore` is the share of them a row holds,
    // measured against the row's stored tags — the same values the facet arm joined
    // on, read back from the row so a row that entered through the vector or lexical
    // arm is scored on the identical scale.
    const queryFacetSet = new Set(queryFacets.map((f) => f.toLowerCase()));
    const scored: Scored[] = [...candidates.values()].map(({ memory, vectorScore }) => {
      const b = bm25Score(opts.query, memory.text, stats);
      const ageDays = (now - memory.createdAt) / (1000 * 60 * 60 * 24);
      const recencyScore = Math.exp(-ageDays / this.halfLifeDays);
      const strengthScore = memory.strength;
      const w = this.weights;
      const pinBoost = memory.pin ? 0.3 : 0;
      const entityScore =
        queryFacetSet.size === 0
          ? 0
          : [...new Set(facetTagsOf(memory.tags).map((t) => t.toLowerCase()))].filter((t) => queryFacetSet.has(t))
              .length / queryFacetSet.size;
      const weighted = {
        vector: w.vector * vectorScore,
        bm25: w.bm25 * b,
        recency: w.recency * recencyScore,
        strength: w.strength * strengthScore,
        // Default weight 0: the term is always reported, never felt, until a caller
        // turns it up (P4, ADR-0046).
        entity: w.entity * entityScore
      };
      const score = weighted.vector + weighted.bm25 + weighted.recency + weighted.strength + weighted.entity + pinBoost;
      return {
        memory,
        vectorScore,
        bm25Score: b,
        coverageScore: coverage(memory.text, opts.query),
        coverageWeightedScore: coverageWeighted(memory.text, opts.query, coverageDf),
        entityScore,
        recencyScore,
        score,
        breakdown: {
          vector: vectorScore,
          bm25: b,
          recency: recencyScore,
          strength: strengthScore,
          entity: entityScore,
          pinBoost,
          weighted,
          final: score
        }
      };
    });

    // A memory with no lexical overlap and no vector signal is not a match, it is
    // just a recent important memory. recency + importance alone put 0.34 on
    // every row, which is the threshold's whole budget — so an unrelated query
    // cleared 0.35 and came back with results it had no business returning.
    // Relevance gates; recency and importance only break ties among matches.
    // Vector evidence can also *admit* a memory no word matches — the one thing a real
    // embedder buys over the hash one. It has to be a relative test. Measured on a
    // 53-row corpus: unrelated queries peaked at cosine 0.120 / 0.147 / 0.256 while
    // genuine paraphrases sat at 0.271 and 0.304, so *any* absolute floor either admits
    // the kubernetes query or drops a paraphrase. Leading the partition's median
    // separated them where absolute similarity did not: noise never led by more than
    // 0.176, four of six paraphrases led by 0.231-0.345. The default margin sits between
    // those two measured numbers. The two paraphrases it still misses are ones the model
    // ranked 2nd and 8th — ranking failures, not gate failures.
    //
    // Only the partition's best vector hit can be admitted this way, and only when the
    // embedder is real: the hash cosine is ~0.9 to everything, so it can lead nothing.
    let semanticTopId: string | null = null;
    if (this.weights.vector > 0 && vectorHits.length > 0) {
      const spread = await this.store.cosineSpread({
        namespace,
        queryEmbedding,
        project: opts.project,
        kind: opts.kind,
        // The semantic gate compares a query against the population it is being
        // ranked in, so a knowledge-only search must take its median from
        // knowledge rows only, or the margin measures the wrong corpus.
        knowledge: opts.knowledge
      });
      const best = vectorHits[0]!;
      if (best.vectorScore - spread.median >= this.semanticMargin) semanticTopId = best.memory.id;
    }

    const relevant = scored.filter(
      (s) =>
        s.bm25Score > 0 ||
        s.vectorScore >= VECTOR_FLOOR ||
        s.memory.pin === 1 ||
        s.memory.id === semanticTopId
    );

    // The gate is a floor on *relevance*, never on the total. Recency and strength
    // decay and grow; folding them in made the gate harder the older a memory got,
    // which is backwards. Measured on a real store: "user is a TypeScript engineer
    // who hates boilerplate" answered the query "TypeScript engineer" with bm25
    // 0.884 — near-perfect overlap — and still scored 0.710 against this 0.72 gate
    // at 36 days old, so it was filtered. The effect compounds: the older a store
    // is, the more of it goes dark, until search looks broken rather than strict.
    // Relevance is a property of the match itself — lexical overlap, or cosine when
    // a real embedder is in play — and the other signals only order the survivors.
    // Pin still overrides. Threshold allows an empty result on purpose: a query the
    // store cannot answer should return nothing rather than the least-bad row.
    // Either kind of confidence clears it. Relevance alone is enough so that age
    // cannot hide a match; the total is also enough so that a fresh, important
    // memory that shares a term still answers a loosely-worded question — "where
    // does user live?" reaching "user lives in Berlin" is one term of four, and it
    // is the case the smart-search test exists to protect. Zero shared terms never
    // gets this far: the `relevant` filter above is the hard floor.
    //
    // `coverage` is what makes that last sentence true for a language whose words
    // BM25 has to cut up. A Chinese question asks for four words and indexes eight
    // terms; a row holding three of the four words has bm25 0.41 and a row holding
    // one of them plus a straddle bigram has 0.52 — BM25 cannot tell which match
    // was asked for, because its length normalization stops mattering once every
    // candidate is the same length. Coverage can: 0.75 for the row that holds the
    // marker, 0.50 for the one that only rhymes with the question's grammar.
    // Measured on the real-time bench (hash embeddings, threshold 0.35): CJK
    // recall@5 0.648 → 0.95, noisy 1.0 unchanged. An explicit `threshold` is the
    // caller's number; the coverage gate is a separate, additional way in, so a
    // caller tightening the number cannot accidentally re-admit filler.
    const relevanceOf = (s: Scored) =>
      Math.max(s.bm25Score, this.weights.vector > 0 ? s.vectorScore : 0);
    // ADR-0037: the gate now reports both sides. The predicate is unchanged — the
    // same expression decides which rows pass — but a rejected row is kept instead
    // of discarded, because "nothing matched your words" and "your words matched
    // nothing above the bar" are different answers and only one of them means the
    // caller should stop rewording the question.
    const passes = (s: Scored) =>
      relevanceOf(s) >= threshold ||
      s.coverageScore >= COVERAGE_FLOOR ||
      s.score >= threshold ||
      s.memory.id === semanticTopId ||
      s.memory.pin === 1;
    const kept: Scored[] = [];
    const rejected: RejectedCandidate[] = [];
    for (const s of relevant) {
      if (passes(s)) kept.push(s);
      // Captured here, at the gate, so the explanation reports the number the gate
      // used rather than a recomputation of it.
      else rejected.push({ scored: s, relevance: relevanceOf(s) });
    }
    return { kept, rejected, threshold };
  }

  /**
   * Multi-partition search (ADR-0007).
   *
   * `opts.namespace` still selects exactly one partition and produces byte-identical
   * results to v0.2.0. `opts.namespaces` fans out: each partition is scored on its
   * own, the survivors are merged (highest score wins per memory id, ties broken by
   * id for determinism), and only then do MMR and the hard budget run — once, over
   * the merged set, so the token cap is global rather than per layer.
   */
  async search(opts: SearchOptions): Promise<SearchResult> {
    const budgetTokens = opts.budgetTokens ?? 800;
    // v0.4: k is a real cap, not just an over-fetch hint. It used to reach only
    // `overFetch`, so the token budget alone decided the result size — measured on
    // a real bench run, 148 of 152 queries came back with 2-3 blocks for k=5 and
    // the median system_tokens was 620 of an 800 budget. The caller asked for five
    // and got whatever happened to fit. k now trims after the budget, so a large k
    // can never overrun the token cap and a small k is actually respected.
    const k = Math.max(1, opts.k ?? 5);
    const partitions = (opts.namespaces && opts.namespaces.length > 0 ? opts.namespaces : [opts.namespace]).filter(
      (n): n is string => typeof n === "string" && n.length > 0
    );
    const uniquePartitions = [...new Set(partitions)];

    // A caller that passed neither partition form gets the legacy default rather
    // than an empty result — the pre-ADR-0007 contract for bare tool calls.
    if (uniquePartitions.length === 0) uniquePartitions.push(LEGACY_NAMESPACE);

    const queryEmbedding = await this.embedder.embed(opts.query, { inputType: "query" });

    const perPartition = await Promise.all(
      uniquePartitions.map((ns) => this.searchOne(ns, opts, queryEmbedding))
    );

    // Merge. Duplicate ids can only appear if a caller passes the same partition
    // twice (deduped above) or an id was written to two layers — keep the best.
    const byId = new Map<string, Scored>();
    for (const row of perPartition.flatMap((p) => p.kept)) {
      const prev = byId.get(row.memory.id);
      if (!prev || row.score > prev.score) byId.set(row.memory.id, row);
    }
    const scored = [...byId.values()];
    // Weighted coverage leads, then score (ADR-0028). Both are relevance, but
    // only one of them is suppressed by the other signals: recency and strength
    // are age and use, and the bench's Chinese questions showed what that does
    // at k=5 — a row holding one asked-for word ranked above the row holding
    // three because it was newer and had been reinforced. The weight is what
    // stops a word every row holds (the question's entity name) from counting
    // the same as the word that identifies the answer; the gate above still
    // reads the unweighted share, so admission semantics are ADR-0027's,
    // measured and unchanged.
    const order = (a: Scored, b: Scored) =>
      (b.coverageWeightedScore - a.coverageWeightedScore) ||
      (b.score - a.score) ||
      (a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0);
    scored.sort(order);

    const added = await this.expand(scored, opts, uniquePartitions, queryEmbedding);
    if (added > 0) scored.sort(order);

    if (scored.length === 0) {
      // ADR-0037: an empty result explains itself. This one return covers both
      // shapes of "empty": nothing was even a candidate, and everything that was a
      // candidate fell below the gate. `explainEmpty` tells them apart by whether
      // any partition rejected anything, so the two never need separate paths.
      return {
        memories: [],
        tokensUsed: 0,
        truncated: false,
        summary: null,
        agent: opts.agent,
        scopes: uniquePartitions,
        diagnostics: await this.explainEmpty(opts, uniquePartitions, perPartition)
      };
    }

    // Stage 2: MMR diversify
    const mmrInput = scored.map(
      (s) =>
        ({ id: s.memory.id, score: s.coverageWeightedScore + s.score / 2, embedding: s.memory.embedding, _orig: s }) as unknown as {
          id: string;
          score: number;
          embedding: number[];
          _orig: Scored;
        }
    );
    // MMR order is the order. Re-sorting here by score undid Stage 2: the near-duplicate
    // that MMR demoted went straight back above the diverse pick, so the budget cut it off.
    // MMR's `score` is the relevance half of its formula; the weighted coverage goes on
    // that side of it (ADR-0028), so diversification can only reorder rows that hold the
    // same share of the question. Both live in 0..1 and the score is otherwise <= 1.0,
    // so `weighted + score / 2` orders by weighted coverage first and score within it.
    const diversified = mmr(mmrInput as never[], this.mmrLambda).map((m: unknown) => (m as { _orig: Scored })._orig);

    // Hard budget enforcement. A row that fits whole is kept whole; only a row
    // that does not fit is projected (ADR-0014), because the projection is lossy:
    // measured on the benchmark, projecting *every* long memory cost evidence
    // coverage (any-gold 61.8% → 56.6%, single-hop 55/70 → 43/70) — the gold turn
    // is not always the line that overlaps the question most. Projecting only into
    // leftover space cannot lose a row that already fit.
    const budgetInput = diversified.map((s) => ({
      id: s.memory.id,
      // Same ordering key MMR was given, so the budget cannot undo Stage 2 by
      // preferring a row MMR demoted.
      score: s.coverageWeightedScore + s.score / 2,
      recencyScore: s.recencyScore,
      text: s.memory.text
    }));

    // Need to keep mapping to full memory fields; budgetEnforce expects text+score
    const withBudget = budgetEnforce(
      budgetInput,
      budgetTokens,
      this.assembleEnabled
        ? {
            project: (text, maxTokens) => {
              const projected = assembleFragment(text, { query: opts.query, maxTokens });
              return projected.trimmed ? projected.text : null;
            }
          }
        : {}
    );

    // Reconstruct SearchResultItem with token counts and scores. `k` applies here,
    // after the budget: both limits must hold, and neither may be silently ignored.
    const limited = withBudget.kept.slice(0, k);
    const kept = new Map(diversified.map((s) => [s.memory.id, s]));
    const memories: SearchResultItem[] = limited
      .map((m) => {
        const s = kept.get(m.id);
        if (!s) return null;
        return {
          ...s.memory,
          // What the caller will actually read: projected to the matching lines and
          // possibly clipped by the budget, not the whole stored row.
          text: m.text,
          ...(opts.explain ? { explain: s.breakdown } : {}),
          score: s.score,
          vectorScore: s.vectorScore,
          bm25Score: s.bm25Score,
          recencyScore: s.recencyScore,
          // The row may have been clipped by the budget, so report what will
          // actually be read rather than the cost of the full text.
          tokens: m.tokens
        } satisfies SearchResultItem;
      })
      .filter((m): m is SearchResultItem => m !== null);

    // Stage C chain half (P6, ADR-0045): a hit that replaced something carries one
    // pointer line to its predecessor — the direct `supersedesId` hop only, never
    // the walk. Two rules it inherits from the budget's own projection
    // (tokens.ts:41-114): it spends ONLY the space nothing else could have used
    // (the budget leftover after every kept row has taken its whole text — it can
    // never displace or shrink a row), and it adds NO row to the candidate pool.
    // The second rule is the PRF lesson, measured, not a preference: ADR-0028's
    // second pass merged reachable rows into the pool and the fixed budget got
    // crowded — evidence-any fell 76% → 72% — which is why PRF ships off by
    // default. A chain is the same trade with worse odds (the predecessor is, by
    // definition, the row that was just proven out of date), so the pointer is a
    // line of text and nothing more. The full chain stays behind the explicit
    // `?drill=1` / `--history` walk, where the caller asked to pay for it.
    const usedAfterBudget = memories.reduce((s, m) => s + m.tokens, 0);
    if (usedAfterBudget < budgetTokens) {
      const predecessorIds = [
        ...new Set(
          memories
            .map((m) => m.supersedesId)
            .filter((v): v is string => typeof v === "string")
        )
      ];
      const predecessors = new Map<string, Memory>();
      for (const id of predecessorIds) {
        try {
          // getById sees tombstones, which is exactly the population here: the
          // predecessor was retired by this very supersede.
          const p = await this.store.getById(id);
          if (p) predecessors.set(id, p);
        } catch {
          // A pointer is a nicety; a failed read costs nothing but its absence.
        }
      }
      let used = usedAfterBudget;
      for (const m of memories) {
        if (!m.supersedesId) continue;
        const p = predecessors.get(m.supersedesId);
        if (!p) continue;
        const remaining = budgetTokens - used;
        if (remaining <= 0) break;
        const at = localDate(p.validAt ?? p.createdAt);
        const prefix = `前身(${at}): `;
        const summary = clipToTokens(
          p.text.replace(/\s+/g, " ").trim(),
          PREDECESSOR_SUMMARY_CHARS,
          remaining - countTokens(prefix)
        );
        if (summary.length < PREDECESSOR_MIN_SUMMARY_CHARS) continue;
        const pointer = `${prefix}${summary}`;
        const cost = countTokens(pointer);
        if (used + cost > budgetTokens) continue;
        m.text = `${m.text}\n${pointer}`;
        m.tokens += cost;
        used += cost;
      }
    }

    // R2. Reinforce what survived the budget, not what merely scored: the
    // memories that got injected into a prompt are the ones with evidence of
    // being useful. Best-effort — a store that cannot record the reinforcement
    // must still return the answer.
    if (memories.length > 0) {
      try {
        await this.store.reinforce(memories.map((m) => m.id));
      } catch (e) {
        console.warn("[retrieval] reinforce skipped:", (e as Error).message);
      }
    }

    return {
      memories,
      // Sum of what the caller receives, not of what the budget considered: the
      // k-trim happens after accounting and would otherwise overstate cost.
      tokensUsed: memories.reduce((sum, m) => sum + m.tokens, 0),
      truncated: withBudget.truncated || limited.length < withBudget.kept.length,
      summary: withBudget.summary,
      agent: opts.agent,
      scopes: uniquePartitions,
      // ADR-0037: the gate let rows through but nothing reached the caller — the
      // budget or `k` emptied the answer, not the relevance test. That is still an
      // empty result a caller cannot explain, so it gets the same explanation, and
      // the near misses are whatever the gate rejected (possibly none).
      ...(memories.length === 0
        ? { diagnostics: await this.explainEmpty(opts, uniquePartitions, perPartition) }
        : {})
    };
  }

  /**
   * The PRF second pass (ADR-0028), in place: seeds are the top rows of the
   * first pass, the terms both seeds share name the topic, and one lexical-only
   * re-search on those terms reaches rows that hold the rest of the answer but
   * none of the question's vocabulary. Merged rows are re-covered against the
   * *original* question, so an expansion hit is ordered by what was asked, not
   * by the words that happened to fetch it. Best-effort on every step: no df
   * capability, no seeds, or a failed read all leave the pool as pass one built
   * it. Returns how many rows joined, so the caller re-sorts only when the pool
   * changed.
   */
  private async expand(
    scored: Scored[],
    opts: SearchOptions,
    partitions: string[],
    queryEmbedding: number[]
  ): Promise<number> {
    if (!this.prfEnabled || scored.length === 0) return 0;
    if (partitions.length === 0 || typeof this.store.termDf !== "function") return 0;
    const asked = queryTerms(opts.query);
    if (asked.length === 0) return 0;

    const seeds = scored.slice(0, PRF_SEED_DOCS);
    const seedHolders = new Map<string, number>();
    for (const s of seeds) {
      for (const term of new Set(indexTerms(s.memory.text))) {
        seedHolders.set(term, (seedHolders.get(term) ?? 0) + 1);
      }
    }
    const askedSet = new Set(asked);
    const candidates = [...seedHolders.keys()].filter((t) => !askedSet.has(t));
    if (candidates.length === 0) return 0;

    // df bounds keep the expansion honest: a term held by fewer than two rows
    // cannot lead anywhere, and one held by a third of the partition is the
    // protagonist's name, not the topic (the same DF_CAP_RATIO rule the lexical
    // arm applies to query words). With two seeds the term must sit in both —
    // that intersection is what makes it the shared subject rather than either
    // row's aside.
    let dfMap: Map<string, number>;
    try {
      dfMap = await this.store.termDf(candidates);
    } catch {
      return 0;
    }
    const total = (await this.countRows(opts, partitions[0]!)).total;
    const cap = Math.max(PRF_MIN_DF, Math.floor(total / 3));
    const needed = Math.min(PRF_SEED_DOCS, seeds.length);
    const expansion = candidates
      .filter((t) => {
        const n = dfMap.get(t) ?? 0;
        return n >= PRF_MIN_DF && n <= cap && (needed < 2 || (seedHolders.get(t) ?? 0) >= 2);
      })
      .sort((a, b) => (dfMap.get(a) ?? 0) - (dfMap.get(b) ?? 0))
      .slice(0, PRF_MAX_TERMS);
    if (expansion.length === 0) return 0;

    const expandedQuery = `${opts.query} ${expansion.join(" ")}`;
    const pass2 = await Promise.all(
      partitions.map((ns) =>
        this.searchOne(ns, { ...opts, query: expandedQuery }, queryEmbedding, { lexicalOnly: true })
      )
    );
    let originalDf: Map<string, number> = new Map();
    try {
      originalDf = await this.store.termDf(asked);
    } catch {
      // merged rows then carry coverage 0, which only demotes them
    }
    const seen = new Set(scored.map((s) => s.memory.id));
    let added = 0;
    for (const row of pass2.flatMap((p) => p.kept)) {
      if (seen.has(row.memory.id)) continue;
      seen.add(row.memory.id);
      // Re-measured against the question the caller asked, both shares: the
      // weighted one is what orders them from here on, and the unweighted one
      // is what a later gate or explanation would read.
      row.coverageScore = coverage(row.memory.text, opts.query);
      row.coverageWeightedScore = coverageWeighted(row.memory.text, opts.query, originalDf);
      scored.push(row);
      added++;
    }
    return added;
  }

  /**
   * Explain an empty result (ADR-0037).
   *
   * Called only from the two empty paths, and it costs one `list({limit:1})` per
   * partition: `total` is the count of rows matching the search's own filters, so a
   * caller can tell "this partition is empty" (nothing was ever stored) from "the
   * rows exist and your wording missed them". `withVectors: false` because the count
   * is the whole point and decoding 384 floats per partition to obtain it is not.
   *
   * ADR-0039 adds the other half of that answer: `outside` names the partitions this
   * read did *not* cover that still hold rows for the same user. Without it the
   * empty result of a layered read says "nothing was stored for this scope" while
   * the fact the caller wants sits one agent layer over — the sentence is true and
   * the conclusion it invites is wrong.
   */
  private async explainEmpty(
    opts: SearchOptions,
    partitions: string[],
    perPartition: SearchOneResult[]
  ): Promise<SearchDiagnostics> {
    const counts: SearchPartitionCount[] = await Promise.all(
      partitions.map((namespace) => this.countRows(opts, namespace))
    );
    const outside = await this.outsidePartitions(opts, partitions);

    // Best first, by the number the gate compared. Ties keep partition order and
    // then the gate's own order, so two runs of the same search explain it the same
    // way — a diagnostic that reshuffles between retries is worse than none.
    const nearMisses: SearchNearMiss[] = perPartition
      .flatMap((p) => p.rejected)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, NEAR_MISS_LIMIT)
      .map(({ scored, relevance }) => ({
        // The stored text, not the projection the budget would have produced: a
        // rejected row never reached the budget, so there is no projection to
        // report, and the caller is being shown *what nearly matched*.
        text: scored.memory.text.slice(0, NEAR_MISS_TEXT_CHARS),
        relevance,
        bm25: scored.bm25Score,
        vector: scored.vectorScore,
        coverage: scored.coverageScore
      }));

    return {
      // The gate's own number. Every partition shares one `opts.threshold`, and
      // `searchOne` reads it from the same options object, so taking the first is
      // exact rather than a guess — the default is materialized there, not here.
      threshold: perPartition[0]?.threshold ?? opts.threshold ?? 0.72,
      partitions: counts,
      nearMisses,
      // Absent rather than empty when the store cannot enumerate partitions: an
      // empty array would read as "there is nothing outside" and the whole point of
      // this field is that we cannot claim that from a store that never told us.
      ...(outside === null ? {} : { outside })
    };
  }

  /**
   * How many rows this search would have admitted from one partition.
   *
   * `limit: 1` because only `total` is wanted, and every filter the search itself
   * applies is passed through — a count that ignored `type` or `status` would report
   * rows the search could never have returned, which is a different question than
   * "were there candidates here".
   */
  private async countRows(opts: SearchOptions, namespace: string): Promise<SearchPartitionCount> {
    const page = await this.store.list({
      namespace,
      type: opts.type,
      includeDeleted: opts.includeDeleted ?? false,
      status: opts.status,
      includeArchived: opts.includeArchived,
      includeDraft: opts.includeDraft,
      project: opts.project,
      kind: opts.kind,
      knowledge: opts.knowledge,
      limit: 1,
      withVectors: false
    });
    return { namespace, total: page.total };
  }

  /**
   * Partitions the same user holds rows in that this read did not cover (ADR-0039).
   *
   * The set comes from the store, not from a guess about which layers exist: a
   * partition nobody ever wrote to is not worth naming, and a layer that exists only
   * because some other agent ran is exactly the one worth naming. It reuses
   * `allPartitions` — the same enumeration `--all` reads through — so a diagnostic
   * cannot claim a partition set the `all` scope would not have read.
   *
   * Rows are counted with this search's own filters, so "366 rows in default:default"
   * means 366 rows this query *could* have returned had it looked there.
   *
   * Returns `null` when the store cannot enumerate partitions, which keeps the
   * absence of the key meaningful instead of silently reporting "nothing outside".
   */
  private async outsidePartitions(
    opts: SearchOptions,
    partitions: string[]
  ): Promise<SearchPartitionCount[] | null> {
    if (typeof this.store.distinctNamespaces !== "function") return null;

    const seen = new Set(partitions);
    const candidates = (await allPartitions(this.store)).filter((ns) => !seen.has(ns));
    if (candidates.length === 0) return [];

    const counted = await Promise.all(candidates.map((ns) => this.countRows(opts, ns)));
    // Empty partitions outside the scope change nothing: they do not hold the
    // answer, and listing them turns a one-line explanation into an inventory.
    return counted.filter((p) => p.total > 0);
  }
}
