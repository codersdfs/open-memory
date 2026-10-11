/**
 * Small statistics helpers, kept out of the stores so both can share them.
 *
 * `byVectorDim` is the MIN/MAX sweep `SqliteVectorStore.storedDim()`'s own comment asks
 * for, done one level up: that method still reads a single row because it feeds the
 * startup guard, which is load-bearing — this counts every row instead, so a partly
 * migrated store's widths are a number rather than a latent hazard.
 */

import type { Memory, MemoryStatus, MemoryType } from "./types.js";
import { STATUSES, TYPES } from "./types.js";

/** Median of the values, 0 when there are none. Even counts average the middle pair. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Same numbers as src/core/lifecycle/decay.ts. Duplicated on purpose: the UI has to
// be able to *preview* what decay will prune, and the preview must not be able to
// drift from the button that actually prunes.
const EPISODIC_DECAY_MS = 90 * DAY_MS;
const WORKING_DECAY_MS = 7 * DAY_MS;
const LOW_IMPORTANCE = 0.3;

const STRENGTH_BUCKETS = ["0-0.2", "0.2-0.4", "0.4-0.6", "0.6-0.8", "0.8-1"];
const AGE_BUCKETS = ["<1d", "1-7d", "7-30d", "30-90d", ">90d"];

export interface StatsBucket {
  label: string;
  count: number;
}

/** Compact on purpose — a candidate list with every 384-float embedding in it is not a preview. */
export interface DecayCandidate {
  id: string;
  type: MemoryType;
  createdAt: number;
  importance: number;
  strength: number;
  isDeleted: number;
  text: string;
}

export interface StatsSummary {
  total: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  active: number;
  deleted: number;
  pinned: number;
  /** Strength above its write-time value, or actually retrieved at least once. */
  reinforced: number;
  neverUsed: number;
  supersedesLinks: number;
  supersedeHeads: number;
  strength: StatsBucket[];
  age: StatsBucket[];
  decayCandidates: DecayCandidate[];
  textChars: number;
  /** `length / 4`, the same heuristic the budget uses. A size, never a "saving". */
  textTokensEstimate: number;
  /** Rows per embedding width, tombstones included. Widths are keys because JSON. */
  byVectorDim: Record<string, number>;
}

/**
 * Everything the stats view shows, computed from rows that already exist.
 *
 * No recall log is read and none is written: the store does not persist a search
 * response, so any "tokens saved" figure would be invented. What it can say
 * honestly is what it holds, how strong it is, and what decay would take.
 */
export function summarize(memories: Memory[], now: number): StatsSummary {
  const byType: Record<string, number> = Object.fromEntries(TYPES.map((t) => [t, 0]));
  const byStatus: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const strength = STRENGTH_BUCKETS.map((label) => ({ label, count: 0 }));
  const age = AGE_BUCKETS.map((label) => ({ label, count: 0 }));
  const decayCandidates: DecayCandidate[] = [];
  const byVectorDim: Record<string, number> = {};
  const heads = new Set<string>();
  let pins = 0, deleted = 0, active = 0, reinforced = 0, neverUsed = 0, supersedesLinks = 0, textChars = 0;

  for (const m of memories) {
    byType[m.type] = (byType[m.type] ?? 0) + 1;
    byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
    if (m.pin) pins++;
    if (m.isDeleted) deleted++; else active++;
    if (m.lastUsedAt !== null || m.strength > m.importance) reinforced++; else neverUsed++;
    if (m.supersedesId) { supersedesLinks++; heads.add(m.supersedesId); }
    textChars += m.text.length;
    // Every row, tombstones included, and a row with no vector is width 0.
    const width = String((m.embedding ?? []).length);
    byVectorDim[width] = (byVectorDim[width] ?? 0) + 1;

    const sIdx = Math.min(STRENGTH_BUCKETS.length - 1, Math.max(0, Math.floor(m.strength / 0.2)));
    strength[sIdx]!.count++;
    const days = (now - m.createdAt) / DAY_MS;
    const aIdx = days < 1 ? 0 : days < 7 ? 1 : days < 30 ? 2 : days < 90 ? 3 : 4;
    age[aIdx]!.count++;

    if (m.isDeleted) continue;
    const stale = m.type === "episodic" ? days > 90 && m.importance <= LOW_IMPORTANCE : m.type === "working" && days > 7;
    if (stale) {
      decayCandidates.push({
        id: m.id, type: m.type, createdAt: m.createdAt, importance: m.importance,
        strength: m.strength, isDeleted: m.isDeleted, text: m.text.slice(0, 120)
      });
    }
  }

  return {
    total: memories.length, byType, byStatus, active, deleted, pinned: pins,
    reinforced, neverUsed, supersedesLinks, supersedeHeads: heads.size,
    strength, age, decayCandidates, textChars, textTokensEstimate: Math.round(textChars / 4), byVectorDim
  };
}
