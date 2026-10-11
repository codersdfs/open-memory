/**
 * The recall score decomposition (ticket D4) and the floor presets that make the
 * HTTP/agent divergence visible instead of documented.
 */

import type { ScoreBreakdown } from "./api";

/** One row of the stacked bar. `value` is already weighted, so the bars sum to the total. */
export interface ScoreSegment {
  key: string;
  label: string;
  value: number;
}

/**
 * The decomposition plus its total, in stacking order.
 *
 * Values come from `explain.weighted` (src/core/types.ts:115) — the terms after
 * `0.6*bm25 + 0.25*recency + 0.15*strength` (README.md:6) — so the three bars are
 * the contribution, not the raw sub-score, and they sum to `final` as long as the
 * vector weight stays 0 (src/core/types.ts:110 `weighted.vector`, and README.md:6
 * "vector weight is 0 by default"). `weighted.vector` and `pinBoost` are left out
 * of the stack: the console shows bm25 / recency / strength.
 */
export function explainSegments(explain: ScoreBreakdown): ScoreSegment[] {
  return [
    { key: "bm25", label: "bm25", value: explain.weighted.bm25 },
    { key: "recency", label: "recency", value: explain.weighted.recency },
    { key: "strength", label: "strength", value: explain.weighted.strength },
    { key: "total", label: "total", value: explain.final },
  ];
}

/**
 * The relevance floors, as preset buttons (ticket D4).
 *
 * README.md:99 `| HTTP / UI (this server) | **0.72** |` and README.md:100
 * `| pi memory_search ... | **0.35** English / **0.2** Chinese |` — the same
 * divergence, made clickable. These are the README's numbers, not invented ones.
 */
export const FLOOR_PRESETS = [
  { key: "http", label: "HTTP", value: 0.72 },
  { key: "agent-en", label: "agent EN", value: 0.35 },
  { key: "agent-cn", label: "agent CN", value: 0.2 },
] as const;
