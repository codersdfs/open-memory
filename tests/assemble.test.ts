import { describe, it, expect } from "vitest";
import { assembleFragment } from "../src/core/retrieval/assemble.js";
import { budgetEnforce, countTokens } from "../src/core/retrieval/tokens.js";

// Read-time projection (ADR-0014). These tests pin the properties that make the
// projection safe to run on every search result: it never touches a memory that
// already fits, it never drops the header that carries the date, and it never
// spends budget that another row could have used.

const session = [
  "Session 3 (2026-03-14)",
  "**Caroline**: we went to the LGBTQ support group yesterday [D3:1]",
  "**Melanie**: that sounds hard [D3:2]",
  "**Caroline**: I also started painting again [D3:3]",
  "**Melanie**: and the pottery class? [D3:4]",
  "**Caroline**: pottery is on Thursdays [D3:5]",
  "**Melanie**: noted [D3:6]",
  "**Caroline**: my favorite book was Charlotte's Web [D3:7]",
  "**Melanie**: thanks for telling me [D3:8]"
].join("\n");

describe("assembleFragment", () => {
  it("returns a memory that already fits untouched", () => {
    const short = "user prefers Simplified Chinese replies [D1:2]";
    const out = assembleFragment(short, { query: "Simplified Chinese", maxTokens: 200 });
    expect(out.trimmed).toBe(false);
    expect(out.text).toBe(short);
    expect(out.tokens).toBe(countTokens(short));
  });

  it("keeps the matching line, its neighbours and the dated header", () => {
    const out = assembleFragment(session, { query: "pottery class Thursdays", maxTokens: 70 });
    expect(out.trimmed).toBe(true);
    expect(out.text).toContain("pottery is on Thursdays [D3:5]");
    // ±1 line: the question that set it up is what makes the answer readable.
    expect(out.text).toContain("the pottery class? [D3:4]");
    expect(out.text).toContain("noted [D3:6]");
    // The header is kept even though it matches no query term: it holds the date,
    // which is the only way a temporal question can be answered from this row.
    expect(out.text).toContain("Session 3 (2026-03-14)");
    expect(out.tokens).toBeLessThanOrEqual(70);
  });

  it("never exceeds the token ceiling, and counts CJK per character", () => {
    const chinese = [
      "ä¼šè¯ 3ï¼ˆ2026-03-14ï¼‰",
      "ç”¨æˆ·è¯´ä»–ä¸Šå‘¨åŽ»äº†æ­å·žï¼Œä½åœ¨è¥¿æ¹–è¾¹ä¸Šçš„é…’åº—ã€‚",
      "ç”¨æˆ·è¿˜æåˆ°ä»–çš„çŒ«å«å’ªå’ªï¼Œç‰¹åˆ«å–œæ¬¢åƒé±¼ã€‚",
      "æˆ‘ä»¬è®¨è®ºäº†éƒ¨ç½²æµç¨‹ï¼šå…ˆè·‘ npm testï¼Œå†è·‘ lintã€‚",
      "ç”¨æˆ·åå¥½ç®€ä½“ä¸­æ–‡å›žå¤ã€‚",
      "æœ€åŽç¡®è®¤äº†ç«¯å£ 8080ã€‚"
    ].join("\n");
    const out = assembleFragment(chinese, { query: "éƒ¨ç½²æµç¨‹ lint", maxTokens: 40 });
    expect(out.tokens).toBeLessThanOrEqual(40);
    expect(out.text).toContain("npm test");
    expect(out.trimmed).toBe(true);
  });

  it("falls back to the head when no query term matches", () => {
    // A row admitted on vector signal alone still has to read as something.
    const out = assembleFragment(session, { query: "quantum chromodynamics", maxTokens: 45 });
    expect(out.text.startsWith("Session 3 (2026-03-14)")).toBe(true);
    expect(out.text).toContain("[D3:1]");
    expect(out.tokens).toBeLessThanOrEqual(45);
  });

  it("splits prose without newlines on sentence boundaries", () => {
    const prose = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} is filler here.`).join(" ") +
      " The deployment runs npm test first.";
    const out = assembleFragment(prose, { query: "deployment npm test", maxTokens: 30 });
    expect(out.trimmed).toBe(true);
    expect(out.text).toContain("npm test");
    expect(out.tokens).toBeLessThanOrEqual(30);
  });
});

describe("budgetEnforce projection", () => {
  const long = { id: "long", score: 1, text: session };
  const short = { id: "short", score: 0.9, text: "a short memory about pottery" };

  it("does not project a row that fits whole", () => {
    const out = budgetEnforce([short], 200, { project: () => "PROJECTED" });
    expect(out.kept[0]!.text).toBe(short.text);
    expect(out.tokensUsed).toBe(countTokens(short.text));
  });

  it("projects only when nothing else could use the space", () => {
    // The fixture session costs 98 tokens. Budget 170: one fits whole, and the
    // only thing ahead is another 98-token row, so the 72 left over is offered to
    // a projection instead of being wasted.
    const out = budgetEnforce([long, { ...long, id: "long2" }], 170, {
      project: (text, maxTokens) => assembleFragment(text, { query: "pottery Thursdays", maxTokens }).text
    });
    expect(out.kept.map((k) => k.id)).toEqual(["long", "long2"]);
    expect(out.kept[1]!.text).toContain("pottery");
    expect(out.tokensUsed).toBeLessThanOrEqual(170);
  });

  it("never spends space a cheaper row behind it would have used", () => {
    // Budget 190: 98 for `long`, 92 left. The 40-token row behind would fit whole,
    // so projecting the 98-token row into those 92 tokens is refused — the row
    // that fits is returned instead.
    const out = budgetEnforce([long, long, { id: "tiny", score: 0.1, text: "x".repeat(160) }], 190, {
      project: (text, maxTokens) => assembleFragment(text, { query: "pottery", maxTokens }).text
    });
    expect(out.kept.map((k) => k.id)).toEqual(["long", "tiny"]);
  });

  it("leaves the row to the overflow summary when the remainder is too small", () => {
    const out = budgetEnforce([long, { ...long, id: "long2" }], 120, { project: () => "tiny" });
    expect(out.kept.map((k) => k.id)).toEqual(["long"]);
    expect(out.summary).not.toBeNull();
  });
});

