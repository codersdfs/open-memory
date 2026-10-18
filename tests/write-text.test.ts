import { describe, it, expect } from "vitest";
import { normalizeText, tokenize, lexicalSimilarity, covers, mergeText } from "../src/core/write/text.js";

describe("normalizeText", () => {
  it("folds case, whitespace and trailing punctuation", () => {
    expect(normalizeText("  Use   PNPM!  ")).toBe("use pnpm");
    expect(normalizeText("用 pnpm，不用 npm。")).toBe("用 pnpm，不用 npm");
  });
});

describe("tokenize", () => {
  it("keeps latin words and drops stopwords", () => {
    expect(tokenize("Use the pnpm tool")).toEqual(["use", "pnpm", "tool"]);
  });
  it("emits CJK bigrams so a Chinese sentence never scores zero", () => {
    expect(tokenize("包管理器"))
      .toEqual(expect.arrayContaining(["包管", "管理", "理器"]));
  });
});

describe("lexicalSimilarity", () => {
  it("is 1 for identical meaning after normalisation", () => {
    expect(lexicalSimilarity("use pnpm not npm", "USE pnpm, not NPM!")).toBe(1);
  });
  it("is low for unrelated sentences that share a word", () => {
    expect(lexicalSimilarity("deploy the memory service", "deploy the blog with hugo")).toBeLessThan(0.5);
  });
  it("is 0 when both sides have no tokens", () => {
    expect(lexicalSimilarity("!!!", "???")).toBe(0);
  });
});

describe("covers", () => {
  it("is true only when the new text carries every old token", () => {
    expect(covers("use pnpm", "use pnpm for every install in this repo")).toBe(true);
    expect(covers("use pnpm", "use npm")).toBe(false);
  });
});

describe("mergeText", () => {
  it("adds nothing when the new text already covers the old one", () => {
    expect(mergeText("use pnpm", "use pnpm for every install")).toBe("use pnpm for every install");
  });
  it("keeps the earlier claim behind the marker when it adds information", () => {
    expect(mergeText("use pnpm", "switched to npm yesterday"))
      .toBe("switched to npm yesterday (previously: use pnpm)");
  });
  it("abandons the merge past the 600-char cap", () => {
    const oldText = "x".repeat(500);
    expect(mergeText(oldText, "switched to npm")).toBe("switched to npm");
  });
});
