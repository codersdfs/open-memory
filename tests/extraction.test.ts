import { describe, it, expect } from "vitest";
import { Extractor } from "../src/core/extraction/extractor.js";

describe("extraction gate", () => {
  const ex = new Extractor();

  it("keeps durable facts", async () => {
    const kept = await ex.extract("I live in Berlin. I prefer dark mode. Remember to run npm test before commit.");
    const texts = kept.map((m) => m.text);
    expect(texts).toContain("I live in Berlin");
    expect(texts).toContain("I prefer dark mode");
    expect(texts.some((t) => t.includes("run npm test before commit"))).toBe(true);
    expect(kept.find((m) => m.text.includes("Berlin"))?.type).toBe("semantic");
  });

  it("drops questions and agent instructions", async () => {
    const kept = await ex.extract("Where does the user live? Read the file first. Use the hash provider.");
    expect(kept).toEqual([]);
  });

  it("drops identifier soup", () => {
    expect(Extractor.isWorthKeeping("memoryService.ts:42")).toBe(false);
    expect(Extractor.isWorthKeeping("memoryService.ts")).toBe(false);
    expect(Extractor.isWorthKeeping("I live in Berlin")).toBe(true);
  });

  // Measured against a real store: these scored 0.07-0.21 with the judge and were
  // still stored, because the judge has no key by default and the regex let them in.
  it("drops a spoken question that has no question mark", () => {
    expect(Extractor.isWorthKeeping("what next to ship this")).toBe(false);
    expect(Extractor.isWorthKeeping("how to look at it")).toBe(false);
    expect(Extractor.isWorthKeeping("now finish the task")).toBe(false); // leading adverb + verb
    expect(Extractor.isWorthKeeping("continue")).toBe(false); // a bare go-on
    expect(Extractor.isWorthKeeping("give me a compare list of this and other agent memory")).toBe(false);
    expect(Extractor.isWorthKeeping("is the memory system vector")).toBe(false);
  });

  // The exceptions carry more weight than the rule: these open with a word that
  // would otherwise drop them, and all three are exactly what the store is for.
  it("keeps a procedure, an order, and a dated decision", () => {
    expect(Extractor.isWorthKeeping("How to deploy the memory UI: npm run memory:ui")).toBe(true);
    expect(Extractor.isWorthKeeping("Do not force push to main")).toBe(true);
    expect(Extractor.isWorthKeeping("Don't commit the .env file")).toBe(true);
    expect(Extractor.isWorthKeeping("May 5 we decided to drop qdrant")).toBe(true);
  });

  // "how to X" is the hard pair: same opener, opposite meaning. The colon separates
  // a procedure carrying its steps from a question missing its answer.
  it("drops 'how to' with no answer attached", () => {
    expect(Extractor.isWorthKeeping("how to look at it")).toBe(false);
    expect(Extractor.isWorthKeeping("what to do when the daemon is stale")).toBe(false);
    expect(Extractor.isWorthKeeping("How to deploy the memory UI: npm run memory:ui")).toBe(true);
  });

  it("caps one turn at maxPerTurn", async () => {
    const many = "I like tea. I like coffee. I like water. I like juice. I like milk. I like soda.";
    expect((await ex.extract(many)).length).toBeLessThanOrEqual(3);
  });
});
