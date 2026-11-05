import { describe, it, expect } from "vitest";
import { SyntheticEmbeddingProvider, features, seedOf, sharesFeature } from "../src/core/embedding/synthetic.js";
import { cosineSimilarity, type EmbeddingProvider } from "../src/core/embedding/provider.js";
import { buildCorpus, buildQueries, rankOf, sigPhrase } from "../src/bench/realtime.js";

/**
 * The synthetic embedder exists so the bench can run with a vector path that actually
 * discriminates: under the default `hash` provider `hybrid.ts` sets `weights.vector`
 * to 0 and a vector-recall regression is invisible. That makes "does it discriminate"
 * a load-bearing property, not a nice-to-have — so it is measured here rather than
 * asserted, against the same corpus the bench uses.
 */

const provider: EmbeddingProvider = new SyntheticEmbeddingProvider();

/** Mean pairwise cosine over a sample, for the "unrelated text is far" baseline. */
function meanCosine(a: number[], others: number[][]): number {
  if (others.length === 0) return 0;
  return others.reduce((sum, b) => sum + cosineSimilarity(a, b), 0) / others.length;
}

describe("synthetic embedder: shape and determinism", () => {
  it("is an EmbeddingProvider with the advertised name and dimension", () => {
    expect(provider.name).toBe("synthetic");
    // Not "hash": `hybrid.ts` zeroes weights.vector for that name, which is exactly
    // the blindness this embedder was added to end.
    expect(provider.name).not.toBe("hash");
    expect(provider.dim).toBe(2048);
    expect(new SyntheticEmbeddingProvider({ dim: 128 }).dim).toBe(128);
  });

  it("returns unit vectors of exactly dim, with no NaN", async () => {
    for (const text of ["", "a", "hello world", "项目 bench-project-1 的约定", "zq1042"]) {
      const v = await provider.embed(text);
      expect(v).toHaveLength(provider.dim);
      expect(v.every((x) => Number.isFinite(x))).toBe(true);
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      // The empty string has no features, so its norm is 0 by definition; everything
      // else is L2-normalised so cosine is a dot product.
      if (text !== "") expect(norm).toBeCloseTo(1, 6);
    }
  });

  it("is deterministic: same text, same vector, across instances and calls", async () => {
    const text = "项目 bench-project-2 的约定：storage 的流程使用 zq1010（late ordering i #10）";
    const a = await provider.embed(text);
    const b = await provider.embed(text);
    const c = await new SyntheticEmbeddingProvider().embed(text);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    // And across processes: the hash is integer arithmetic, no Date/random/float drift.
    expect(seedOf("hello")).toBe(seedOf("hello"));
  });

  it("embeds a batch consistently with embed()", async () => {
    const texts = ["one", "two", "三", "one two three"];
    const batch = await provider.embedBatch(texts);
    expect(batch).toHaveLength(texts.length);
    for (let i = 0; i < texts.length; i++) {
      expect(batch[i]).toEqual(await provider.embed(texts[i]!));
    }
  });

  it("ignores the hash provider's failure mode: CJK text still has features", async () => {
    // The hash provider tokenises with split(/[^a-z0-9]+/), so a CJK string yields no
    // tokens at all and its vector is pure length noise. Here every CJK bigram is a
    // feature, so two Chinese sentences about the same thing are closer than two about
    // different things.
    const a = await provider.embed("项目 bench-project-1 的约定：storage 的流程使用 zq1001（stale second ii #1）");
    const same = await provider.embed("项目 bench-project-1 的约定：storage 的流程使用 zq1001（stale second ii #1）");
    const near = await provider.embed("项目 bench-project-1 的约定：storage 的流程使用 zq1002（stale second iii #2）");
    const other = await provider.embed("完全不同的另一段文字，讲的是别的事情");
    expect(cosineSimilarity(a, same)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(a, near)).toBeGreaterThan(cosineSimilarity(a, other));
  });
});

