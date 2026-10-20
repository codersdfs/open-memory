import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { Extractor } from "../src/core/extraction/extractor.js";

// vite's builtin list predates `node:sqlite`, so a static import is rewritten to a bare
// "sqlite" and fails to resolve. require() keeps the ESM-only test file working.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/**
 * The gate was tightened because a real store measured 53.7% junk, so the real store is
 * the only honest test for it. The copy lives outside the repo and is named by
 * MEMORY_AUDIT_DB: the suite must never open the live database, and CI has no copy.
 *
 * The junk predicate below is the audit's, copied verbatim from
 * `mem_audit_e3849f9b/audit3.mjs:35`. It is deliberately *not* the shape of the new gate:
 * if both sides moved together the test would only prove the code agrees with itself.
 */
function isAuditJunk(text: string): boolean {
  return (
    /^[-*+]\s/.test(text) ||
    /<[a-zA-Z][^>]{0,60}>/.test(text) ||
    /\|/.test(text) ||
    /^#{1,6}\s/.test(text) ||
    /^Session \d+/.test(text) ||
    /^user\b/i.test(text) ||
    /^[A-Za-z]:\\/.test(text) ||
    text.trim().length < 40
  );
}

const DB = process.env.MEMORY_AUDIT_DB;

describe.skipIf(!DB)("gate against the audited store", () => {
  const rows: { id: string; text: string }[] = [];
  if (DB) {
    // Every stored row, including soft-deleted ones: the audit selected `select * from
    // memories` (36 of the 335 are is_deleted=1), and those rows are what the extractor
    // wrote. Filtering them out would shrink the sample to 299 and move the target.
    const db = new DatabaseSync(DB, { readOnly: true });
    for (const row of db.prepare("SELECT id, text FROM memories").all()) {
      rows.push({ id: String(row.id), text: String(row.text) });
    }
    db.close();
  }
  const junk = rows.filter((r) => isAuditJunk(r.text));
  const isRejected = (r: { text: string }) => !Extractor.isWorthKeeping(r.text);

  it("sees the audited sample (allows catching a wrong DB copy)", () => {
    expect(rows.length).toBe(335);
    expect(junk.length).toBe(180);
  });

  // 80% is the bar the write path has to clear on the sample that motivated the work;
  // the measured value is higher, and the number is printed so a regression is visible
  // even when it stays above the bar.
  it("rejects at least 80% of the junk rows", () => {
    const hits = junk.filter(isRejected).length;
    const recall = hits / junk.length;
    console.log(`gate audit: ${hits}/${junk.length} junk rows rejected (${(recall * 100).toFixed(1)}%)`);
    expect(recall).toBeGreaterThanOrEqual(0.8);
  });

  // Recall alone is gameable by rejecting everything. The real store is 332 normal rows
  // of prose and fixtures, so the false-kill budget is five: a gate that drops a real
  // fact costs more than a junk row that slips through.
  it("rejects at most 5 rows that the audit did not call junk", () => {
    const falseKills = rows.filter((r) => !isAuditJunk(r.text) && isRejected(r));
    console.log(`gate audit: ${falseKills.length} false kills: ${falseKills.map((r) => JSON.stringify(r.text.slice(0, 60))).join(" | ")}`);
    expect(falseKills.length).toBeLessThanOrEqual(5);
  });

  it("rejects the shapes the audit named, not just the short ones", () => {
    const byShape = [
      (t: string) => t.startsWith("- "),
      (t: string) => t.includes("|"),
      (t: string) => /^#{1,6}\s/.test(t),
      (t: string) => /<\/?[a-z][\w-]*(\s[^>]*)?>/i.test(t),
      (t: string) => /^Session \d+/.test(t)
    ];
    for (const shape of byShape) {
      const sample = junk.filter((r) => shape(r.text));
      expect(sample.length).toBeGreaterThan(0);
      // Structure is unambiguous; every one it names must go.
      expect(sample.filter((r) => !isRejected(r))).toHaveLength(0);
    }
  });
});
