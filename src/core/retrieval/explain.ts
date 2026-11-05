import type { SearchDiagnostics } from "../types.js";

/**
 * Render an empty search result for a human or a model (ADR-0037).
 *
 * The sentence this replaces — "no memories matched" — was identical for three
 * different situations: the partition holds nothing, the caller looked at the wrong
 * partition, and the rows are there but the wording missed the gate. The only move
 * an agent knows from that is to **reword and retry**, which cannot work for the
 * first two. Measured on one real session: a single question cost 14 tool calls and
 * the first 6 were reworded retries against the same store.
 *
 * `diagnostics` is optional on purpose: a caller may be talking to a daemon built
 * before this existed, and `GET /memories/search` answers with whatever that daemon
 * returns. Absent, malformed or empty all fall back to the old one-liner rather than
 * throwing inside a tool result.
 *
 * The first line is kept as `no memories matched` so existing callers that grep for
 * it keep working; everything after it is the explanation.
 */
export function renderEmptySearch(diagnostics?: SearchDiagnostics): string {
  const head = "no memories matched";
  if (!diagnostics || typeof diagnostics !== "object") return head;

  const threshold = typeof diagnostics.threshold === "number" ? diagnostics.threshold : 0;
  const partitions = Array.isArray(diagnostics.partitions)
    ? diagnostics.partitions.filter((p) => p && typeof p.namespace === "string")
    : [];
  const nearMisses = Array.isArray(diagnostics.nearMisses)
    ? diagnostics.nearMisses.filter((n) => n && typeof n.text === "string")
    : [];
  // ADR-0039. Kept separate from `partitions` rather than merged into one list: the
  // two answer different questions ("did you look here" vs "should you have looked
  // there"), and merging them would let a caller mistake an unsearched partition for
  // one that was searched and came back empty.
  const outside = Array.isArray(diagnostics.outside)
    ? diagnostics.outside.filter((p) => p && typeof p.namespace === "string" && p.total > 0)
    : [];

  const lines = [head];

  if (partitions.length > 0) {
    lines.push(`  searched: ${partitions.map((p) => `${p.namespace} (${p.total} rows)`).join(", ")}`);
  }

  if (nearMisses.length > 0) {
    const top = nearMisses.slice(0, 3);
    const scores = top.map((n) => (typeof n.relevance === "number" ? n.relevance : 0));
    lines.push(`  closest ${top.length} below ${threshold}: ${scores.map((s) => s.toFixed(2)).join(" / ")}`);
    for (let i = 0; i < top.length; i++) {
      // No `type` on a near miss: name the arm that carried it, so a lexical-only
      // hit reads differently from a real semantic one.
      const how = (top[i]!.vector ?? 0) > (top[i]!.bm25 ?? 0) ? "semantic" : "lexical";
      lines.push(`    - ${scores[i]!.toFixed(2)} [${how}] ${clip(top[i]!.text)}`);
    }
  }

  // The tails are the point, and there are three of them because there are three
  // different next moves. A single "rows exist, widen" tail was wrong for the case it
  // most often met: when no row is even a candidate, the threshold never ran, so
  // lowering it cannot change the answer — measured on a 363-row partition where a
  // query sharing no term with any row still said "retry with threshold 0.7".
  //
  // ADR-0039 adds the fourth case, and it outranks the other three: when the scope
  // itself is empty but rows exist outside it, every in-scope diagnosis is true and
  // useless. "Nothing was stored for this scope" is the exact sentence that sends a
  // caller looking for a different phrasing of a fact that is simply filed elsewhere.
  if (outside.length > 0) {
    lines.push(`  outside this scope: ${outside.map((p) => `${p.namespace} (${p.total} rows)`).join(", ")}`);
  }
  const outsideTotal = outside.reduce((n, p) => n + (typeof p.total === "number" ? p.total : 0), 0);
  const nothingStored = partitions.length > 0 && partitions.every((p) => p.total === 0);
  if (nothingStored && outsideTotal > 0) {
    lines.push(
      `  → nothing was stored in this scope, but ${outsideTotal} rows exist outside it: widen the scope to include them.`
    );
  } else if (nothingStored) {
    lines.push("  → nothing was stored for this scope.");
  } else if (partitions.length > 0 && nearMisses.length === 0) {
    // Rows are there, but not one of them shared a term with the query: the words are
    // the problem, not the gate.
    lines.push("  → rows exist but none shared a term with this query: different words, not a lower threshold.");
  } else if (partitions.length > 0) {
    // The next threshold down that is still a real gate. 0.2 below the current one,
    // floored at 0.05: low enough to admit a weak match, never zero.
    const lower = Math.max(0.05, Number((threshold - 0.2).toFixed(2)));
    lines.push(`  → rows exist but none matched: retry with threshold ${lower}.`);
  } else if (outsideTotal > 0) {
    // No in-scope counts to reason about, only the neighbours: say the one true thing.
    lines.push(`  → rows exist outside this scope: widen it to include them.`);
  }

  return lines.join("\n");
}

/** Keep one near-miss line to one line: the whole message goes into a prompt. */
function clip(s: string, max = 120): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
