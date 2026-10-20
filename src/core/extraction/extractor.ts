import type { MemoryType } from "../types.js";
import { jevKeep, importanceFor, JEV_MIN_KEEP } from "../judgment/judge.js";
import { runtimeEnv } from "../settings.js";

export interface ExtractedMemory {
  text: string;
  type: MemoryType;
  importance: number;
  tags?: string[];
}

// Hybrid extractor: opt-in LLM + heuristic fallback.
// When LLM not configured, uses heuristic rules.

/**
 * A conclusion states its own how, the same way "How to deploy: ..." does: the fix,
 * the root cause, the workaround. The store held 79 memories and almost no methods,
 * because the hook triaged only the user's half of the turn and this shape matched no
 * rule when a reply did arrive.
 */
const CONCLUSION = /(root cause|the fix (is|was)|fixed (it )?by|turns out|the reason (is|was)|workaround|didn'?t work because|doesn'?t work because|根因|原因[是就]|修好|解决办法|试过|试了)/i;

/**
 * Structural gate, added after auditing a real 335-row store: 53.7% of the rows were
 * chat scaffolding, and the wording rules in `isWorthKeeping` let 175 of those 180
 * through — "| 层 | 位置 | 状态 |" has a space and a colon, so `STATES_HOW` read it as
 * knowledge. Structure is the half of a sentence that cannot fake being a fact.
 */
const CJK = /[\u4e00-\u9fff]/;
const SENTENCE_END = /[。！？.!?]\s*$/;

/**
 * One idea, used by both rules below: a sentence that states its own how (a colon, a
 * command, "with/using/via") is knowledge. One that does not is scaffolding. This is
 * what separates "How to deploy: npm run x" from "how to look at it", and "Start the
 * daemon with \`ai-memory daemon start\`" from "start it please".
 */
