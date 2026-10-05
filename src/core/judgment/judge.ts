import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * The write-side gate, asked of a model instead of a regex.
 *
 * Extractor.isWorthKeeping is three cheap rules and they miss the genuinely hard
 * case: "Run the tests before commit" is throwaway task scaffolding in one
 * sentence and a durable routine in another. Jev returns a probability, so a
 * borderline memory is stored weak instead of being either certainly kept or
 * certainly dropped.
 *
 * Zero dependencies: the wire protocol is a POST and a noul answer.
 *
 * ponytail: fail-open. A store that silently stops recording because a judge
 * API is down is worse than one that occasionally keeps a mediocre fact.
 */

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 1;

/** Below this, the memory is not stored. */
export const JEV_MIN_KEEP = (): number => Number(process.env.MEMORY_JEV_MIN ?? 0.5);

export interface Verdict {
  /** Probability this is still useful to an assistant weeks from now. */
  keep: number;
  model?: string;
}

export function jevEnabled(): boolean {
  return process.env.MEMORY_JEV !== "false";
}

/**
 * The key lives in a file, not in .env, so .env can stay shareable and the
 * secret stays out of anything someone pastes into a chat.
 */
export function jevApiKey(): string | undefined {
  const file = process.env.JEV_API_KEY_FILE?.trim();
  if (file) {
    const p = file === "~" ? homedir()
      : file.startsWith("~/") || file.startsWith("~\\") ? join(homedir(), file.slice(2))
      : isAbsolute(file) ? file
      : join(process.cwd(), file);
    if (existsSync(p)) return readFileSync(p, "utf8").trim() || undefined;
    // A configured-but-unreadable key is a typo worth naming, not a silent
    // fall-through to unjudged writes.
    console.warn("[jev] JEV_API_KEY_FILE not readable: " + p);
    return undefined;
  }
  return process.env.TYPESAFE_API_KEY?.trim() || undefined;
}

export interface JudgeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
}

/** One noul against the sentence. null = no verdict (disabled, no key, or failed). */
export async function jevKeep(
  text: string,
  opts: JudgeOptions = {},
): Promise<Verdict | null> {
  if (!jevEnabled()) return null;
  const apiKey = jevApiKey();
  if (!apiKey) return null;

  const endpoint = process.env.JEV_ENDPOINT ?? DEFAULT_ENDPOINT;
  const model = process.env.JEV_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const doFetch = opts.fetchImpl ?? fetch;
  const body = JSON.stringify({
    state: text,
    model,
    questions: {
      keep: {
        type: "noul",
        instructions:
          "Will this still be useful to an assistant in a different session weeks from now, " +
          "with no memory of this conversation?",
        criteria: {
          true:
            "A durable fact, user preference, environment fact, or an agreed convention or routine.",
          false:
            "Transient task state, a question, an instruction for the agent right now, " +
            "or something already recorded in the repo.",
        },
      },
    },
  });

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body,
        signal: ctl.signal,
      });
      if (!res.ok) {
        const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
        // A bad key or a bad request will fail identically every time. Throwing
        // here would land in the retrying catch below and burn the whole retry
        // budget against a 401 that can never succeed.
        if (!retryable) {
          console.warn("[jev] rejected, storing unjudged: HTTP " + res.status);
          return null;
        }
        if (attempt < retries) continue;
        throw new Error("jev HTTP " + res.status);
      }
      const json = (await res.json()) as {
        model?: string;
        answers?: Record<string, { type?: string; noul?: number }>;
      };
      const a = json.answers?.keep;
      if (a?.type !== "noul" || typeof a.noul !== "number") throw new Error("jev answer missing");
      return { keep: Math.max(0, Math.min(1, a.noul)), model: json.model };
    } catch (e) {
      if (attempt < retries) continue;
      // fail-open: the caller stores unjudged rather than dropping the memory.
      console.warn("[jev] unavailable, storing unjudged:", (e as Error).message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Importance that follows the judgment: a memory jev is unsure about is stored
 * weak, so decay keeps the confident ones and the shaky ones sink.
 */
export function importanceFor(keep: number): number {
  return Number((0.4 + 0.5 * keep).toFixed(2));
}
