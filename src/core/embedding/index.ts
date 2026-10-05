import type { EmbeddingProvider } from "./provider.js";
import { HashEmbeddingProvider } from "./hash.js";

// ponytail: single local provider (384d, offline). No API key, no network,
// no dimension-mismatch bug waiting to happen. Add a real embedder only if
// lexical+hash recall measurably misses; give it a name + dim in health output.
export function createEmbeddingProvider(): EmbeddingProvider {
  return new HashEmbeddingProvider();
}
export { HashEmbeddingProvider } from "./hash.js";
export type { EmbeddingProvider } from "./provider.js";
