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

  it("caps one turn at maxPerTurn", async () => {
    const many = "I like tea. I like coffee. I like water. I like juice. I like milk. I like soda.";
    expect((await ex.extract(many)).length).toBeLessThanOrEqual(3);
  });
});
