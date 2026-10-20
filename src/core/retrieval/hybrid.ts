import type { EmbeddingProvider } from "../embedding/provider.js";
import type { VectorStore } from "../store/interface.js";
import type { Memory, ScoreBreakdown, SearchOptions, SearchResult, SearchResultItem } from "../types.js";
import { bm25Score, tokenize, type Bm25CorpusStats } from "./bm25.js";
import { assembleFragment } from "./assemble.js";
import { mmr } from "./mmr.js";
import { budgetEnforce } from "./tokens.js";
import { LEGACY_NAMESPACE } from "../scope.js";

/**
 * Minimum cosine to count as a vector signal. With MEMORY_VECTOR_WEIGHT=0 the
 * default hash embedder cannot clear this for anything (it returns ~0.9 to
 * everything), so lexical overlap is the only relevance gate — which is correct,
 * because that is the only signal it has ever had.
 */
const VECTOR_FLOOR = 0.95;

export interface RetrievalConfig {
  weights?: { vector: number; bm25: number; recency: number; strength: number };
  recencyHalfLifeDays?: number;
  mmrLambda?: number;
}

/** One scored candidate before threshold/MMR. */
type Scored = {
  memory: Memory;
  vectorScore: number;
  bm25Score: number;
  recencyScore: number;
  score: number;
  breakdown: ScoreBreakdown;
};

export class HybridRetriever {
  private weights: { vector: number; bm25: number; recency: number; strength: number };
  private halfLifeDays: number;
  private mmrLambda: number;
  /** How far the best vector hit must lead its partition's median cosine to count. */
  private semanticMargin: number;
  /** Read-time projection of long memories onto their matching lines (ADR-0014). */
  private assembleEnabled: boolean;
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
    this.weights = config.weights ?? {
      vector: Number.isFinite(vectorWeight) ? vectorWeight : 0,
      bm25: 0.6,
      recency: 0.25,
      // Reads `strength`, which starts at the judge's importance and grows with
      // use (R2). The field name is the contract: this term must not be fed the
      // write-time number, or reinforcement would have no effect on ranking.
      strength: 0.15
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
  }

  /**
   * Stage 1 for a single partition: vector-seeded candidate fetch, then hybrid
   * scoring, then the relevance gate (ADR-0002). Partition-local on purpose: BM25
   * and cosine are only comparable inside one corpus, so they are combined with
   * the other signals *before* cross-partition merging (`search` below).
   */
  private async searchOne(
    namespace: string,
    opts: SearchOptions,
    queryEmbedding: number[]
  ): Promise<Scored[]> {
    const k = opts.k ?? 5;
    const threshold = opts.threshold ?? 0.72;

    // over-fetch to allow rerank; governance-lite: archived/draft excluded unless asked
    const overFetch = Math.max(20, k * 4);
    const vectorHits = await this.store.vectorSearch({
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
    const candidates = new Map<string, { memory: Memory; vectorScore: number }>();
    for (const hit of vectorHits) candidates.set(hit.memory.id, hit);
    for (const hit of lexicalHits) {
      // A row only the words found gets vectorScore 0: it still has to clear the
      // same relevance gate, so being lexically plausible is not a free pass.
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
    const queryTokens = new Set(tokenize(opts.query));
    let totalDocLen = 0;
    const df = new Map<string, number>();
    for (const { memory } of candidates.values()) {
      const terms = tokenize(memory.text);
      totalDocLen += terms.length;
      for (const term of new Set(terms)) {
        if (queryTokens.has(term)) df.set(term, (df.get(term) ?? 0) + 1);
      }
    }
    const stats: Bm25CorpusStats = {
      avgLen: candidates.size > 0 ? totalDocLen / candidates.size : 20,
      docs: candidates.size,
      df
    };

    // enrich with BM25 + recency + importance + pin boost (ADR-0006)
    const now = Date.now();
    const scored: Scored[] = [...candidates.values()].map(({ memory, vectorScore }) => {
      const b = bm25Score(opts.query, memory.text, stats);
      const ageDays = (now - memory.createdAt) / (1000 * 60 * 60 * 24);
      const recencyScore = Math.exp(-ageDays / this.halfLifeDays);
      const strengthScore = memory.strength;
      const w = this.weights;
      const pinBoost = memory.pin ? 0.3 : 0;
      const weighted = {
        vector: w.vector * vectorScore,
        bm25: w.bm25 * b,
        recency: w.recency * recencyScore,
        strength: w.strength * strengthScore
      };
      const score = weighted.vector + weighted.bm25 + weighted.recency + weighted.strength + pinBoost;
      return {
        memory,
        vectorScore,
        bm25Score: b,
        recencyScore,
        score,
        breakdown: { vector: vectorScore, bm25: b, recency: recencyScore, strength: strengthScore, pinBoost, weighted, final: score }
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
    const relevanceOf = (s: Scored) =>
      Math.max(s.bm25Score, this.weights.vector > 0 ? s.vectorScore : 0);
    return relevant.filter(
      (s) =>
        relevanceOf(s) >= threshold ||
        s.score >= threshold ||
        s.memory.id === semanticTopId ||
        s.memory.pin === 1
    );
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
    for (const row of perPartition.flat()) {
      const prev = byId.get(row.memory.id);
      if (!prev || row.score > prev.score) byId.set(row.memory.id, row);
    }
    const scored = [...byId.values()];
    scored.sort((a, b) => (b.score - a.score) || (a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0));

    if (scored.length === 0) {
      return { memories: [], tokensUsed: 0, truncated: false, summary: null, agent: opts.agent, scopes: uniquePartitions };
    }

    // Stage 2: MMR diversify
    const mmrInput = scored.map(
      (s) =>
        ({ id: s.memory.id, score: s.score, embedding: s.memory.embedding, _orig: s }) as unknown as {
          id: string;
          score: number;
          embedding: number[];
          _orig: Scored;
        }
    );
    // MMR order is the order. Re-sorting here by score undid Stage 2: the near-duplicate
    // that MMR demoted went straight back above the diverse pick, so the budget cut it off.
    const diversified = mmr(mmrInput as never[], this.mmrLambda).map((m: unknown) => (m as { _orig: Scored })._orig);

    // Hard budget enforcement. A row that fits whole is kept whole; only a row
    // that does not fit is projected (ADR-0014), because the projection is lossy:
    // measured on the benchmark, projecting *every* long memory cost evidence
    // coverage (any-gold 61.8% → 56.6%, single-hop 55/70 → 43/70) — the gold turn
    // is not always the line that overlaps the question most. Projecting only into
    // leftover space cannot lose a row that already fit.
    const budgetInput = diversified.map((s) => ({
      id: s.memory.id,
      score: s.score,
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
      scopes: uniquePartitions
    };
  }
}
