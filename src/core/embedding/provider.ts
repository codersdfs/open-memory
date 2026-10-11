export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  /**
   * The model this instance was built with, or null when it has none (hash).
   *
   * The instance is the only honest source for /embedding: re-resolving the
   * environment would report what the *next* start would use, and the difference
   * between those two answers is exactly what needsRestart measures.
   *
   * Optional so that implementing this interface stays a one-method job: null and
   * absent mean the same thing, and every real provider here declares it.
   */
  readonly model?: string | null;
  embed(text: string, opts?: { inputType?: string }): Promise<number[]>;
  embedBatch(texts: string[], opts?: { inputType?: string }): Promise<number[][]>;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`dim mismatch ${a.length} vs ${b.length}`);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function normalize(vec: number[]): number[] {
  const n = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (n === 0) return vec;
  return vec.map((v) => v / n);
}