describe("synthetic embedder: discrimination", () => {
  it("scores two texts about the same subject above two unrelated texts", async () => {
    const pairs: [string, string, string][] = [
      [
        "the parser must run after the schema migration",
        "a migration that leaves the schema stale breaks the parser",
        "the deployment script emails the release notes"
      ],
      [
        "项目 bench-project-0 的约定：auth 的流程必须先迁移 schema",
        "auth 流程要等 schema 迁移完成才能继续",
        "快取失效通常发生在深夜的低谷时段"
      ],
      [
        "returns stale rows until the second pass",
        "stale rows come back on the first pass and clear on the second",
        "the logo is a rounded square in our brand palette"
      ]
    ];
    for (const [a, b, c] of pairs) {
      const [va, vb, vc] = await provider.embedBatch([a, b, c]);
      const related = cosineSimilarity(va!, vb!);
      const unrelated = cosineSimilarity(va!, vc!);
      expect(related).toBeGreaterThan(unrelated);
      // Not a knife edge: a meaningful margin, or the vector score is noise dressed up.
      expect(related - unrelated).toBeGreaterThan(0.1);
    }
  });

  it("ranks a row above its neighbours for the questions the gate asks", async () => {
    // The question the gate actually asks. Same corpus, same generator, same scoring:
    // pure cosine over the row text, no BM25, no fusion, no recency. Whatever hybrid
    // does on top of this only raises the number.
    //
    // Measured floors, not aspirations: across corpus seeds 7/3/99 this reads top1
    // 0.46-0.60 and top5 0.94-1.00. A regression that breaks the vector path, or
    // flattens the features, lands far below these.
    for (const seed of [7, 3]) {
      const corpus = buildCorpus({ facts: 400, projects: 4, seed });
      const semantic = buildQueries(corpus, { queries: 40, seed: 11, projects: 4 }).filter(
        (q) => q.mode === "semantic"
      );
      expect(semantic.length).toBeGreaterThan(8);

      const vectors = await provider.embedBatch(corpus.map((f) => f.text));
      const byToken = new Map(corpus.map((f, i) => [f.token, i]));

      let top1 = 0;
      let top5 = 0;
      for (const q of semantic) {
        const goldIndex = byToken.get(q.token)!;
        const qv = await provider.embed(q.query);
        const scored = vectors.map((v, i) => ({ i, sim: cosineSimilarity(qv, v) }));
        scored.sort((x, y) => y.sim - x.sim);
        const rank = scored.findIndex((s) => s.i === goldIndex) + 1;
        if (rank === 1) top1++;
        if (rank <= 5) top5++;
      }
      expect(top5 / semantic.length).toBeGreaterThan(0.8);
      expect(top1 / semantic.length).toBeGreaterThan(0.3);
    }
  });

  it("shares the terms a question's subject depends on", async () => {
    // Why the identifier parts and the noun both matter. `bench-project-3 api decay`
    // is everything the gold row is about; if the embedder only kept the whole hyphenated
    // identifier, this scored 16th of 400 — worse than the term index it is meant to
    // complement, because the template's bigrams gave every row a similar score.
    const corpus = buildCorpus({ facts: 400, projects: 4, seed: 7 });
    const gold = corpus.find((f) => f.token === "zq1307")!;
    for (const word of [gold.project, "bench", "project", gold.area, gold.noun]) {
      expect(sharesFeature(`${gold.project} ${gold.area} ${gold.noun}`, gold.text)).toBe(true);
      expect(gold.text.toLowerCase()).toContain(word);
    }
    // Identifier parts are features of their own, so a question about project 3 also
    // touches row 3's project string without needing the whole thing.
    expect(features("bench-project-3")).toEqual(expect.arrayContaining(["bench-project-3", "bench", "project", "3"]));
    // And no feature survives as the raw identifier only.
    expect(features("a_b-c")).toEqual(expect.arrayContaining(["a_b-c", "a", "b", "c"]));
  });

  it("separates unrelated corpus rows, so neighbours in the corpus are not all peers", async () => {
    const corpus = buildCorpus({ facts: 200, projects: 4, seed: 7 });
    const vectors = await provider.embedBatch(corpus.map((f) => f.text));
    const self = vectors[0]!;
    const others = vectors.slice(1, 50);
    // Unrelated rows average a lowish cosine; the row itself is exactly 1.
    expect(cosineSimilarity(self, self)).toBeCloseTo(1, 6);
    expect(meanCosine(self, others)).toBeLessThan(0.9);

    const [a, b] = await provider.embedBatch([corpus[0]!.text, corpus[1]!.text]);
    expect(cosineSimilarity(a!, b!)).toBeLessThan(cosineSimilarity(self, self));
  });
});

