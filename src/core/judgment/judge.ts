import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { runtimeEnv } from "../settings.js";
import type { Relation } from "../write/reconciler.js";

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
export const JEV_MIN_KEEP = (): number => Number(runtimeEnv().MEMORY_JEV_MIN ?? 0.5);

export interface Verdict {
  /** Probability this is still useful to an assistant weeks from now. */
  keep: number;
  model?: string;
}

// The knobs come from the merged seam (real environment > settings.json > default),
// read per call and never at module load: a value written by the console has to apply
// to the next memory without a restart.

function isJevEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.MEMORY_JEV !== "false";
}

export function jevEnabled(): boolean {
  return isJevEnabled(runtimeEnv());
}

/**
 * Precedence: the key itself, then a file holding it, then the TypeSafe env var.
 *
 * Direct first because this deployment keeps it in .env; the file form stays for
 * a checkout whose .env is shareable, where the secret stays out of anything
 * someone pastes into a chat.
 */
export function jevApiKey(): string | undefined {
  return apiKeyFrom(runtimeEnv());
}

function apiKeyFrom(env: NodeJS.ProcessEnv): string | undefined {
  const direct = env.JEV_API_KEY?.trim();
  if (direct) return direct;
  const file = env.JEV_API_KEY_FILE?.trim();
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
  return env.TYPESAFE_API_KEY?.trim() || undefined;
}

export interface JudgeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
}

/** One noul question, in the shape the endpoint documents. */
interface NoulQuestion {
  instructions: string;
  criteria?: { true: string; false: string };
}

const KEEP_QUESTION: NoulQuestion = {
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
};

/**
 * The wire body for one systemOne call. One request, N questions — the console's key check
 * and the write-side judge ask the endpoint the same way, so the protocol is written once
 * and a caller that needs three probabilities pays one round trip instead of three.
 */
function systemOneBody(state: string, questions: Record<string, NoulQuestion>, model: string): string {
  return JSON.stringify({
    state,
    model,
    questions: Object.fromEntries(
      Object.entries(questions).map(([name, q]) => [name, { type: "noul", ...q }]),
    ),
  });
}

/**
 * One POST with timer, retries and fail-open. Returns the requested probabilities, or
 * null when there is no usable answer: disabled, no key, a rejected request, or a
 * malformed body after the retry budget is spent.
 */