const STATES_HOW = /[:\`]|\b(with|using|via)\b/i;
const HOW_TO = /^(how|what|where|when|who) to\b/i;

/**
 * The exceptions matter more than the <40-char rule below: these three shapes state
 * knowledge even without a terminator. A standing order, a when-clause and a procedure
 * that carries its steps are exactly what the store is for, so the length rule must not
 * eat them.
 */
const STANDING_ORDER = /^(do not|don't|does not|is not|are not|why not)\b/i;

/**
 * A first-person fact ("I live in Berlin", "my name is Frank"). Chat turns routinely
 * drop the terminator on exactly the rows the store exists for, so the <40-char
 * no-terminator rule has to step aside for them. Deliberately narrow: a first-person
 * opening plus a marker verb, and not the hedged form ("I am not sure") that is a
 * reaction rather than a fact. This is also the type rule's phrase set, so the two
 * cannot disagree about what a self-fact is.
 */
const SELF_FACT = /^(i (live|am|like|prefer|work|use|need|hate)|my name)\b(?!\s+not\b)/i;
const WHEN_CLAUSE = /^when(ever)?\s+[^,]{3,},\s*\S/i;

/**
 * Relative time never lands as a date: "昨天 we shipped v2" still says 昨天 a week later,
 * so nothing can answer "what did we do on the 18th". Each marker maps to a deterministic
 * offset from the turn's reference date — the caller knows that date, the hook may replay
 * a turn later, so the default of `Date.now()` is the fallback, not the contract. Month
 * and year offsets clamp to the last valid day (31 Jan − 1 month = 28 Feb) rather than
 * rolling into the next month.
 */
const RELATIVE_SHIFTS: { at: RegExp; amount: number; unit: "day" | "week" | "month" | "year" }[] = [
  { at: /前天/, amount: -2, unit: "day" },
  { at: /昨天|yesterday/i, amount: -1, unit: "day" },
  { at: /今天|today/i, amount: 0, unit: "day" },
  { at: /明天|tomorrow/i, amount: 1, unit: "day" },
  { at: /后天/, amount: 2, unit: "day" },
  { at: /上个?星期|上周|last\s+week/i, amount: -1, unit: "week" },
  { at: /本周|这周|this\s+week/i, amount: 0, unit: "week" },
  { at: /下个?星期|下周|next\s+week/i, amount: 1, unit: "week" },
  { at: /上个?月|last\s+month/i, amount: -1, unit: "month" },
  { at: /本月|这个月|this\s+month/i, amount: 0, unit: "month" },
  { at: /下个?月|next\s+month/i, amount: 1, unit: "month" },
  { at: /去年|last\s+year/i, amount: -1, unit: "year" },
  { at: /今年|this\s+year/i, amount: 0, unit: "year" },
  { at: /明年|next\s+year/i, amount: 1, unit: "year" }
];

const ABSOLUTE_DATE = /\b(?:19|20)\d{2}[-/年]\d{1,2}[-/月]\d{1,2}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i;
/** A dated line is a fact even when short and unpunctuated, so the fragment rule spares it. */
const DATE_HINT = new RegExp(`${RELATIVE_SHIFTS.map((r) => r.at.source).join("|")}|${ABSOLUTE_DATE.source}`, "i");

function formatLocalDate(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function shiftMonths(ref: Date, months: number): Date {
  const day = ref.getDate();
  const target = new Date(ref.getFullYear(), ref.getMonth() + months, 1);
  // Day 31 of a 30-day month would otherwise roll into the next one.
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
}

/**
 * The absolute date a relative expression points at, as YYYY-MM-DD in the turn's local
 * calendar. Returns null when the sentence names no relative time.
 */
export function resolveRelativeDate(sentence: string, referenceDate: number = Date.now()): string | null {
  const ref = new Date(referenceDate);
  if (Number.isNaN(ref.getTime())) return null;
  for (const rule of RELATIVE_SHIFTS) {
    if (!rule.at.test(sentence)) continue;
    if (rule.unit === "day" || rule.unit === "week") {
      const d = new Date(ref);
      d.setDate(d.getDate() + rule.amount * (rule.unit === "week" ? 7 : 1));
      return formatLocalDate(d);
    }
    return formatLocalDate(shiftMonths(ref, rule.amount * (rule.unit === "month" ? 1 : 12)));
  }
  return null;
}

/**
 * The absolute date goes into the text, not only into a tag: lexical search reads text,
 * so a tag nobody indexes would make the resolved date unfindable while the row looks
 * dated. The tag is kept anyway as an exact filter for later, and costs nothing.
 */
export function stampRelativeDate(text: string, referenceDate: number): { text: string; tags: string[] } {
  const at = resolveRelativeDate(text, referenceDate);
  if (!at) return { text, tags: [] };
  return { text: `${text} (at:${at})`, tags: [`at:${at}`] };
}

/**
 * Shapes that are chat scaffolding, not memories: markdown tables and headings, list
 * slices, prompt-wrapper XML, fenced code, bench fixtures, and lines too short to be a
 * fact. Exported because a shape rule is cheap to get subtly wrong, and the test suite
 * has to be able to call it directly.
 */
export function isNonMemoryShape(sentence: string): boolean {
  const s = sentence.trim();
  if (!s) return true;
  // A table row or continuation ("| 层 | 位置 | 状态 |"): the pipes are the table's
  // structure and a cell is not a fact. Box-drawing remnants fall through to the
  // no-word check below.
  if (s.includes("|")) return true;
  if (/^\s*#{1,6}\s/.test(s)) return true;
  // A bullet marker belongs to the list; the item is one slice of it.
  if (/^\s*[-*+•]\s/.test(s)) return true;
  // Prompt wrappers and tool payloads: "<skill name=...>".
  if (/<\/?[a-z][\w-]*(\s[^>]*)?>/i.test(s)) return true;
  if (/```/.test(s)) return true;
  // Bench and session fixtures: "Session 3: refactored the retrieval pipeline".
  if (/^session \d+:/i.test(s)) return true;
  // No word in any script: a bare id, a hex token, a box-drawing remnant.
  if (!CJK.test(s) && !/[A-Za-z]{3,}/.test(s)) return true;
  // <40 chars without a sentence terminator is a slice of a chat line, unless it is
  // one of the shapes above that states knowledge on its own.
  if (
    s.length < 40 &&
    !SENTENCE_END.test(s) &&
    !SELF_FACT.test(s) &&
    !STANDING_ORDER.test(s) &&
    !WHEN_CLAUSE.test(s) &&
    !(HOW_TO.test(s) && STATES_HOW.test(s)) &&
    !DATE_HINT.test(s)
  ) {
    return true;
  }
  return false;
}

export interface ExtractorConfig {
  maxPerTurn?: number;
  dedupThreshold?: number;
}

export class Extractor {
  private maxPerTurn: number;
  constructor(private config: ExtractorConfig = {}) {
    this.maxPerTurn = config.maxPerTurn ?? 3;
  }

