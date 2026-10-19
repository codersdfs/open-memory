/**
 * The write-side decision: what a new memory does to the store.
 *
 * Pure. No store, no embedder, no network — the neighbours are handed in, the optional
 * judge is a function argument. That is what makes every rule testable without a
 * database, and what lets the caller keep the one vector query it already runs.
 *
 * Deleting data is the one irreversible thing here, so the guards outrank the judgement:
 * pinned rows, episodic events and extractor-sliced sentences are never superseded.
 */

import type { Memory, MemoryType } from "../types.js";
import { buildTags, inheritFacets } from "./facets.js";
import { covers, lexicalSimilarity, mergeText, normalizeText, tokenize } from "./text.js";

export type ReconcileAction = "insert" | "reinforce" | "supersede";

export type ReconcileReason =
  | "no-neighbour"
  | "exact-duplicate"
  | "model-duplicate"
  | "refinement"
  | "model-refines"
  | "model-contradicts"
  | "model-unrelated"
  | "model-unavailable"
  | "extractor-no-delete"
  | "episodic-no-delete"
  | "pinned-no-delete"
  | "typed-no-delete"
  | "disabled";

/** What a model may answer about an old/new pair. */
export type Relation = "duplicate" | "refines" | "contradicts";

/** One question about a pair. `null` = no usable answer (disabled, no key, failed). */
export type RelationJudge = (oldText: string, newText: string) => Promise<Relation | null>;

export const DEFAULT_THRESHOLDS = { lexical: 0.8, cosine: 0.85 } as const;

export interface Neighbour {
  memory: Memory;
  vectorScore: number;
}

export interface ReconcileInput {
  text: string;
  type: MemoryType;
  source?: string;
  callerTags?: string[];
  neighbours: Neighbour[];
  /** `embedder.name` of the running provider. `hash` cannot gate on cosine. */
  embedderKind: string;
  relation?: RelationJudge;
  thresholds?: { lexical?: number; cosine?: number };
}

export interface Decision {
  action: ReconcileAction;
  reason: ReconcileReason;
  oldId?: string;
  /** The text to store — the new one, or the merge when superseding. */
  text: string;
  tags: string[];
  /** Similarity to the winning neighbour, 0 when there was none. */
  lexical: number;
}

/**
 * Same claim, not same sentence.
 *
 * Token *sequence*, not token set: "prefers tabs over spaces" and "prefers spaces over
 * tabs" hold the same tokens in a different order and mean opposite things, and folding
 * them would discard the correction while reporting success. Punctuation and case still
 * disappear, which is the only insensitivity the rule needs.
 */
function sameClaim(a: string, b: string): boolean {
  return normalizeText(a) === normalizeText(b) || tokenize(a).join(" ") === tokenize(b).join(" ");
}

/**
 * How much longer than the old text a refinement may be before it is treated as a
 * different memory. A wiki section that happens to contain every token of a short memory
 * is not that memory's next version — it is a document.
 */
function growthCap(oldText: string): number {
  return Math.max(200, oldText.length * 4);
}

/** Only the two long-lived types may be superseded; `working` is scratch, `episodic` is an event. */
function deletable(type: MemoryType | undefined): boolean {
  return type === "semantic" || type === "procedural";
}

/** The best neighbour that clears the gate. */
function nearest(
  input: ReconcileInput,
  lexicalFloor: number,
  cosineFloor: number,
): { memory: Memory; lexical: number } | null {
  let best: { memory: Memory; lexical: number; vectorScore: number } | null = null;
  for (const n of input.neighbours) {
    const lexical = lexicalSimilarity(input.text, n.memory.text);
    // Containment counts as a near-hit: Jaccard punishes a short sentence that adds one
    // clause (4 of 6 tokens = 0.67), and "the same fact, longer" is exactly the case the
    // refinement rule exists for. The growth cap keeps a long document from qualifying.
    const contained = covers(n.memory.text, input.text) && input.text.length <= growthCap(n.memory.text);
    // The hash embedder scores ~0.9 cosine to everything, so cosine may gate only when a
    // real provider is configured. A gate that admits everything is not a gate.
    const passes = lexical >= lexicalFloor || contained || (input.embedderKind !== "hash" && n.vectorScore >= cosineFloor);
    if (!passes) continue;
    if (
      !best ||
      lexical > best.lexical ||
      (lexical === best.lexical && n.vectorScore > best.vectorScore)
    ) {
      best = { memory: n.memory, lexical, vectorScore: n.vectorScore };
    }
  }
  return best ? { memory: best.memory, lexical: best.lexical } : null;
}

export async function reconcile(input: ReconcileInput): Promise<Decision> {
  const lexicalFloor = input.thresholds?.lexical ?? DEFAULT_THRESHOLDS.lexical;
  const cosineFloor = input.thresholds?.cosine ?? DEFAULT_THRESHOLDS.cosine;
  const tags = buildTags(input.text, input.callerTags);
  const insert: Decision = { action: "insert", reason: "no-neighbour", text: input.text, tags, lexical: 0 };

  const hit = nearest(input, lexicalFloor, cosineFloor);
  if (!hit) return insert;
  const old = hit.memory;

  const supersede = (reason: ReconcileReason): Decision => ({
    action: "supersede",
    reason,
    oldId: old.id,
    text: mergeText(old.text, input.text),
    tags: inheritFacets(old.tags, tags),
    lexical: hit.lexical,
  });

  // R1 — identical claim, whatever the punctuation.
  if (sameClaim(input.text, old.text)) {
    return { action: "reinforce", reason: "exact-duplicate", oldId: old.id, text: old.text, tags, lexical: hit.lexical };
  }
  // D10 — an auto-sliced sentence may reinforce, never delete.
  if (input.source === "extractor") return { ...insert, reason: "extractor-no-delete", lexical: hit.lexical };
  // D6 — an event is time-bound; two similar events are two events.
  if (input.type === "episodic") return { ...insert, reason: "episodic-no-delete", lexical: hit.lexical };
  // The guards above read the incoming write; this one reads the row that would be
  // deleted. A store call with no `type` removes the neighbour filter entirely, so the
  // incoming type cannot be trusted to describe the old row.
  if (!deletable(input.type) || !deletable(old.type)) {
    return { ...insert, reason: "typed-no-delete", lexical: hit.lexical };
  }
  // `pin` is explicit intent, and the one thing a rewrite must not override.
  if (old.pin === 1) return { ...insert, reason: "pinned-no-delete", lexical: hit.lexical };

  // The new sentence states everything the old one did, and more — but only by a little.
  if (covers(old.text, input.text) && input.text.length <= growthCap(old.text)) return supersede("refinement");

  if (!input.relation) return { ...insert, reason: "model-unavailable", lexical: hit.lexical };

  let relation: Relation | null = null;
  try {
    relation = await input.relation(old.text, input.text);
  } catch {
    // Fail-open: a judge that is down must not block or delete a write.
    return { ...insert, reason: "model-unavailable", lexical: hit.lexical };
  }
  if (relation === "duplicate") {
    return { action: "reinforce", reason: "model-duplicate", oldId: old.id, text: old.text, tags, lexical: hit.lexical };
  }
  if (relation === "refines") return supersede("model-refines");
  if (relation === "contradicts") return supersede("model-contradicts");
  return { ...insert, reason: "model-unrelated", lexical: hit.lexical };
}
