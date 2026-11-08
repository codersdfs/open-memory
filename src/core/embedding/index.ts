import type { EmbeddingProvider } from "./provider.js";
import { HashEmbeddingProvider } from "./hash.js";
import { ApiEmbeddingProvider } from "./openai.js";

/**
 * Defaults as documented in `.env.example`. `NIM_DIM` / `EMBEDDING_DIM` override
 * the dimension for any other model.
 */
const OPENAI_DEFAULTS = { baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", dim: 1536 };
const NIM_DEFAULTS = { baseUrl: "https://integrate.api.nvidia.com/v1", model: "nvidia/nemotron-3-embed-1b", dim: 2048 };

/** Taken from the provider itself so the preset table cannot drift from what runs. */
const HASH_DIM = new HashEmbeddingProvider().dim;

interface ResolvedEmbedder {
  provider: "hash" | "openai" | "openai-local" | "nim";
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  dim: number;
  inputType: boolean;
  extraBody: Record<string, unknown>;
}

/**
 * One resolution over the environment, shared by the factory, the preset table and
 * `previewEmbedding`. `EmbeddingProvider` carries no model, so the model a provider
 * would use can only be answered here — and it must be the same answer the factory
 * gives, or the console would report a switch that does not happen.
 *
 * Unknown or under-configured providers throw; see the warning above the factory.
 */
function resolveEmbedding(env: NodeJS.ProcessEnv): ResolvedEmbedder {
  const which = (env.EMBEDDING_PROVIDER ?? "hash").trim().toLowerCase();
  if (which === "" || which === "hash" || which === "local") {
    return { provider: "hash", name: "hash", baseUrl: "", apiKey: "", model: "", dim: HASH_DIM, inputType: false, extraBody: {} };
  }

  // P8 small half (ADR-0048): the local OpenAI-compatible preset. Same wire format
  // as `openai` (one `/embeddings` client, openai.ts), but the key is OPTIONAL —
  // Ollama/LM Studio authenticate by being on localhost — and there are no defaults
  // to lean on: a local endpoint's width, model id and address are facts about the
  // user's install, and guessing any of them (1536d for a 768d model, api.openai.com
  // for localhost) is exactly the switch-that-lies this factory exists to refuse.
  // Under-configuration throws here so the console's preview names every missing
  // variable before a settings write, instead of the first embed 401ing.
  if (which === "openai-local") {
    const missing: string[] = [];
    const baseUrl = (env.OPENAI_BASE_URL ?? "").trim();
    const model = (env.OPENAI_EMBED_MODEL ?? "").trim();
    const rawDim = (env.EMBEDDING_DIM ?? "").trim();
    if (!baseUrl) missing.push("OPENAI_BASE_URL");
    if (!model) missing.push("OPENAI_EMBED_MODEL");
    if (!rawDim) missing.push("EMBEDDING_DIM");
    if (missing.length > 0) {
      throw new Error(
        `EMBEDDING_PROVIDER=openai-local needs ${missing.join(", ")} — a local endpoint has no defaults ` +
        `(e.g. OPENAI_BASE_URL=http://localhost:11434/v1 for Ollama). OPENAI_API_KEY is optional here: ` +
        `empty sends no Authorization header.`
      );
    }
    const dim = Number(rawDim);
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(`embedding dim must be a positive integer, got "${rawDim}"`);
    }
    return {
      provider: "openai-local",
      name: "openai-local",
      baseUrl,
      apiKey: env.OPENAI_API_KEY ?? "",
      model,
      dim,
      inputType: false,
      extraBody: {},
    };
  }

  const nim = which === "nim" || which === "nvidia" || which === "nvidia-nim";
  if (which !== "openai" && !nim) {
    throw new Error(`unknown EMBEDDING_PROVIDER "${which}" — expected hash, openai, openai-local, or nim`);
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

  return {
    provider: nim ? "nim" : "openai",
    name: nim ? "nim" : "openai",
    baseUrl: (nim ? env.NIM_BASE_URL : env.OPENAI_BASE_URL) ?? (nim ? NIM_DEFAULTS.baseUrl : OPENAI_DEFAULTS.baseUrl),
    apiKey,
    model: (nim ? env.NIM_EMBED_MODEL : env.OPENAI_EMBED_MODEL) ?? (nim ? NIM_DEFAULTS.model : OPENAI_DEFAULTS.model),
    dim,
    inputType: nim && !env.NIM_INPUT_TYPE,
    extraBody,
  };
}

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
  const r = resolveEmbedding(env);
  if (r.provider === "hash") return new HashEmbeddingProvider();
  return new ApiEmbeddingProvider({
    name: r.name,
    baseUrl: r.baseUrl,
    apiKey: r.apiKey,
    model: r.model,
    dim: r.dim,
    inputType: r.inputType,
    extraBody: r.extraBody,
  });
}

/** What a provider costs to pick: the variable it needs, the model and width it lands on. */
export interface EmbeddingPreset {
  provider: "hash" | "openai" | "openai-local" | "nim";
  /**
   * The credential the provider reads, by name, or `null` when it needs none. `null`
   * now means two things after ADR-0048: no credential exists (hash) and a credential
   * is optional (openai-local) — the console treats both as "never disabled for a
   * missing key", which is the whole difference between the two openai rows.
   */
  keyEnv: string | null;
  model: string | null;
  /**
   * `0` is the sentinel for "no width of its own": `openai-local` serves whatever
   * model the endpoint names, so `EMBEDDING_DIM` is a required user setting, not a
   * preset value (the console omits the field from the write and says so).
   */
  dim: number;
}

/**
 * The choices the console offers, read from the factory's own defaults rather
 * than retyped — a preset that disagrees with the factory is a switch that lies.
 */
export const EMBEDDING_PRESETS: EmbeddingPreset[] = [
  { provider: "hash", keyEnv: null, model: null, dim: HASH_DIM },
  { provider: "openai", keyEnv: "OPENAI_API_KEY", model: OPENAI_DEFAULTS.model, dim: OPENAI_DEFAULTS.dim },
  {
    provider: "openai-local",
    keyEnv: null,
    // No model of its own either: the endpoint names it, via OPENAI_EMBED_MODEL.
    model: null,
    dim: 0,
  },
  { provider: "nim", keyEnv: "NVIDIA_API_KEY", model: NIM_DEFAULTS.model, dim: NIM_DEFAULTS.dim },
];

/**
 * What `createEmbeddingProvider(env)` would build, or why it would refuse — the same
 * resolution, never throwing, so a form can validate a candidate configuration with
 * the production code instead of a copy of its rules.
 */
export function previewEmbedding(
  env: NodeJS.ProcessEnv
): { ok: true; provider: string; model: string | null; dim: number } | { ok: false; error: string } {
  try {
    const r = resolveEmbedding(env);
    return { ok: true, provider: r.provider, model: r.provider === "hash" ? null : r.model, dim: r.dim };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export { HashEmbeddingProvider } from "./hash.js";
export { ApiEmbeddingProvider } from "./openai.js";
export type { EmbeddingProvider } from "./provider.js";
