import { describe, expect, it } from "vitest";
import type { ScoreBreakdown } from "./api";
import { FLOOR_PRESETS, explainSegments } from "./score";

const explain: ScoreBreakdown = {
  vector: 0,
  bm25: 0.9,
  recency: 0.4,
  strength: 0.5,
  pinBoost: 0,
  weighted: { vector: 0, bm25: 0.54, recency: 0.1, strength: 0.075 },
  final: 0.715,
};

describe("explainSegments", () => {
  it("is bm25, recency, strength, then the total", () => {
    expect(explainSegments(explain).map((s) => [s.key, s.label, s.value])).toEqual([
      ["bm25", "bm25", 0.54],
      ["recency", "recency", 0.1],
      ["strength", "strength", 0.075],
      ["total", "total", 0.715],
    ]);
  });

  it("keeps the total as the last segment", () => {
    const segments = explainSegments(explain);
    expect(segments[segments.length - 1]?.value).toBe(explain.final);
  });
});

describe("FLOOR_PRESETS", () => {
  it("carries the README's three floors", () => {
    expect(FLOOR_PRESETS.map((p) => p.value)).toEqual([0.72, 0.35, 0.2]);
  });
});