async function systemOneCall(
  state: string,
  questions: Record<string, NoulQuestion>,
  required: string[],
  opts: JudgeOptions,
): Promise<{ answers: Record<string, number>; model?: string } | null> {
  const env = runtimeEnv();
  if (!isJevEnabled(env)) return null;
  const apiKey = apiKeyFrom(env);
  if (!apiKey) return null;

  const endpoint = env.JEV_ENDPOINT ?? DEFAULT_ENDPOINT;
  const model = env.JEV_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const doFetch = opts.fetchImpl ?? fetch;
  const body = systemOneBody(state, questions, model);

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
      const answers: Record<string, number> = {};
      for (const name of Object.keys(questions)) {
        const a = json.answers?.[name];
        answers[name] = a?.type === "noul" && typeof a.noul === "number"
          ? Math.max(0, Math.min(1, a.noul))
          : Number.NaN;
      }
      if (required.some((k) => Number.isNaN(answers[k]))) throw new Error("jev answer missing");
      return { answers, model: json.model };
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

/** One noul against the sentence. null = no verdict (disabled, no key, or failed). */
export async function jevKeep(
  text: string,
  opts: JudgeOptions = {},
): Promise<Verdict | null> {
  const r = await systemOneCall(text, { keep: KEEP_QUESTION }, ["keep"], opts);
  if (!r) return null;
  return { keep: r.answers.keep, model: r.model };
}

export interface RelationResult {
  /** null = no label cleared the margin; the caller stores the memory unjudged. */
  relation: Relation | null;
  scores: Record<Relation, number>;
  model?: string;
}

/**
 * The three labels the write path can act on. Each is a noul in ONE request: three calls
 * to answer one question about one pair would cost more than the memory is worth.
 */
const RELATION_QUESTIONS: Record<Relation, NoulQuestion> = {
  duplicate: {
    instructions: "Do OLD and NEW state the same fact, such that keeping both would be redundant?",
    criteria: {
      true: "Same claim, reworded or restated. Either one answers the same question.",
      false: "Different claims, even if they share vocabulary or topic.",
    },
  },
  refines: {
    instructions: "Does NEW add detail to OLD while still agreeing with it?",
    criteria: {
      true: "NEW says everything OLD said, plus something more specific.",
      false: "NEW leaves something OLD stated still unanswered, or disagrees with it.",
    },
  },
  contradicts: {
    instructions: "Do OLD and NEW disagree, such that OLD is no longer true?",
    criteria: {
      true: "A change of value, version, location, preference or decision between them.",
      false: "Both can be true at once, or they are about different things.",
    },
  },
};

/** Below this margin two labels are too close to act on. */
export const DEFAULT_RELATION_MARGIN = 0.15;

/**
 * What a new sentence does to an old one.
 *
 * Returns null when there is no answer at all; a null `relation` when the model answered
 * but no label won clearly. The caller must treat both the same way: store the write.
 * Deleting a memory on a 0.5/0.45 split is the one failure this feature cannot afford.
 */
export async function jevRelation(
  oldText: string,
  newText: string,
  opts: JudgeOptions & { margin?: number } = {},
): Promise<RelationResult | null> {
  const r = await systemOneCall(
    `OLD: ${oldText}\nNEW: ${newText}`,
    RELATION_QUESTIONS,
    ["duplicate", "refines", "contradicts"],
    opts,
  );
  if (!r) return null;
  const scores: Record<Relation, number> = {
    duplicate: r.answers.duplicate,
    refines: r.answers.refines,
    contradicts: r.answers.contradicts,
  };
  const ranked = (Object.keys(scores) as Relation[])
    .map((k) => [k, scores[k]] as const)
    .sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  const margin = opts.margin ?? DEFAULT_RELATION_MARGIN;
  const decided = top[1] >= 0.5 && top[1] - second[1] >= margin;
  return { relation: decided ? top[0] : null, scores, model: r.model };
}

/**
 * Importance that follows the judgment: a memory jev is unsure about is stored
 * weak, so decay keeps the confident ones and the shaky ones sink.
 */
export function importanceFor(keep: number): number {
  return Number((0.4 + 0.5 * keep).toFixed(2));
}

export interface ValidateJevKeyOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  endpoint?: string;
  model?: string;
}

/**
 * One real systemOne call with a candidate key, before the console writes it.
 *
 * The judge fails open on purpose, so a wrong key is the quietest failure in the project:
 * every memory is stored unjudged and nothing says why. This is the one moment the user
 * can be told, so it is a real call, not a shape check. It answers instead of throwing,
 * because a 401 and an unreachable host are the same instruction to the caller — do not
 * save this — and the message is built from the status alone: it can reach an HTTP
 * response body, and the key never may.
 */
export async function validateJevKey(
  key: string,
  opts: ValidateJevKeyOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  const env = runtimeEnv();
  const endpoint = opts.endpoint ?? env.JEV_ENDPOINT ?? DEFAULT_ENDPOINT;
  const model = opts.model ?? env.JEV_MODEL ?? DEFAULT_MODEL;
  const doFetch = opts.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: systemOneBody("a candidate key, checked before the console saves it", { keep: KEEP_QUESTION }, model),
      signal: ctl.signal,
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `the JEV endpoint rejected the key (HTTP ${res.status})` };
    }
    return { ok: false, error: `the JEV endpoint answered HTTP ${res.status}` };
  } catch (e) {
    // No retry: a save the user is waiting on reports the network failure it saw.
    return { ok: false, error: `the JEV endpoint could not be reached — ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}
