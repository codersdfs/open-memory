export function countTokens(text: string): number {
  // heuristic: ~4 chars per token (gpt). If js-tiktoken is installed, could be swapped.
  // Keeping sync + deterministic for tests.
  return Math.max(1, Math.ceil(text.length / 4));
}

export function budgetEnforce<T extends { text: string }>(
  items: (T & { score: number })[],
  budgetTokens: number
): { kept: (T & { score: number; tokens: number })[]; tokensUsed: number; truncated: boolean; summary: string | null } {
  const withTokens = items.map((it) => ({ ...it, tokens: countTokens(it.text) }));
  let used = 0;
  const kept: typeof withTokens = [];
  let truncated = false;
  for (const it of withTokens) {
    if (used + it.tokens <= budgetTokens) {
      kept.push(it);
      used += it.tokens;
    } else {
      truncated = true;
      break;
    }
  }
  let summary: string | null = null;
  if (truncated) {
    const overflow = withTokens.slice(kept.length);
    if (overflow.length > 0) {
      summary = overflow
        .slice(0, 3)
        .map((o) => {
          const firstSentence = o.text.split(/[.!?]/)[0]?.trim() ?? o.text;
          const words = firstSentence.split(/\s+/).slice(0, 20).join(" ");
          return words + (words.length < firstSentence.length ? "…" : "");
        })
        .join(" | ");
    }
  }
  const tokensUsed = kept.reduce((s, it) => s + it.tokens, 0);
  return { kept, tokensUsed, truncated, summary };
}
