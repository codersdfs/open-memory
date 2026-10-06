import type { MemoryType } from "../types.js";
import { jevKeep, jevEnabled, importanceFor, JEV_MIN_KEEP } from "../judgment/judge.js";

export interface ExtractedMemory {
  text: string;
  type: MemoryType;
  importance: number;
  tags?: string[];
}

// Hybrid extractor: opt-in LLM + heuristic fallback.
// When LLM not configured, uses heuristic rules.

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
   */
  async extract(turnText: string): Promise<ExtractedMemory[]> {
    const apiKey = process.env.OPENAI_API_KEY;
    const enabled = process.env.ENABLE_EXTRACTOR === "true";
    if (enabled && apiKey) {
      try {
        return await this.llmExtract(turnText);
      } catch (e) {
        console.warn("[extractor] LLM failed, falling back to heuristic", e);
      }
    }
    return await this.heuristicExtract(turnText);
  }

  private async heuristicExtract(text: string): Promise<ExtractedMemory[]> {
    const candidates: ExtractedMemory[] = [];
    // Keep the terminator: the "is this a question?" gate below reads it, and
    // splitting on [.!?] silently strips exactly the punctuation it needs.
    const sentences = text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 12);
    for (const s of sentences.slice(0, this.maxPerTurn * 2)) {
      if (candidates.length >= this.maxPerTurn) break;
      if (!Extractor.isWorthKeeping(s)) continue;
      // Cheap rules already dropped the obvious junk; what survives is exactly
      // the class they cannot judge — "run the tests before commit" is scaffolding
      // in one repo and a durable routine in another. One noul settles it.
      const verdict = await this.judge(s);
      if (verdict && verdict.keep < JEV_MIN_KEEP()) continue;
      // Gate saw the punctuation; storage should not carry it.
      const clean = s.replace(/[.!?]+$/, "").trim();
      const lower = s.toLowerCase();
      let type: MemoryType = "episodic";
      let importance = 0.5;
      if (/(i live|i am|my name|i like|i prefer|i work|i use|i need|i hate)/i.test(s)) {
        type = "semantic";
        importance = 0.8;
      } else if (/(how to|step|remember to|recipe|process|always|never)/i.test(s)) {
        type = "procedural";
        importance = 0.7;
      } else if (/(today|yesterday|just|we did|we decided)/i.test(lower)) {
        type = "episodic";
        importance = 0.6;
      }
      // Judge confidence outranks the regex importance: jev saw the whole
      // sentence, the pattern above only saw a verb.
      candidates.push({
        text: clean.slice(0, 500),
        type,
        importance: verdict ? importanceFor(verdict.keep) : importance,
        tags: verdict ? ["judged:jev"] : undefined,
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
    // One idea, used by both rules below: a sentence that states its own how (a
    // colon, a command, "with/using/via") is knowledge. One that does not is
    // scaffolding. This is what separates "How to deploy: npm run x" from "how to
    // look at it", and "Start the daemon with \`ai-memory daemon start\`" from "start
    // it please".
    const statesTheHow = /[:\`]|\b(with|using|via)\b/i.test(s);
    const carriesItsAnswer = /^(how|what|where|when|who) to\b/i.test(s) && statesTheHow;
    const isAnOrder = /^(do not|don't|does not|is not|are not|why not)\b/i.test(s);
    // "When <something happens>, <do this>" is a standing rule, not a question —
    // two such rules were already in the store when this rule first ran. The comma
    // is the tell: a when-clause that continues into an instruction.
    const isACondition = /^when(ever)?\s+[^,]{3,},\s*\S/i.test(s);
    if (opensQuestion && !carriesItsAnswer && !isAnOrder && !isACondition) return false;
    // An instruction aimed at the agent ("read the file", "run npm test") is
    // task scaffolding that expires in one turn. A fact about how the user
    // wants things phrased survives.
    // A leading adverb is still the same shape: "now finish the task" is the same
    // scaffolding as "finish the task", and it leaked in a real store.
    if (
      /^(please|now|then|first|just|ok|okay)?\s*(read|open|run|build|fix|make|add|remove|delete|create|show|list|explain|try|use|search|find|check|write|put|move|rename|update|change|install|deploy|commit|push|pull|merge|revert|stop|start|tag|release|continue|finish|ensure|verify|review|test|implement|refactor|document)\b/i.test(s) &&
      !statesTheHow
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
    if (!jevEnabled()) return null;
    try {
      return await jevKeep(sentence);
    } catch {
      return null;
    }
  }

  private async llmExtract(text: string): Promise<ExtractedMemory[]> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.EXTRACTOR_MODEL ?? "gpt-4o-mini",
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
    return (parsed.memories ?? []).slice(0, this.maxPerTurn).map((m) => ({
      text: String(m.text).slice(0, 500),
      type: (["episodic", "semantic", "procedural", "working"].includes(m.type) ? m.type : "episodic") as MemoryType,
      importance: Math.max(0, Math.min(1, Number(m.importance) || 0.5)),
      tags: Array.isArray(m.tags) ? m.tags.slice(0, 5).map(String) : undefined
    }));
  }
}
