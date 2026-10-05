import { describe, it, expect } from "vitest";
import { bm25Score, tokenize } from "../src/core/retrieval/bm25.js";

describe("CJK-aware BM25", () => {
  it("no longer produces zero terms for a Chinese sentence", () => {
    // This is the bug: the old tokenizer returned [] here, so every Chinese
    // query scored 0 against everything.
    expect(tokenize("用什么语言说话").length).toBeGreaterThan(0);
  });

  it("emits unigrams and bigrams", () => {
    const t = tokenize("语言");
    expect(t).toContain("语");
    expect(t).toContain("言");
    expect(t).toContain("语言");
  });

  it("matches a two-character Chinese word", () => {
    const doc = "frank 跟 agent 说话用中文, 他自己输入用英文";
    expect(bm25Score("中文", doc)).toBeGreaterThan(0);
    expect(bm25Score("说话", doc)).toBeGreaterThan(0);
    expect(bm25Score("英文", doc)).toBeGreaterThan(0);
    // Bigrams match the text, not the meaning: "语言" is genuinely not in this
    // doc, so a zero here is correct and is the limit of a lexical recall.
    expect(bm25Score("语言", doc)).toBe(0);
  });

  it("still scores English, and keeps latin tokens from mixed text", () => {
    expect(bm25Score("prefers dark mode", "user prefers dark mode always")).toBeGreaterThan(0);
    expect(tokenize("frank 说话")).toContain("frank");
  });

  it("a non-matching language still scores zero", () => {
    expect(bm25Score("数据库索引", "frank 跟 agent 说话用中文")).toBe(0);
  });

  it("ranks the right doc first", () => {
    const good = "frank 跟 agent 说话用中文";
    const bad = "ADR-0005: flat layers via tags, keep four memory types";
    expect(bm25Score("中文", good)).toBeGreaterThan(bm25Score("中文", bad));
  });
});