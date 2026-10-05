import { describe, it, expect } from "vitest";
import { toSections } from "../scripts/wiki-ingest.js";

const ADR = `---
status: Accepted
---

# ADR-0002: Deterministic retrieval without LLM reranker v1

- **Status:** Accepted
- **Options:** A deterministic pipeline vs an LLM reranker.

## Context

Stage 1 scores memories as \`0.6*vector + 0.2*BM25\`, then MMR diversifies.

## Decision

No LLM reranker in v1. A judge would itself burn tokens, defeating the goal.

\`\`\`bash
npm run seed
\`\`\`

## Why solo

Zero migration, one retriever call, high-importance semantic naturally outranks low.
`;

describe("wiki-ingest sections", () => {
  it("splits on headings instead of storing the file whole", () => {
    const s = toSections(ADR);
    expect(s.length).toBeGreaterThan(1);
    expect(s.map((x) => x.heading)).toContain("Decision");
    expect(s.map((x) => x.heading)).toContain("Context");
  });

  it("no section is the whole document", () => {
    for (const s of toSections(ADR)) expect(s.text.length).toBeLessThan(600);
  });

  it("drops code fences — a shell command is not context", () => {
    const all = toSections(ADR).map((s) => s.text).join("\n");
    expect(all).not.toContain("npm run seed");
    expect(all).not.toContain("```");
  });

  it("skips sections with no prose", () => {
    const s = toSections("# Title\n\n## Context\n\nshort\n\n## Real\n\n" + "a real sentence. ".repeat(5));
    expect(s.map((x) => x.heading)).toEqual(["Real"]);
  });

  it("caps sections per file", () => {
    const many = Array.from({ length: 12 }, (_, i) => `## S${i}\n\n${"prose here. ".repeat(10)}`).join("\n\n");
    expect(toSections(many).length).toBeLessThanOrEqual(5);
  });
});