  /**
   * Heuristic extraction — no LLM. Splits turn into candidate facts.
   * LLM path would be: call OpenAI with JSON schema, then same dedup.
   *
   * `referenceDate` is what relative time resolves against. The caller knows when the
   * turn happened; `memoryService.extractAndSave` cannot pass it yet, so "now" is the
   * default and an explicit date is the contract for every future caller.
   */
  async extract(turnText: string, referenceDate: number = Date.now()): Promise<ExtractedMemory[]> {
    // Read the merged seam once per turn: the console writes ENABLE_EXTRACTOR and
    // OPENAI_API_KEY to settings.json, and a value written there must apply without
    // a restart.
    const env = runtimeEnv();
    const apiKey = env.OPENAI_API_KEY;
    const enabled = env.ENABLE_EXTRACTOR === "true";
    if (enabled && apiKey) {
      try {
        return await this.llmExtract(turnText, env, referenceDate);
      } catch (e) {
        console.warn("[extractor] LLM failed, falling back to heuristic", e);
      }
    }
    return await this.heuristicExtract(turnText, referenceDate);
  }

  private async heuristicExtract(text: string, referenceDate: number): Promise<ExtractedMemory[]> {
    const candidates: ExtractedMemory[] = [];
    // Keep the terminator: the "is this a question?" gate below reads it, and
    // splitting on [.!?] silently strips exactly the punctuation it needs.
    const sentences = text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 12);
    // Every JEV_MIN_KEEP() is a synchronous settings.json read, so the threshold is
    // read once for the turn instead of once per judged sentence.
    const floor = JEV_MIN_KEEP();
    // A reply buries its conclusion at the end: "the fix was X" is sentence 20 of a
    // debugging turn, and the first-six cut never reached it. Rank the conclusion
    // shapes first (stable sort keeps the original order inside each rank) and stop
    // once maxPerTurn are kept.
    // ponytail: 40-sentence scan cap; longer than that is a transcript, not a turn.
    const ordered = [...sentences].sort((a, b) => Number(CONCLUSION.test(b)) - Number(CONCLUSION.test(a)));
    for (const s of ordered.slice(0, 40)) {
      if (candidates.length >= this.maxPerTurn) break;
      if (!Extractor.isWorthKeeping(s)) continue;
      // Cheap rules already dropped the obvious junk; what survives is exactly
      // the class they cannot judge — "run the tests before commit" is scaffolding
      // in one repo and a durable routine in another. One noul settles it.
      const verdict = await this.judge(s);
      if (verdict && verdict.keep < floor) continue;
      // Gate saw the punctuation; storage should not carry it.
      const clean = s.replace(/[.!?]+$/, "").trim();
      // Resolve "yesterday" while the turn's date is still known: a relative word keeps
      // decaying with the reader, an absolute date does not.
      const stamped = stampRelativeDate(clean, referenceDate);
      const lower = s.toLowerCase();
      let type: MemoryType = "episodic";
      let importance = 0.5;
      if (SELF_FACT.test(s)) {
        type = "semantic";
        importance = 0.8;
      } else if (CONCLUSION.test(s) || /(how to|step|remember to|recipe|process|always|never)/i.test(s)) {
        // A fix narrative states its own how, the same way "How to deploy: ..." does.
        // Nothing matched it before, so every debugging turn landed as episodic 0.5
        // and decayed first.
        type = "procedural";
        importance = 0.7;
      } else if (/(today|yesterday|just|we did|we decided)/i.test(lower)) {
        type = "episodic";
        importance = 0.6;
      }
      // Judge confidence outranks the regex importance: jev saw the whole
      // sentence, the pattern above only saw a verb.
      const tags = [...(verdict ? ["judged:jev"] : []), ...stamped.tags];
      candidates.push({
        text: stamped.text.slice(0, 500),
        type,
        importance: verdict ? importanceFor(verdict.keep) : importance,
        tags: tags.length ? tags : undefined,
      });
    }
    return candidates.slice(0, this.maxPerTurn);
  }

  /**
   * Write-side gate. Runs before anything reaches the store, so junk costs
   * nothing downstream - a bad memory is far more expensive than a missing one.
   *
   * ponytail: four cheap rules. Grow this only when a real junk class shows up in
   * the store; each new rule is a thing that can wrongly drop a good memory. The
   * interrogative rule above is the second one added for a measured junk class.
   */
  static isWorthKeeping(sentence: string): boolean {
    const s = sentence.trim();
    // Structure first: a table row or a fenced block is not a fact however well its
    // words read. This half of the gate was measured, not guessed (see isNonMemoryShape).
    if (isNonMemoryShape(s)) return false;
    // A question is a request for an answer, not an answer. Not a memory.
    if (/\?\s*$/.test(s)) return false;
    // Spoken turns drop the question mark: "how to look at it", "what next to ship
    // this". Measured against a real store, these scored 0.07-0.21 with the judge
    // while this regex let them in — the judge is optional and often off (no key),
    // so the cheap rule has to catch them.
    //
    // The exceptions carry more weight than the rule, because two of them are
    // exactly what the store is for:
    //   "Do not force push to main"                — a standing order
    //   "How to deploy the UI: npm run memory:ui"  — a procedure
    // The pair that makes this hard is "how to <blah>": one is a procedure, the other
    // a question whose answer is missing. The colon is the tell — a procedure carries
    // its steps, a question does not.
    // `may`/`might` are absent on purpose: "May 5 we decided..." is a date.
    const opensQuestion = /^(what|why|how|where|when|who|which|whose|can|could|should|would|will|do|does|did|is|are|give)\b/i.test(s);
    const carriesItsAnswer = HOW_TO.test(s) && STATES_HOW.test(s);
    // "When <something happens>, <do this>" is a standing rule, not a question —
    // two such rules were already in the store when this rule first ran. The comma
    // is the tell: a when-clause that continues into an instruction.
    if (opensQuestion && !carriesItsAnswer && !STANDING_ORDER.test(s) && !WHEN_CLAUSE.test(s)) return false;
    // An instruction aimed at the agent ("read the file", "run npm test") is
    // task scaffolding that expires in one turn. A fact about how the user
    // wants things phrased survives.
    // A leading adverb is still the same shape: "now finish the task" is the same
    // scaffolding as "finish the task", and it leaked in a real store.
    if (
      /^(please|now|then|first|just|ok|okay)?\s*(read|open|run|build|fix|make|add|remove|delete|create|show|list|explain|try|use|search|find|check|write|put|move|rename|update|change|install|deploy|commit|push|pull|merge|revert|stop|start|tag|release|continue|finish|ensure|verify|review|test|implement|refactor|document)\b/i.test(s) &&
      !STATES_HOW.test(s)
    ) {
      return false;
    }
    // A path or identifier with no spaces: "memoryService.ts:42", "src/api".
    // Code, not context.
    if (!/\s/.test(s) && /[.:/\\]/.test(s)) return false;
    return true;
  }

  /**
   * One noul per surviving sentence. Failure returns null, which means "store
   * it, unjudged" — the fail-open contract lives in the judge, not here.
   */
  private async judge(sentence: string): Promise<{ keep: number } | null> {
    // No enabled-check here: jevKeep applies the same gate and returns null when the
    // judge is off, so checking again only costs another settings.json read.
    try {
      return await jevKeep(sentence);
    } catch {
      return null;
    }
  }

  private async llmExtract(text: string, env: NodeJS.ProcessEnv, referenceDate: number): Promise<ExtractedMemory[]> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: env.EXTRACTOR_MODEL ?? "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Extract 0-3 memories from the turn. Return JSON {memories:[{text,type,importance,tags}]} where type is episodic|semantic|procedural|working, importance 0..1, tags string[]. Extract only durable facts/preferences/events. Don't invent.`
          },
          { role: "user", content: text.slice(0, 4000) }
        ]
      })
    });
    if (!res.ok) throw new Error(`LLM extract ${res.status}`);
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    const parsed = JSON.parse(json.choices[0].message.content) as { memories: ExtractedMemory[] };
    return (parsed.memories ?? []).slice(0, this.maxPerTurn).map((m) => {
      // The LLM is asked for durable facts, not for date arithmetic, so the same
      // relative-date resolution runs on its output.
      const stamped = stampRelativeDate(String(m.text), referenceDate);
      const tags = [...(Array.isArray(m.tags) ? m.tags.slice(0, 5).map(String) : []), ...stamped.tags];
      return {
        text: stamped.text.slice(0, 500),
        type: (["episodic", "semantic", "procedural", "working"].includes(m.type) ? m.type : "episodic") as MemoryType,
        importance: Math.max(0, Math.min(1, Number(m.importance) || 0.5)),
        tags: tags.length ? tags : undefined
      };
    });
  }
}
