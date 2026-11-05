/**
 * ADR-0037: an empty search has to explain itself — in every renderer.
 *
 * `src/core/retrieval/hybrid.ts` decides *what* the explanation is (see
 * tests/diagnostics.test.ts); this file pins the rendering, which is where the
 * original defect lived. "no memories matched" was the same sentence for "nothing
 * is stored here" and "your wording missed the gate", and the only move an agent
 * knows from it is to reword and retry.
 */
import { describe, it, expect } from "vitest";
import { renderEmptySearch } from "../src/core/retrieval/explain.js";
import type { SearchDiagnostics } from "../src/core/types.js";

const diag = (over: Partial<SearchDiagnostics> = {}): SearchDiagnostics => ({
  threshold: 0.72,
  partitions: [{ namespace: "pi:frank", total: 3 }],
  nearMisses: [],
  ...over
});

describe("renderEmptySearch", () => {
  it("keeps the old one-liner when the daemon sent no diagnostics", () => {
    // An older daemon answers without the key. A tool result must not throw, and it
    // must not invent an explanation it does not have.
    expect(renderEmptySearch(undefined)).toBe("no memories matched");
  });

  it("starts with the line callers already grep for", () => {
    const out = renderEmptySearch(diag());
    expect(out.split("\n")[0]).toBe("no memories matched");
  });

  it("says nothing was stored when every searched partition is empty", () => {
    const out = renderEmptySearch(
      diag({ partitions: [{ namespace: "pi:frank", total: 0 }, { namespace: "default:default", total: 0 }] })
    );
    // The tail that ends the retry loop.
    expect(out).toContain("nothing was stored for this scope");
    // And it must not suggest widening to a scope that is also empty.
    expect(out).not.toContain("retry with threshold");
    expect(out).toContain("pi:frank (0 rows)");
  });

  it("names the partition counts so the wrong-partition case is visible", () => {
    const out = renderEmptySearch(
      diag({ partitions: [{ namespace: "default:default", total: 346 }, { namespace: "pi:frank", total: 0 }] })
    );
    expect(out).toContain("default:default (346 rows)");
    expect(out).toContain("pi:frank (0 rows)");
  });

  it("reports the near misses below the threshold, best first", () => {
    const out = renderEmptySearch(
      diag({
        nearMisses: [
          { text: "the Strata ACL lives in codex", relevance: 0.41, bm25: 0.41, vector: 0.1, coverage: 0.25 },
          { text: "Strata was renamed", relevance: 0.19, bm25: 0, vector: 0.19, coverage: 0.1 }
        ]
      })
    );
    expect(out).toContain("closest 2 below 0.72: 0.41 / 0.19");
    expect(out).toContain("0.41 [lexical] the Strata ACL lives in codex");
    // vector > bm25 on the second one, so it reads as semantic rather than lexical.
    expect(out).toContain("0.19 [semantic] Strata was renamed");
  });

  it("suggests the next threshold down when a near miss was actually gated", () => {
    // A near miss is the evidence that the threshold did the rejecting, which is what
    // makes "lower it" a correct move.
    const out = renderEmptySearch(
      diag({
        threshold: 0.35,
        nearMisses: [{ text: "alpha", relevance: 0.3, bm25: 0.3, vector: 0, coverage: 0.2 }]
      })
    );
    // 0.35 - 0.2, floored at 0.05.
    expect(out).toContain("retry with threshold 0.15");
  });

  it("blames the wording, not the threshold, when no row even shared a term", () => {
    // Measured on a real 363-row partition: a query sharing no term with any row still
    // came back with "retry with threshold 0.7", and no threshold can fix that — the
    // rows never became candidates, so the gate never ran.
    const out = renderEmptySearch(diag({ threshold: 0.9, partitions: [{ namespace: "default:default", total: 363 }] }));
    expect(out).toContain("none shared a term with this query");
    expect(out).not.toContain("retry with threshold");
    // Still not "nothing is stored": 363 rows are there.
    expect(out).not.toContain("nothing was stored");
    expect(out).toContain("default:default (363 rows)");
  });

  it("clips a long near miss to one line", () => {
    const out = renderEmptySearch(
      diag({
        nearMisses: [{ text: `${"word ".repeat(80)}`, relevance: 0.3, bm25: 0.3, vector: 0, coverage: 0.2 }]
      })
    );
    const nearLine = out.split("\n").find((l) => l.includes("[lexical]"))!;
    // `    - 0.30 [lexical] ` is 21 characters of framing, then the clip at 120.
    expect(nearLine.length).toBeLessThanOrEqual(21 + 120);
    expect(nearLine.endsWith("…")).toBe(true);
  });

  it("survives a malformed payload from an unexpected daemon", () => {
    // Defensive, not hypothetical: the extension reads the same field over HTTP.
    const junk = { threshold: "x", partitions: "nope", nearMisses: [null, { text: 5 }] } as unknown as SearchDiagnostics;
    expect(() => renderEmptySearch(junk)).not.toThrow();
    expect(renderEmptySearch(junk).split("\n")[0]).toBe("no memories matched");
  });

  // ADR-0039: the diagnosis has to survive being right about the wrong question.
  describe("rows outside the read scope", () => {
    it("says the fact is filed elsewhere instead of that it was never stored", () => {
      // The exact defect: a layered read of pi:frank finds nothing, and the message
      // says "nothing was stored for this scope" while 366 rows sit one layer over.
      // That sentence is true and it sends the caller off to reword a query that was
      // never going to work.
      const out = renderEmptySearch(
        diag({
          partitions: [{ namespace: "pi:frank", total: 0 }],
          outside: [{ namespace: "default:default", total: 366 }]
        })
      );
      expect(out).toContain("outside this scope: default:default (366 rows)");
      expect(out).toContain("nothing was stored in this scope, but 366 rows exist outside it");
      // The in-scope "nothing was stored" line on its own would be the bug back again.
      expect(out).not.toMatch(/→ nothing was stored for this scope\.$/m);
    });

    it("names every outside partition and sums their rows", () => {
      const out = renderEmptySearch(
        diag({
          partitions: [{ namespace: "pi:frank", total: 0 }],
          outside: [
            { namespace: "coding-agent:frank", total: 4 },
            { namespace: "default:default", total: 366 }
          ]
        })
      );
      expect(out).toContain("coding-agent:frank (4 rows)");
      expect(out).toContain("default:default (366 rows)");
      expect(out).toContain("370 rows exist outside it");
    });

    it("stays quiet about outside partitions that hold nothing", () => {
      // A partition nobody wrote to is not news, and listing it turns the one line
      // that matters into an inventory.
      const out = renderEmptySearch(
        diag({
          partitions: [{ namespace: "pi:frank", total: 0 }],
          outside: [{ namespace: "shared:frank", total: 0 }]
        })
      );
      expect(out).not.toContain("outside this scope");
      expect(out).toContain("nothing was stored for this scope");
    });

    it("keeps the in-scope diagnosis when the scope itself had rows", () => {
      // Rows outside do not change why the in-scope rows failed the gate.
      const out = renderEmptySearch(
        diag({
          partitions: [{ namespace: "pi:frank", total: 3 }],
          outside: [{ namespace: "default:default", total: 366 }],
          nearMisses: [{ text: "alpha", relevance: 0.3, bm25: 0.3, vector: 0, coverage: 0.2 }]
        })
      );
      expect(out).toContain("outside this scope: default:default (366 rows)");
      expect(out).toContain("retry with threshold");
    });

    it("keeps the old one-liner when an old daemon sent no diagnostics at all", () => {
      // `outside` must never appear from a daemon that predates it.
      expect(renderEmptySearch(undefined)).toBe("no memories matched");
    });
  });
});
