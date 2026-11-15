/**
 * The write-side decision: what a new memory does to the store.
 *
 * Pure. No store, no embedder, no network — the neighbours are handed in, the optional
 * judge is a function argument. That is what makes every rule testable without a
 * database, and what lets the caller keep the one vector query it already runs. The one
 * side-channel is observability, not decision input: a judge failure writes its running
 * count to stderr (P5, ADR-0047) and tags the row, so a broken judge is visible without
 * changing what the decision does.
 *
 * Deleting data is the one irreversible thing here, so the guards outrank the judgement:
 * pinned rows, episodic events and extractor-sliced sentences are never superseded.
 */

import type { Memory, MemoryType } from "../types.js";
import { appendTag, buildTags, facetTagsOf, inheritFacets } from "./facets.js";
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
  | "conflict-unjudged"
  | "judge-failed"
  | "extractor-no-delete"
  | "episodic-no-delete"
  | "pinned-no-delete"
  | "typed-no-delete"
  | "disabled";

/**
 * The marker the conflict window (P5, ADR-0047) puts on unjudged contradiction pairs:
 * `conflict:<entity>` in the facet vocabulary, so the pair is listable, countable and
 * adjudicable instead of silently coexisting. The ADR-0041 amendment this lands with
 * pins the boundary: a judge that was *asked and failed* reports itself
 * (`judge-failed`, tag `judged:failed`) and never mints one — a failure admits no
 * contradiction, it only admits it could not read the pair.
 */
export const CONFLICT_TAG_PREFIX = "conflict:";
/** The tag a judge failure leaves on the row it could not judge (ADR-0041 amendment). */
export const JUDGE_FAILED_TAG = "judged:failed";

/** Every failure this process has seen, for the stderr line's running count. */
let judgeFailures = 0;

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
  /**
   * The conflict facet this decision minted (`conflict:<entity>`), present only when the
   * judge was absent and the pair read as the same subject stated differently (P5,
   * ADR-0047). `tags` already carries it for the incoming row; the caller uses this value
   * to mark the *existing* row through `updateMeta`'s tags patch — the P4-maintained path
   * — so its facet postings follow the column.
   */
  conflictFacet?: string;
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

/**
 * The subject both texts name (P5, ADR-0047): the first `entity:` facet they share — the
 * incoming row's own tags (the ones `buildTags` would store) against the neighbour's.
 * Deliberately `entity:` only: a shared `topic:` says the two sentences are about the
 * same *thing*, not that they speak of the same *subject*, and a conflict named after a
 * topic would drag unrelated rows into one adjudication. `null` when neither text names
 * an explicit entity or the names differ — then the pair keeps coexisting unmarked,
 * because a marker with no subject cannot be adjudicated either.
 */
function sharedEntity(input: ReconcileInput, old: Memory): string | null {
  const held = new Set(
    facetTagsOf(old.tags)
      .map((t) => t.toLowerCase())
      .filter((t) => t.startsWith("entity:"))
  );
  for (const facet of facetTagsOf(buildTags(input.text, input.callerTags))) {
    const lower = facet.toLowerCase();
    if (!lower.startsWith("entity:")) continue;
    if (held.has(lower)) return lower.slice("entity:".length);
  }
  return null;
}

/**
 * The conflict window's neighbour list (P5, ADR-0047): the three candidate arms deduped
 * by id in arm order and capped. Arm order is priority — the same-type vector top-5 the
 * write path has always run, then the facet arm (same `entity:` facet, any type), then
 * the cross-type arm fills what is left — so the cap, when it bites, trims the weakest
 * arm first. ≤10 is the whole point of the cap: the widened window must not turn every
 * save into a wider scan than the guards can read.
 */
export function unionNeighbours(arms: Neighbour[][], cap: number): Neighbour[] {
  const seen = new Set<string>();
  const out: Neighbour[] = [];
  for (const arm of arms) {
    for (const n of arm) {
      if (out.length >= cap) return out;
      if (seen.has(n.memory.id)) continue;
      seen.add(n.memory.id);
      out.push(n);
    }
  }
  return out;
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

  if (!input.relation) {
    // P5 (ADR-0047): the judge is *absent* — not configured, or configured without a key.
    // This is the point the research notes name (reconciler.ts:162 used to coexist
    // silently here). Reaching this line already establishes "different predicate": the
    // same claim was folded at R1, a refinement superseded above, and the four no-delete
    // guards had their say before this branch — a guarded pair keeps its guard's reason
    // and never reaches the marker. What remains is the subject test, and a pair that
    // names the same entity stores with a `conflict:<entity>` facet on both rows instead
    // of a silent double write.
    const entity = sharedEntity(input, old);
    if (entity) {
      const facet = CONFLICT_TAG_PREFIX + entity;
      return {
        ...insert,
        reason: "conflict-unjudged",
        conflictFacet: facet,
        oldId: old.id,
        tags: appendTag(tags, facet),
        lexical: hit.lexical
      };
    }
    return { ...insert, reason: "model-unavailable", lexical: hit.lexical };
  }

  let relation: Relation | null = null;
  try {
    relation = await input.relation(old.text, input.text);
  } catch (err) {
    // Fail-open, but no longer silent (P5, ADR-0047 / ADR-0041 amendment): a judge that
    // was asked and could not answer is a different fact from a judge nobody configured.
    // The failure is counted on stderr and tagged, and it never mints a conflict marker —
    // a failed call admits nothing about the pair except that it could not be read.
    judgeFailures += 1;
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[reconcile] relation judge failed (${judgeFailures} this process): ${message}\n`);
    return { ...insert, reason: "judge-failed", tags: appendTag(tags, JUDGE_FAILED_TAG), lexical: hit.lexical };
  }
  if (relation === "duplicate") {
    return { action: "reinforce", reason: "model-duplicate", oldId: old.id, text: old.text, tags, lexical: hit.lexical };
  }
  if (relation === "refines") return supersede("model-refines");
  if (relation === "contradicts") return supersede("model-contradicts");
  return { ...insert, reason: "model-unrelated", lexical: hit.lexical };
}
