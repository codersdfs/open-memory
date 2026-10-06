import type { EmbeddingProvider } from "../embedding/provider.js";
import type { VectorStore } from "../store/interface.js";
import type { Memory, ScoreBreakdown, SearchOptions, SearchResult, SearchResultItem } from "../types.js";
import { bm25Score } from "./bm25.js";
import { mmr } from "./mmr.js";
import { countTokens, budgetEnforce } from "./tokens.js";
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
      includeDraft: opts.includeDraft
    });

    // enrich with BM25 + recency + importance + pin boost (ADR-0006)
    const now = Date.now();
    const scored: Scored[] = vectorHits.map(({ memory, vectorScore }) => {
      const b = bm25Score(opts.query, memory.text);
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
    const relevant = scored.filter(
      (s) => s.bm25Score > 0 || s.vectorScore >= VECTOR_FLOOR || s.memory.pin === 1
    );

    // threshold allows empty result (prevents context pollution) — pin forces keep
    return relevant.filter((s) => s.score >= threshold || s.memory.pin === 1);
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
    const diversified = mmr(mmrInput as never[], this.mmrLambda).map((m: unknown) => (m as { _orig: Scored })._orig);

    // sort by score desc before budget
    diversified.sort((a, b) => b.score - a.score);

    // Hard budget enforcement
    const budgetInput = diversified.map((s) => ({
      id: s.memory.id,
      score: s.score,
      recencyScore: s.recencyScore,
      text: s.memory.text
    }));

    // Need to keep mapping to full memory fields; budgetEnforce expects text+score
    const withBudget = budgetEnforce(
      budgetInput.map((b) => ({ ...b, text: b.text, score: b.score })),
      budgetTokens
    );

    // Reconstruct SearchResultItem with token counts and scores
    const kept = new Map(diversified.map((s) => [s.memory.id, s]));
    const memories: SearchResultItem[] = withBudget.kept
      .map((m) => {
        const s = kept.get(m.id);
        if (!s) return null;
        return {
          ...s.memory,
          ...(opts.explain ? { explain: s.breakdown } : {}),
          score: s.score,
          vectorScore: s.vectorScore,
          bm25Score: s.bm25Score,
          recencyScore: s.recencyScore,
          tokens: countTokens(s.memory.text)
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
      tokensUsed: withBudget.tokensUsed,
      truncated: withBudget.truncated,
      summary: withBudget.summary,
      agent: opts.agent,
      scopes: uniquePartitions
    };
  }
}
