import type { EmbeddingProvider } from "./provider.js";
import { HashEmbeddingProvider } from "./hash.js";
import { ApiEmbeddingProvider } from "./openai.js";

/**
 * Defaults as documented in `.env.example`. `NIM_DIM` / `EMBEDDING_DIM` override
 * the dimension for any other model.
 */
const OPENAI_DEFAULTS = { baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", dim: 1536 };
const NIM_DEFAULTS = { baseUrl: "https://integrate.api.nvidia.com/v1", model: "nvidia/nemotron-3-embed-1b", dim: 2048 };

/**
 * Pick the embedder from the environment.
 *
 * `hash` stays the default, so an unset environment keeps the offline, zero-cost
 * behaviour byte-for-byte — the pitch is that this works with no key.
 *
 * An unknown or under-configured provider throws instead of falling back to hash.
 * Until this was wired up, `.env.example` documented `EMBEDDING_PROVIDER=openai` and
 * that file was the only place it existed: the variable was read by nobody, every
 * install silently ran hash, and "hybrid retrieval" was one-legged while the README
 * said otherwise. A silent fallback would put that bug straight back.
 */
export function createEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const which = (env.EMBEDDING_PROVIDER ?? "hash").trim().toLowerCase();
  if (which === "" || which === "hash" || which === "local") return new HashEmbeddingProvider();

  const nim = which === "nim" || which === "nvidia" || which === "nvidia-nim";
  if (which !== "openai" && !nim) {
    throw new Error(`unknown EMBEDDING_PROVIDER "${which}" — expected hash, openai, or nim`);
  }

  const apiKey = nim ? env.NVIDIA_API_KEY ?? env.NIM_API_KEY : env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(`EMBEDDING_PROVIDER=${which} needs ${nim ? "NVIDIA_API_KEY (or NIM_API_KEY)" : "OPENAI_API_KEY"}`);
  }

  const dim = Number((nim ? env.NIM_DIM : undefined) ?? env.EMBEDDING_DIM ?? (nim ? NIM_DEFAULTS.dim : OPENAI_DEFAULTS.dim));
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`embedding dim must be a positive integer, got "${env.NIM_DIM ?? env.EMBEDDING_DIM}"`);
  }

  // NIM takes two body fields OpenAI rejects, so they are sent only for NIM.
  const extraBody: Record<string, unknown> = {};
  if (nim) {
    extraBody.truncate = env.NIM_TRUNCATE ?? "NONE";
    if (env.NIM_INPUT_TYPE) extraBody.input_type = env.NIM_INPUT_TYPE;
  }

  return new ApiEmbeddingProvider({
    name: nim ? "nim" : "openai",
    baseUrl: (nim ? env.NIM_BASE_URL : env.OPENAI_BASE_URL) ?? (nim ? NIM_DEFAULTS.baseUrl : OPENAI_DEFAULTS.baseUrl),
    apiKey,
    model: (nim ? env.NIM_EMBED_MODEL : env.OPENAI_EMBED_MODEL) ?? (nim ? NIM_DEFAULTS.model : OPENAI_DEFAULTS.model),
    dim,
    inputType: nim && !env.NIM_INPUT_TYPE,
    extraBody,
  });
}

export { HashEmbeddingProvider } from "./hash.js";
export { ApiEmbeddingProvider } from "./openai.js";
export type { EmbeddingProvider } from "./provider.js";
