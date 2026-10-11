import type { EmbeddingProvider } from "./provider.js";

export type ApiEmbeddingConfig = {
  /** Reported in `/health` and in the dim-mismatch error. */
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  dim: number;
  /**
   * Send `input_type: query | passage`. NVIDIA's E5 and Nemotron models require it
   * and score noticeably worse without it; OpenAI rejects an unknown field, so it is
   * opt-in.
   */
  inputType: boolean;
  /** Provider-specific body fields (NIM's `truncate`, a fixed `input_type`). Applied last. */
  extraBody?: Record<string, unknown>;
  timeoutMs?: number;
};

/**
 * One OpenAI-compatible `/embeddings` client.
 *
 * OpenAI and NVIDIA NIM differ only in base URL, model name, dimension, and whether
 * the body carries `input_type` — so they are one implementation with two configs,
 * not two providers. ADR-0004 promised both; this is the smallest thing that keeps
 * that promise honestly.
 */
export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  readonly model: string;
  private readonly cfg: ApiEmbeddingConfig;

  constructor(cfg: ApiEmbeddingConfig) {
    this.cfg = cfg;
    this.name = cfg.name;
    this.dim = cfg.dim;
    this.model = cfg.model;
  }

  async embed(text: string, opts?: { inputType?: string }): Promise<number[]> {
    const [vec] = await this.embedBatch([text], opts);
    return vec;
  }

  async embedBatch(texts: string[], opts?: { inputType?: string }): Promise<number[][]> {
    if (texts.length === 0) return [];
    const body: Record<string, unknown> = { model: this.cfg.model, input: texts };
    if (this.cfg.inputType && opts?.inputType) body.input_type = opts.inputType;
    // Last, so a fixed `NIM_INPUT_TYPE` or `NIM_TRUNCATE` beats the per-call default.
    Object.assign(body, this.cfg.extraBody ?? {});

    const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 20_000),
    });
    if (!res.ok) {
      // The body carries the real reason (bad key, model not found, quota). Truncate:
      // it is surfaced to a human on a terminal, not parsed.
      throw new Error(`${this.name} embeddings failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as { data?: { embedding?: number[]; index?: number }[] };
    const rows = json.data ?? [];
    if (rows.length !== texts.length) {
      throw new Error(`${this.name} returned ${rows.length} embeddings for ${texts.length} inputs`);
    }
    const out = rows.map((r) => r.embedding ?? []);
    // A declared dim that disagrees with reality corrupts the store silently, and
    // the guard in MemoryService.init() would have nothing to compare against.
    const wrong = out.find((v) => v.length !== this.dim);
    if (wrong) {
      throw new Error(
        `${this.name} returned a ${wrong.length}-dim vector but EMBEDDING_DIM is ${this.dim}. ` +
        `Set EMBEDDING_DIM=${wrong.length} to match ${this.cfg.model}.`,
      );
    }
    return out;
  }
}
