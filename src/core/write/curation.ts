/**
 * Curation (ADR-0040): the write-time verdict on whether a candidate deserves to
 * exist at all. Reconcile (ADR-0015) decides what a write does to its neighbours;
 * curation decides whether the write should happen — the question the reconcile
 * guards were never asked, and the one every serious memory system answers.
 *
 * The design is distilled from the field, made deterministic:
 *   - Mem0 answers "Hi" → `{"facts": []}` with a few-shot prompt; the same judgement
 *     is a lexicon here. Its platform prompt's rule — extraction reads the user's
 *     message, never the assistant's scaffolding — is why extractor-sliced writes are
 *     judged harder than explicit ones.
 *   - Letta's archival-insert docstring — "self-contained facts, not conversational
 *     fragments" — is the conversational-repair and colon-header rules.
 *   - Memobase's validation examples ("User did not state their name" is not a fact)
 *     are the same repair class in another accent.
 *   - Zep supersedes instead of deleting; nothing here deletes either — the store's
 *     supersede chain stays the only lifecycle for replaced facts.
 *   - Generative Agents rate poignancy at birth; the demotion ladder is that idea
 *     with a floor instead of a model call.
 *   - None of the field filters secrets or handles negation deterministically. Both
 *     classes showed up in the 515-row audit of the live store, so both are first-
 *     class rules here rather than prompt advice (MCP instructions already say
 *     "never store secrets"; the row was stored anyway).
 *
 * Pure. No store, no embedder, no env, no network — the caller owns the rollback
 * switch (`MEMORY_CURATE=off`), because a verdict module that reads its own config
 * cannot be table-driven in tests. Bilingual by contract, like every lexical rule
 * in this repository: 60% of the audited store is Chinese.
 */

import type { MemoryKind } from "../types.js";

/** What a rejected or demoted candidate was, in one word. Each class names a measured junk shape. */
export type JunkClass =
  | "secret"
  | "table-row"
  | "colon-header"
  | "phatic"
  | "conversational"
  | "code-line"
  | "prompt-fragment"
  | "progress"
  | "self-narration"
  /**
   * The one class no regex assigns: the write gate (ADR-0041) asked the model and was
   * answered below the floor. `curate` never returns it — it exists so a model verdict
   * can travel the same rejection path, and carry the same advice, as a lexical one.
   */
  | "low-value";

export interface CurationVerdict {
  /** `reject` = do not store. `demote` = store, but sink it. `store` = clean. */
  action: "store" | "demote" | "reject";
  /** null when the candidate is clean. */
  junk: JunkClass | null;
  /**
   * The one next move, in the ADR-0037 pattern: an empty-search diagnostic exists so
   * the caller can act, and a rejection exists for the same reason. Never a bare "no".
   */
  advice: string;
  /** Set on demotions, so a row confesses why it sits at the bottom of the ranking. */
  tag?: string;
}

export const ADVICE: Record<JunkClass, string> = {
  secret:
    "never store a credential — record where the key lives (which file, which manager), not the key itself",
  "table-row": "a table row is a slice of a document, not a memory — store the fact the row states, in a sentence",
  "colon-header": "this line is a heading and the content it introduced never arrived — store the content, not the heading",
  phatic: "social filler teaches the store nothing — say the fact directly",
  conversational:
    "a correction without a replacement fact is conversation management, and the store cannot reconcile it — store the fact itself",
  "code-line": "a code line is not a fact — store what the code means or why it matters",
  "prompt-fragment": "this is agent instruction scaffolding, not knowledge about the world",
  progress:
    "what was just done is session narration — it decays on its own; store it as an explicit task only if it must survive the week",
  "self-narration": "statements about this session's own capabilities go stale immediately",
  "low-value":
    "the judge rated this below the store's floor — say the durable fact directly, or name a kind if it must survive",
};

/** Weak classes: junk from an extractor's slice, an honest note from a caller. */
const WEAK: ReadonlySet<JunkClass> = new Set(["progress", "self-narration"]);

export interface CurateOptions {
  /**
   * `extracted` = the candidate was sliced out of a conversation by the extractor or
   * an LLM pass — nobody asked for it to exist, so weak classes reject outright.
   * `explicit` = a caller named this write — weak classes demote instead, because
   * second-guessing intent entirely is how a memory system stops being trusted.
   */
  origin: "explicit" | "extracted";
}

/* ------------------------------------------------------------------ */
/* Lexicons. Each pattern cites the audited row that paid for it.      */
/* ------------------------------------------------------------------ */

