import type { MemoryType } from "../types.js";

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
    return this.heuristicExtract(turnText);
  }

  private heuristicExtract(text: string): ExtractedMemory[] {
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
      candidates.push({ text: clean.slice(0, 500), type, importance });
    }
    return candidates.slice(0, this.maxPerTurn);
  }

  /**
   * Write-side gate. Runs before anything reaches the store, so junk costs
   * nothing downstream - a bad memory is far more expensive than a missing one.
   *
   * ponytail: three cheap rules. Grow this only when a real junk class shows up
   * in the store; each new rule is a thing that can wrongly drop a good memory.
   */
  static isWorthKeeping(sentence: string): boolean {
    const s = sentence.trim();
    // A question is a request for an answer, not an answer. Not a memory.
    if (/\?\s*$/.test(s)) return false;
    // An instruction aimed at the agent ("read the file", "run npm test") is
    // task scaffolding that expires in one turn. A fact about how the user
    // wants things phrased survives.
    if (/^(please\s+)?(read|open|run|build|fix|make|add|remove|delete|create|show|list|explain|try|use|search|find|check|write)\b/i.test(s)) return false;
    // A path or identifier with no spaces: "memoryService.ts:42", "src/api".
    // Code, not context.
    if (!/\s/.test(s) && /[.:/\\]/.test(s)) return false;
    return true;
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
