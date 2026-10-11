/**
 * The supersede chain, walked from whatever row the console is showing.
 *
 * `supersedesId` (src/core/types.ts:41) is the only edge the store holds: a row
 * points at the row it replaced. So "backward" is following that pointer and
 * "forward" is finding every row whose pointer names the current id, recursively.
 * The origin row is in neither list.
 */

import type { Memory } from "./api";

export function chainOf(id: string, rows: Memory[]): { ancestors: Memory[]; successors: Memory[] } {
  const byId = new Map(rows.map((row) => [row.id, row]));
  // One set for both walks: a cycle (a -> b -> a, or a row superseding itself)
  // must terminate, and a row may never appear on both sides.
  const seen = new Set<string>([id]);

  // Backward: nearest ancestor first.
  const ancestors: Memory[] = [];
  let cursor = byId.get(id)?.supersedesId ?? null;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const row = byId.get(cursor);
    if (row === undefined) break; // the ancestor is not in this page of rows
    ancestors.push(row);
    cursor = row.supersedesId ?? null;
  }

  // Forward: breadth-first over the rows that supersede the current one.
  const successors: Memory[] = [];
  const queue: string[] = [id];
  for (let head = 0; head < queue.length; head++) {
    const parent = queue[head];
    if (parent === undefined) continue;
    for (const row of rows) {
      if (row.supersedesId === parent && !seen.has(row.id)) {
        seen.add(row.id);
        successors.push(row);
        queue.push(row.id);
      }
    }
  }

  return { ancestors, successors };
}