// "我没说过我在 pi-desktop。……" sat in the store for weeks with judged:jev on it:
// an LLM judge passed it, because "is this useful" is the wrong question for a
// sentence whose subject is the conversation itself.
const REPAIR_PATTERNS: RegExp[] = [
  /^我没(有)?(说|提|讲|写|让|要求|发)/,
  /^我并没有(说|提|做)/,
  /^我什么时候(说|提|让)/,
  /^(别|不要|不许)(乱|瞎)?(记|存|写)(这|那|我)/,
  /^(i|we) (never|didn'?t|did not|haven'?t) (said|say|mention|mentioned|tell|told|ask|asked|write|wrote|request)/i,
  /^don'?t put words/i,
  /^(you|you'?re) (misunderstood|misread|got (it|me) wrong|got that wrong|are wrong)/i,
  /^that'?s not what (i|we) (said|meant)/i,
];

// "I can only work with local files and the codebase here" — the agent narrating
// its own runtime, true for exactly one session.
const SELF_NARRATION: RegExp[] = [
  /^i (can only|can'?t|cannot|only (work|have|see|run)|am (only )?(running|using)|will only|don'?t have access)/i,
  /^我(只能|这边只能)/,
  /^(我|这边)(现在)?(正在)?(在|用|跑)(用|跑|运行)/,
];

// "我刚做的: 修正了……" — progress reports are events at best, and events decay.
const PROGRESS: RegExp[] = [
  /^我刚(刚)?(做|改|修|写|加|删|跑|试|更新|部署|提交|创建|新建|移)/,
  /^我刚做了/,
  /^(plan|计划|todo|待办清单?|列表)\s*(已|已经|has been|is now)?\s*(更新|updated)/i,
  /^i (just|have just|'ve just) (fixed|made|added|wrote|ran|updated|corrected|changed|created|deleted|removed|deployed|committed)/i,
];

// "export const PITCH = 48;   // row height, px" — a diff line with a line number.
const CODE_LINE: RegExp[] = [
  /\b(?:const|let|var|function|class|def|interface|enum|struct)\s+[A-Za-z_$][\w$]*\s*[=(:]/,
  /\b(?:export|import)\s+(?:default|const|let|var|function|class|type|interface)\b/,
  /^[\w$]+\(.*\)\s*\{$/,
];

// "Task: TOOLBOX: your real tools are read, grep, find, ls, bash, write" and
// "researcher.md  tools: read, write, web_search, …" — the agent's own manifest.
// Two adjacent tool names is prose ("read, write"); three distinct ones with no
// sentence terminator is a manifest.
const TOOL_TOKEN = /\b(read|write|grep|find|ls|bash|edit|fetch|search|list|web_search|fetch_content|source_check|get_search_content|contact_supervisor)\b/gi;

const PROMPT_FRAGMENT: RegExp[] = [
  /^(your|you)\s+(real\s+)?tools?\b/i,
  /^(task|todo|system|note|role)\s*[:：]\s*(toolbox|your|you\b|tools?\b|role\b)/i,
  // "TOOLS_IMPLIED: fabric_exec → pi.bash({cmd})", "SKILLS: design-router, hallmark, …"
  // — scaffold labels out of an agent's own answer, measured in the audited store.
  /^(tools?[_ ]?(?:implied|used)?|skills)\s*[:：]/i,
];

// "1) The exact skill names you can load (comma separated)" — one numbered slice of a
// prompt template, addressed to whoever loads it. The guard is what keeps a real
// numbered procedure alive: "1) 先装依赖，再跑测试。" states its own steps and speaks
// in instructions, not in second-person meta-language.
const NUMBERED_SLICE = /^\d{1,2}[).、]\s/;
const META_LANGUAGE = /\b(?:you|your|comma separated|fill in|as (?:specified|above))\b|（[^）]*逗号分隔[^）]*）|（[^）]*填写[^）]*）/i;

// "sk-…", "ghp_…", "AKIA…", "nvapi-…", "apikey_…" — the settings file itself held
// live keys when this rule was written; the store is one careless `save` away.
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|xox[bpars]|ghp|gho|ghu|ghs|ghr|github_pat|nvapi|sk-ant|apikey)[-_][A-Za-z0-9_-]{12,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/,
  /\b(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|password|passwd|credential)s?\b\s*[:=]\s*["']?\S{8,}/i,
  /(密码|密钥|秘钥|令牌)\s*[:：=]\s*\S{6,}/,
];

// Mem0's few-shot: "Hi." → {"facts": []}. A whole-text lexicon, so a sentence with
// content ("好的，部署用 npm run build") can never match.
const PHATIC = /^(?:ok|okay|kk|k|thanks|thank you|thx|ty|got it|gottit|understood|sure|yes|yeah|yep|yup|nope|nah|cool|nice|great|awesome|perfect|done|lol|lmao|haha|hehe|hmm+|hm|um+|uh+|oops|wow|good|fine|well|hello|hi|hey|yo|好的?|嗯+|哦+|收到|明白了?|了解|知道了|谢谢|多谢|感谢|辛苦了?|不客气|对(?:的)?|是的?|没错|行|可以|好嘞|好滴|哈+|呵+|嘿+|抱歉|不好意思|没事)[!！。.~\s]*$/i;
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\s)+$/u;

function firstMatch(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * The verdict for one candidate. Ordered cheapest-and-hardest first; the first hit
 * wins, so a secret wrapped in a table row reports as a secret.
 */
export function curate(text: string, opts: CurateOptions): CurationVerdict {
  const s = text.trim();
  const verdict = (junk: JunkClass, action: "reject" | "demote"): CurationVerdict => ({
    action,
    junk,
    advice: ADVICE[junk],
    ...(action === "demote" ? { tag: `curation:${junk}` } : {}),
  });

  if (!s) {
    // Empty is empty on every path: nothing to demote into existence.
    return { action: "reject", junk: "phatic", advice: ADVICE.phatic };
  }

  if (SECRET_PATTERNS.some((p) => p.test(s))) return verdict("secret", "reject");
  if (s.includes("|")) return verdict("table-row", "reject");
  if (/[：:]\s*$/.test(s)) return verdict("colon-header", "reject");
  if (PHATIC.test(s) || EMOJI_ONLY.test(s)) return verdict("phatic", "reject");
  if (firstMatch(REPAIR_PATTERNS, s)) return verdict("conversational", "reject");
  if (firstMatch(CODE_LINE, s) || (/;\s*$/.test(s) && /[=(){}<>]|=>/.test(s))) return verdict("code-line", "reject");
  if (
    firstMatch(PROMPT_FRAGMENT, s) ||
    (NUMBERED_SLICE.test(s) && META_LANGUAGE.test(s)) ||
    (() => {
      // ≥3 distinct tool tokens with no sentence terminator: a manifest, not prose.
      if (/[。！？.!?]\s*$/.test(s)) return false;
      const tools = new Set((s.match(TOOL_TOKEN) ?? []).map((t) => t.toLowerCase()));
      return tools.size >= 3;
    })()
  ) {
    return verdict("prompt-fragment", "reject");
  }

  if (firstMatch(PROGRESS, s)) {
    return opts.origin === "extracted" ? verdict("progress", "reject") : verdict("progress", "demote");
  }
  if (firstMatch(SELF_NARRATION, s)) {
    return opts.origin === "extracted" ? verdict("self-narration", "reject") : verdict("self-narration", "demote");
  }

  return { action: "store", junk: null, advice: "" };
}

/** The extractor's verdict: nobody asked for this row, so weak classes reject too. */
export function curateExtracted(text: string): CurationVerdict {
  return curate(text, { origin: "extracted" });
}

/**
 * Where a demotion lands. `note` is the kind that decays first of the non-task
 * kinds (30 days), and 0.35 sits below every kind's default importance — a demoted
 * row can only outrank real knowledge by being read, which is the one thing that
 * should promote it (a retrieval refreshes `lastUsedAt`; decay spares what is used).
 */
export const DEMOTE_KIND: MemoryKind = "note";
export const DEMOTE_IMPORTANCE = 0.35;

/**
 * The typed refusal. Callers that must not lose a write to a regex (a bulk import,
 * a rollback) catch this; every interactive surface renders `verdict.advice` instead,
 * because "why was my memory not stored" deserves the same one-next-move answer an
 * empty search already gets.
 */
export class CurationRejected extends Error {
  readonly verdict: CurationVerdict;
  constructor(verdict: CurationVerdict) {
    super(`not stored (${verdict.junk}): ${verdict.advice}`);
    this.name = "CurationRejected";
    this.verdict = verdict;
  }
}

/** The one-line render shared by the CLI and the MCP text result. */
export function renderVerdict(verdict: CurationVerdict): string {
  return `not stored (${verdict.junk}): ${verdict.advice}`;
}
