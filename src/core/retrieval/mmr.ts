import { cosineSimilarity } from "../embedding/provider.js";

export interface Scored {
  id: string;
  score: number;
  embedding: number[];
}

/**
 * Maximal Marginal Relevance — greedily pick diverse set.
 * score = lambda * relevance - (1-lambda) * max similarity to already picked.
 */
export function mmr<T extends Scored>(candidates: T[], lambda = 0.6, k?: number): T[] {
  if (candidates.length === 0) return [];
  const n = k ?? candidates.length;
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const selected: T[] = [sorted[0]];
  const remaining = sorted.slice(1);
  while (selected.length < n && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const maxSim = Math.max(...selected.map((s) => cosineSimilarity(cand.embedding, s.embedding)));
      const mmrScore = lambda * cand.score - (1 - lambda) * maxSim;
      if (mmrScore > bestMmr) {
        bestMmr = mmrScore;
        bestIdx = i;
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]);
  }
  return selected;
}
