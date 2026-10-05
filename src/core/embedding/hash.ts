import { type EmbeddingProvider, normalize } from "./provider.js";

/**
 * Deterministic hash-based embedding — local, offline, zero download.
 * Produces 384-dim bge-small-compatible vectors for dev/test.
 * Swap to real ONNX via TRANSFORMERS provider in prod.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name = "hash";
  readonly dim = 384;

  async embed(text: string, _opts?: { inputType?: string }): Promise<number[]> {
    return this.hashEmbed(text);
  }
  async embedBatch(texts: string[], _opts?: { inputType?: string }): Promise<number[][]> {
    return texts.map((t) => this.hashEmbed(t));
  }

  private hashEmbed(text: string): number[] {
    const vec = new Array(this.dim).fill(0);
    const lower = text.toLowerCase();
    const tokens = tokenize(lower);
    // use unique tokens to avoid repeated words (e.g. "lorem" x20) dominating the vector
    const unique = [...new Set(tokens)];
    for (const token of unique) {
      const h = fnv1a(token);
      for (let i = 0; i < this.dim; i++) {
        const byte = (h >> (i % 4) * 8) & 0xff;
        vec[i] += ((byte / 127.5) - 1) * (1 + Math.sin(i * 0.11 + token.length));
      }
    }
    // add length + char signal so empty vs non-empty differs
    for (let i = 0; i < this.dim; i++) {
      vec[i] += Math.sin((text.charCodeAt(i % text.length) ?? 0) * 0.07 + i) * 0.1;
    }
    return normalize(vec);
  }
}

function tokenize(s: string): string[] {
  return s
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .flatMap((w) => {
      // include bi-grams for better similarity
      if (w.length <= 3) return [w];
      const grams: string[] = [w];
      for (let i = 0; i < w.length - 2; i++) grams.push(w.slice(i, i + 3));
      return grams;
    });
}

function fnv1a(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
