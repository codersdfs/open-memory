import { type EmbeddingProvider, normalize } from "./provider.js";

/**
 * A deterministic embedder that actually *discriminates* — for the benchmark.
 *
 * Why it exists (leg B of the retrieval-regression work). `HybridRetriever` sets
 * `weights.vector = 0` when `embedder.name === "hash"`, so under the bench's default
 * every vector signal is dead: no cosine in the score, no semantic gate, no
 * `relevanceOf` term. The bench's queries all carry a rare marker, so the term index
 * alone reaches the gold row and recall@5 reads 1.00 — which is how a rejected IVF
 * index kept its gates green while shortlist recall@5 fell to 43.8%. There was no
 * measurement in this repo that could see a vector-recall regression.
 *
 * The hash embedder cannot stand in, and not only because of the weight: its
 * tokenizer splits on `[^a-z0-9]+`, so a Chinese question produces zero tokens and
 * its vector is decided by `charCodeAt` — noise. This one tokenizes the way the term
 * index does (CJK unigrams+bigrams, Latin words) so both scripts carry real features,
 * then signs-hashes them into a fixed width.
 *
 * WHAT IT IS NOT: a language model. Two texts score high only when they share
 * features, so "returns stale rows" and "stale rows come back" are close but
 * "the cache is stale" and "cache invalidation is stale" are only as close as their
 * shared words. It is a controlled, offline stand-in for the *shape* of a real
 * embedding: one where cosine means something, so a regression in the vector path
 * becomes visible as a recall drop.
 *
 * Determinism, not statelessness: there is no TF-IDF and no warm-up corpus — the
 * vector for a text is a pure function of the text. Two processes, two machines and
 * two runs of the bench get byte-identical vectors, which is what lets recall be a
 * gate rather than a coin flip.
 *
 * Signed hashing is load-bearing. Without the sign, a hash collision always adds a
 * positive dot product and nothing cancels: measured on 400 bench facts at 1024 dims,
 * the mean cosine of two unrelated rows climbs to ~0.38 and every row looks alike.
 * With it, unrelated rows sit near zero and a shared feature stands out.
 */

/**
 * Published name. Must NOT be `"hash"`: `hybrid.ts` derives `weights.vector` from
 * `embedder.name`, so a synthetic embedder wearing that name would contribute
 * nothing and the bench would keep its blind spot.
 */
export const SYNTHETIC_EMBEDDER_NAME = "synthetic";

/** Width of the published preset — matches the NIM preset, so the bench's cost shape is the same. */
export const SYNTHETIC_DIM = 2048;

/** Same script classes the term index uses (`bm25.ts`), so both sides see one vocabulary. */
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const CJK_ANY = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

export interface SyntheticEmbedderOptions {
  /** Output width. Bigger is fewer collisions, at linear cost per vector. */
  dim?: number;
}

export class SyntheticEmbeddingProvider implements EmbeddingProvider {
  readonly name = SYNTHETIC_EMBEDDER_NAME;
  readonly dim: number;
  /** A pure function of text has no weights, so there is no model to report. */
  readonly model: string | null = null;

  constructor(opts: SyntheticEmbedderOptions = {}) {
    const dim = Math.floor(opts.dim ?? SYNTHETIC_DIM);
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(`synthetic embedder dim must be a positive integer, got ${opts.dim}`);
    }
    this.dim = dim;
  }

  async embed(text: string, _opts?: { inputType?: string }): Promise<number[]> {
    return embedSynthetic(text, this.dim);
  }

  async embedBatch(texts: string[], _opts?: { inputType?: string }): Promise<number[][]> {
    return texts.map((t) => embedSynthetic(t, this.dim));
  }
}

/**
 * The vector for one text: L2-normalized, log-TF weighted, signed feature hashing.
 *
 * Log-TF rather than raw counts because one row repeating a word four times should
 * not outvote four rows that mention it once. No IDF: it would need a corpus, an
 * embedder that changes its answer depending on who else is stored is not something
 * a recall gate can be built on.
 */
export function embedSynthetic(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  for (const [feature, count] of featureCounts(text)) {
    const h = seedOf(feature);
    const sign = (h >>> 31) === 1 ? -1 : 1;
    vec[h % dim] += sign * (1 + Math.log(count));
  }
  return normalize(vec);
}

/**
 * Features of a text, with counts. Exported because the tests assert that the same
 * text always produces the same features — the property the whole gate rests on.
 *
 * CJK runs yield unigrams *and* bigrams: Chinese has no spaces, most words are two
 * characters, and a one-character query ("缓存" asking about "缓存失效") has to be
 * reachable. Latin/other text is split on `[^a-z0-9_]+`. This is `bm25.ts`'s
 * tokenizer without the stopword filter: a function-word bigram still carries a
 * little signal about topic, and the filter belongs to scoring, not to embedding.
 */
export function features(text: string): string[] {
  return [...featureCounts(text).keys()];
}

function featureCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (f: string) => counts.set(f, (counts.get(f) ?? 0) + 1);
  const lower = text.toLowerCase();

  for (const run of lower.match(CJK_RUN) ?? []) {
    const chars = [...run];
    for (let i = 0; i < chars.length; i++) {
      add(chars[i]!);
      if (i + 1 < chars.length) add(chars[i]! + chars[i + 1]!);
    }
  }

  for (const word of lower.replace(CJK_ANY, " ").split(/[^a-z0-9_-]+/)) {
    if (!word) continue;
    add(word);
    // A hyphenated or underscored identifier is also its parts (`bench-project-3` ->
    // `bench`, `project`, `3`). Measured, this matters more than it looks: with the
    // identifier alone, `bench-project-3 api decay` — every content word the row has —
    // ranked the row 16th of 400, because four shared tokens gave a dot product of
    // ~0.35 while the template's letter bigrams gave every row ~0.4. The parts are what
    // the term index matches on, so the vector has to share them too or it ranks worse
    // than the thing it is supposed to complement.
    if (/[-_]/.test(word)) {
      for (const part of word.split(/[-_]+/)) if (part) add(part);
    }
  }
  return counts;
}

/** FNV-1a. Exported for the determinism test; the sign and the bucket both come from it. */
export function seedOf(feature: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < feature.length; i++) {
    h ^= feature.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Do two texts share a *feature*, not a word? The question the bench's `semantic`
 * gate turns on: a gold row reachable only through a shared word is a question the
 * term index can answer, and measuring it would tell us nothing about the vector path.
 */
export function sharesFeature(a: string, b: string): boolean {
  const other = new Set(features(b));
  return features(a).some((f) => other.has(f));
}
