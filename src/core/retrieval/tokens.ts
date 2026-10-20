const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

export function countTokens(text: string): number {
  // The budget is a promise to the caller, so the estimate has to be honest for
  // the store it is actually spending from. A real store here is ~60% Chinese,
  // and Chinese has no spaces: chars/4 counts a 30-character sentence as 8
  // tokens when a model spends ~30. Counting each CJK code point as one token
  // (and keeping chars/4 for the Latin remainder) is conservative without being
  // absurd, and it is what makes an 800-token cap mean 800 tokens in both
  // languages. Sync + deterministic on purpose: tests depend on it.
  const cjkCount = (text.match(CJK) ?? []).length;
  const latinChars = text.replace(CJK, "").length;
  return Math.max(1, cjkCount + Math.ceil(latinChars / 4));
}

/**
 * Head of `text` that fits `budget` tokens, cut on a sentence boundary when one
 * exists. Returns null when even the first sentence overshoots.
 */
function clipToBudget(text: string, budget: number): string | null {
  const sentences = text.split(/(?<=[.!?。！？；;])\s*/).filter((s) => s.length > 0);
  let out = "";
  for (const sentence of sentences) {
    const next = out + sentence;
    if (countTokens(next) > budget) break;
    out = next;
  }
  return out.length > 0 ? out.trim() : null;
}

export interface BudgetOptions {
  /**
   * Fallback for an item that does not fit whole: return a projection of `text`
   * that fits `maxTokens` tokens, or null to leave it out (overflow summary picks
   * it up instead). Used by search to fit a fragment of a long memory in the
   * space a whole one would not fit — never to replace a row that did fit.
   */
  project?: (text: string, maxTokens: number) => string | null;
}

export function budgetEnforce<T extends { text: string }>(
  items: (T & { score: number })[],
  budgetTokens: number,
  options: BudgetOptions = {}
): { kept: (T & { score: number; tokens: number })[]; tokensUsed: number; truncated: boolean; summary: string | null } {
  const withTokens = items.map((it) => ({ ...it, tokens: countTokens(it.text) }));
  const kept: typeof withTokens = [];
  const overflow: typeof withTokens = [];
  // Tokens of the cheapest item still ahead of position i. A projection may only
  // spend space that nothing else could have used, so it can never displace a row
  // that would otherwise have fit whole — that displacement was measurable (bench
  // evidence coverage 62.5% → 61.8% without this guard).
  const cheapestAhead = new Array<number>(withTokens.length + 1).fill(Number.POSITIVE_INFINITY);
  for (let i = withTokens.length - 1; i >= 0; i--) {
    cheapestAhead[i] = Math.min(cheapestAhead[i + 1]!, withTokens[i]!.tokens);
  }
  let used = 0;

  for (const [index, it] of withTokens.entries()) {
    if (used + it.tokens <= budgetTokens) {
      kept.push(it);
      used += it.tokens;
      continue;
    }
    // v0.4: skip, do not stop. The old `break` let one oversized row end the
    // whole list, so a 900-token memory at rank 1 could shadow five smaller
    // matches behind it and leave a third of the budget unspent (measured:
    // 660 of 800 tokens used on a bench run). Skipping keeps filling.
    if (kept.length === 0 && budgetTokens >= 40) {
      // Only the top-ranked item can be "too big for the whole budget". Cutting
      // it beats returning an empty answer to a query it matched best.
      const clipped = clipToBudget(it.text, budgetTokens);
      if (clipped !== null) {
        const tokens = countTokens(clipped);
        kept.push({ ...it, text: clipped, tokens });
        used += tokens;
        continue;
      }
    }
    // v0.4: the space this row could not have is offered to a fragment of it. A
    // 275-token chunk with 120 tokens left used to be dropped whole (and went
    // into the summary); projected onto its matching lines it still contributes
    // evidence. Rows that fit whole are never touched, so this can only add.
    const remaining = budgetTokens - used;
    const cheapest = cheapestAhead[index + 1] ?? Number.POSITIVE_INFINITY;
    if (options.project && remaining >= 64 && remaining < cheapest) {
      const projected = options.project(it.text, remaining - 1);
      if (projected !== null && projected.length > 0) {
        const tokens = countTokens(projected);
        if (tokens <= remaining) {
          kept.push({ ...it, text: projected, tokens });
          used += tokens;
          continue;
        }
      }
    }
    overflow.push(it);
  }

  let summary: string | null = null;
  if (overflow.length > 0) {
    summary = overflow
      .slice(0, 3)
      .map((o) => {
        const firstSentence = o.text.split(/[.!?。！？]/)[0]?.trim() ?? o.text;
        const words = firstSentence.split(/\s+/).slice(0, 20).join(" ");
        return words + (words.length < firstSentence.length ? "…" : "");
      })
      .join(" | ");
  }

  const tokensUsed = kept.reduce((s, it) => s + it.tokens, 0);
  return { kept, tokensUsed, truncated: overflow.length > 0, summary };
}
