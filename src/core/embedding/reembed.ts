import type { EmbeddingProvider } from "./provider.js";
import type { VectorStore } from "../store/interface.js";

export interface ReembedResult {
  partitions: number;
  scanned: number;
  rewritten: number;
  failed: { id: string; error: string }[];
}

/**
 * Rewrite every stored vector using the current embedder.
 *
 * Changing `EMBEDDING_PROVIDER` invalidates every vector in the file. That is not a
 * ranking problem, it is an impossibility: cosine between a 384-dim hash vector and a
 * 1536-dim OpenAI one is undefined, which is why `MemoryService.init` refuses to serve
 * such a store. This function is what that error message points at, so it takes the
 * raw store rather than the service — it is the way out, not another victim of it.
 *
 * Archived, draft and soft-deleted rows are included. `restore` is a supported
 * command, and a restored row still carrying an old-width vector would make the next
 * search in its partition fail. Re-embedding a few dead rows is much cheaper than
 * that landmine.
 *
 * A failing row is reported, not thrown: a provider that chokes on one document
 * should not cost the other 499 their migration. Callers decide what to do with the
 * failures — the CLI exits non-zero, which keeps it visible in a script.
 */
export async function reembedAll(
  store: VectorStore,
  embedder: EmbeddingProvider,
  opts: {
    batchSize?: number;
    dryRun?: boolean;
    onProgress?: (done: number, total: number) => void;
  } = {}
): Promise<ReembedResult> {
  const batchSize = Math.max(1, opts.batchSize ?? 64);
  const partitions = await store.distinctNamespaces({ includeDeleted: true });

  const rows: { id: string; text: string }[] = [];
  for (const namespace of partitions) {
    for (let offset = 0; ; offset += 500) {
      const page = await store.list({
        namespace,
        limit: 500,
        offset,
        includeArchived: true,
        includeDraft: true,
        includeDeleted: true
      });
      rows.push(...page.memories.map((m) => ({ id: m.id, text: m.text })));
      if (page.memories.length < 500) break;
    }
  }

  const result: ReembedResult = { partitions: partitions.length, scanned: rows.length, rewritten: 0, failed: [] };
  if (opts.dryRun) return result;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    // "passage" matches what a save writes, so a model that needs the query/passage
    // distinction gets it.
    let vectors: (number[] | undefined)[] = [];
    const reported = new Set<string>();
    try {
      // One request per chunk: a provider that bills per call makes 500 single-text
      // calls the expensive way to do this.
      vectors = await embedder.embedBatch(batch.map((b) => b.text), { inputType: "passage" });
    } catch {
      // A failed batch is nearly always one bad document, not 64. Retry the chunk one
      // text at a time so the rest still migrates, and keep each row's own error —
      // "provider exploded" on row 7 is worth more than "batch failed" on all 64.
      vectors = [];
      for (const b of batch) {
        try {
          vectors.push(await embedder.embed(b.text, { inputType: "passage" }));
        } catch (err) {
          result.failed.push({ id: b.id, error: err instanceof Error ? err.message : String(err) });
          reported.add(b.id);
          vectors.push(undefined);
        }
      }
    }

    for (let j = 0; j < batch.length; j++) {
      const row = batch[j]!;
      const vector = vectors[j];
      if (!vector) {
        if (!reported.has(row.id)) {
          result.failed.push({ id: row.id, error: "provider returned no vector for this text" });
        }
        continue;
      }
      try {
        await store.updateEmbedding(row.id, vector, row.text);
        result.rewritten += 1;
      } catch (err) {
        result.failed.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    opts.onProgress?.(Math.min(i + batchSize, rows.length), rows.length);
  }

  return result;
}
