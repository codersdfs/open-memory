import type { VectorStore } from "../store/interface.js";

export async function runDecay(store: VectorStore): Promise<number> {
  const olderThanMs = 90 * 24 * 60 * 60 * 1000; // 90 days
  const maxImportance = 0.3;
  // prune episodic low-importance old memories (soft-delete)
  const pruned = await store.prune({ olderThanMs, maxImportance, type: "episodic" });
  // also prune working >7 days regardless
  const workingPruned = await store.prune({ olderThanMs: 7 * 24 * 60 * 60 * 1000, maxImportance: 1.0, type: "working" });
  return pruned + workingPruned;
}