describe("features", () => {
  it("shares a feature only when texts share a character n-gram or word", () => {
    expect(sharesFeature("late ordering i #10", "a late ordering i #10 case")).toBe(true);
    expect(sharesFeature("stale second pass", "stale rows")).toBe(true);
    // Character trigrams carry across word boundaries, so this is the strongest form.
    expect(sharesFeature("qwertyuiop", "asdfghjkl")).toBe(false);
    expect(sharesFeature("", "anything")).toBe(false);
  });
});

describe("semantic query mode with the synthetic embedder", () => {
  it("has a gold row a cosine can identify and the term index cannot shortcut", async () => {
    // The two halves of the claim the gate rests on:
    //   the phrase names exactly one row (so the question has an answer), and
    //   the marker is absent (so the term index cannot answer it by lookup).
    const corpus = buildCorpus({ facts: 400, projects: 4, seed: 7 });
    const byToken = new Map(corpus.map((f) => [f.token, f]));
    const semantic = buildQueries(corpus, { queries: 40, seed: 11, projects: 4 }).filter(
      (q) => q.mode === "semantic"
    );
    expect(semantic.length).toBeGreaterThan(0);

    for (const q of semantic) {
      const gold = byToken.get(q.token)!;
      expect(q.query).not.toMatch(/zq\d+/);

      const phrase = sigPhrase(gold);
      const framed = new RegExp(`(?:a ${phrase} case|（${phrase}）)`);
      expect(corpus.filter((f) => framed.test(f.text)).map((f) => f.token)).toEqual([gold.token]);

      // `rankOf` scores the gold even though the query never held the marker: it looks
      // for the marker inside the *returned text*, not inside the question.
      expect(rankOf([corpus[0]!.text], gold.token)).toBe(corpus[0]!.token === gold.token ? 1 : null);
      expect(rankOf([], gold.token)).toBeNull();
    }
  });

  it("scores a returning gold row through rankOf exactly as the bench does", async () => {
    const corpus = buildCorpus({ facts: 200, projects: 4, seed: 7 });
    const semantic = buildQueries(corpus, { queries: 40, seed: 11, projects: 4 }).filter(
      (q) => q.mode === "semantic"
    );
    const q = semantic[0]!;
    const gold = corpus.find((f) => f.token === q.token)!;

    // A retriever that returns the gold first, second, or not at all.
    expect(rankOf([gold.text, corpus[1]!.text], q.token)).toBe(1);
    expect(rankOf([corpus[1]!.text, gold.text], q.token)).toBe(2);
    expect(rankOf([corpus[1]!.text, corpus[2]!.text], q.token)).toBeNull();

    // And when the cosine ranks the corpus for this question, rankOf finds the same
    // row at the cosine's rank — the bench's scoring and the embedding agree.
    const qv = await provider.embed(q.query);
    const vectors = await provider.embedBatch(corpus.map((f) => f.text));
    const scored = corpus.map((f, i) => ({ f, sim: cosineSimilarity(qv, vectors[i]!) }));
    scored.sort((a, b) => b.sim - a.sim);
    const ranked = scored.slice(0, 10).map((s) => s.f.text);
    const cosineRank = scored.findIndex((s) => s.f.token === q.token) + 1;
    if (cosineRank <= 10) expect(rankOf(ranked, q.token)).toBe(cosineRank);
    else expect(rankOf(ranked, q.token)).toBeNull();
  });
});
