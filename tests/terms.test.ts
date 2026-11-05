import { describe, expect, it } from "vitest";
import { coverage, indexTerms, queryTerms } from "../src/core/retrieval/terms.js";
import { tokenize } from "../src/core/retrieval/bm25.js";

// The invariant that lets a stop list sit in front of an inverted index without
// silently pricing queries out of the corpus (ADR-0027). If this test ever fails,
// `df` in the term index no longer matches what a query asks for.
describe("index/query term invariant", () => {
  const samples = [
    "",
    "the quick brown fox",
    "用户喜欢简洁的回复",
    "bench-project-3 里的 zq1042 是怎么配置的",
    "Convention in project-3: the retry policy for payments is zq1042, and it is idempotent.",
    "项目 project-3 的约定：支付 的流程使用 zq1042，并且它 是幂等的。",
    "数据库迁移需要先备份",
    "the deployment pipeline uses kubernetes",
    "MEMORY_Q8=on 只对 384 维生效",
    "什么怎么如何为什么可以应该需要"
  ];

  it("keeps every indexed term reachable from the query side", () => {
    for (const text of samples) {
      const indexed = new Set(indexTerms(text));
      const query = new Set(queryTerms(text));
      for (const term of indexed) {
        expect(query.has(term), `"${term}" indexed from "${text}" but not queried`).toBe(true);
      }
    }
  });

  it("is a subset of raw tokenize — nothing is invented", () => {
    for (const text of samples) {
      const raw = new Set(tokenize(text));
      for (const term of indexTerms(text)) expect(raw.has(term), term).toBe(true);
      for (const term of queryTerms(text)) expect(raw.has(term), term).toBe(true);
    }
  });
});

describe("indexTerms", () => {
  it("preserves repeats so tf can be counted", () => {
    const terms = indexTerms("budget budget budget");
    expect(terms.filter((t) => t === "budget")).toHaveLength(3);
  });

  it("drops CJK function words but keeps content", () => {
    const terms = indexTerms("项目 project-3 的约定：支付的流程使用 zq1042，并且它是幂等的");
    expect(terms).toContain("zq1042");
    expect(terms).toContain("支付");
    expect(terms).not.toContain("的");
    expect(terms).not.toContain("并且");
  });

  it("drops closed-class latin words but keeps identifiers intact", () => {
    const terms = indexTerms("the retry policy for this endpoint is idempotent");
    expect(terms).toContain("retry");
    expect(terms).toContain("endpoint");
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("this");
    expect(terms).not.toContain("is");
  });

  it("keeps a lone CJK content character but drops a lone function character", () => {
    expect(indexTerms("猫")).toContain("猫");
    expect(indexTerms("的")).toHaveLength(0);
  });
});

describe("queryTerms", () => {
  it("dedupes and preserves order", () => {
    expect(queryTerms("budget parser budget")).toEqual(["budget", "parser"]);
  });

  it("shrinks a conversational CJK question to its evidence", () => {
    // Before ADR-0027 this produced ~18 tokens, most of them function words and
    // straddle bigrams (「么配」, 「置的」), and the candidate fetch kept the eight
    // rarest — which crowded the gold row out of the shortlist. 「配置」 stays:
    // it is real content, and dropping it would be over-filtering dressed as
    // relevance.
    const terms = queryTerms("bench-project-3 里的 zq1042 是怎么配置的");
    expect(terms).toContain("zq1042");
    expect(terms).toContain("配置");
    expect(terms).not.toContain("的");
    expect(terms).not.toContain("怎么");
    expect(terms).not.toContain("么配");
    expect(terms).not.toContain("置的");
    expect(terms).not.toContain("是怎");
  });

  it("keeps a CJK term that the index also keeps, never a one-sided filter", () => {
    const q = queryTerms("数据库迁移需要先备份");
    expect(q).toContain("迁移");
    expect(q).not.toContain("需要");
    // The index keeps 「数据」/「据库」; the query must still be able to ask for them.
    expect(q).toContain("数据");
    expect(q).toContain("据库");
  });

  it("returns nothing for a query made only of function words", () => {
    expect(queryTerms("的是了在和")).toEqual([]);
  });
});

// The score the gate and the ranking read instead of BM25's normalized value,
// which cannot separate a row holding the marker from a row that merely shares
// the question's grammar. Numbers below are the bench corpus's own shapes.
describe("coverage", () => {
  const question = "bench-project-0 里的 zq1064 是怎么配置的";

  it("counts a word the text holds, not the bigram it was cut into", () => {
    // 「配置」 is one asked word and the text holds it, so it counts once. Its
    // halves 配 and 置 are the same word and must not count again — before the
    // dedupe a single matched word was worth three of the six asked, and a row
    // holding only 「的」 and 「置」 cleared the same bar as one holding 「配置」.
    // Four of the six asked words here: 配置, bench, project, zq1064.
    const holdsConfig = "项目 bench-project-0 的约定：配置使用 zq1064，并且它先备份。";
    expect(coverage(holdsConfig, question)).toBeGreaterThan(0.5);
    // Without the word itself only its halves rhyme, which is less evidence.
    expect(coverage("配 zq1064 置", question)).toBeLessThan(coverage(holdsConfig, question));
    // A bare function character is not evidence even when the text is full of it.
    expect(coverage("的的的", question)).toBe(0);
  });

  it("separates the row that holds the marker from one that only rhymes with the question", () => {
    const gold =
      "Convention in bench-project-0: the index for cli is zq1064, and it fails silently when the WAL is on a network drive.";
    const filler = "项目 bench-project-1 的约定：cli 的流程使用 zq1073，并且它 returns stale rows。";
    expect(coverage(gold, question)).toBeGreaterThan(coverage(filler, question));
    expect(coverage(gold, question)).toBeGreaterThanOrEqual(0.5);
    expect(coverage(filler, question)).toBeLessThanOrEqual(0.5);
  });

  it("scores zero for a text sharing no content word", () => {
    expect(coverage("user lives in Berlin and prefers answers in German", question)).toBe(0);
  });

  it("scores a plain word match in full", () => {
    expect(coverage("user lives in Berlin", "Berlin")).toBe(1);
    expect(coverage("the cache budget is 800 tokens", "cache budget")).toBe(1);
  });
});
