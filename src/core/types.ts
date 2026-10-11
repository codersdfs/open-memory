export const TYPES = ["episodic", "semantic", "procedural", "working"] as const;
export const STATUSES = ["active", "archived", "draft", "superseded"] as const;
export type MemoryType = (typeof TYPES)[number];
/** Which layer a partition belongs to: an agent's own notes, or the cross-agent one. */
export type MemoryScope = "private" | "shared";
export type MemoryVisibility = "private";
export type MemoryStatus = (typeof STATUSES)[number];

export interface Namespace {
  agentId: string;
  userId: string;
}

export function namespaceKey(ns: Namespace): string {
  return `${ns.agentId}:${ns.userId}`;
}

export function parseNamespaceKey(key: string): Namespace {
  const [agentId, userId] = key.split(":");
  return { agentId: agentId ?? "default", userId: userId ?? "default" };
}

export interface Memory {
  id: string;
  namespace: string; // namespaceKey
  type: MemoryType;
  text: string;
  embedding: number[];
  importance: number; // 0-1 — what the write-time judge thought
  /**
   * 0-1 — what use has proven. Starts equal to `importance` and grows on
   * retrieval (R2). Retrieval weights this, decay prunes on it, and the judge
   * keeps owning `importance` — otherwise "the model thought this mattered" and
   * "this keeps answering questions" compete for one number and neither is true.
   */
  strength: number;
  /** Epoch ms of the last above-threshold retrieval. null = never used. */
  lastUsedAt: number | null;
  source?: string;
  tags?: string[];
  supersedesId?: string | null;
  isDeleted: number; // 0/1
  visibility: MemoryVisibility; // always 'private' for solo (ADR-0006)
  status: MemoryStatus; // governance-lite
  pin: number; // 0/1 — pinned memories rank first
  createdAt: number; // epoch ms
  updatedAt: number;
}

export interface MemoryInput {
  namespace: string;
  type: MemoryType;
  text: string;
  importance?: number;
  /** Defaults to `importance` when omitted. */
  strength?: number;
  source?: string;
  tags?: string[];
  supersedesId?: string | null;
  visibility?: MemoryVisibility;
  status?: MemoryStatus;
  pin?: number;
}

export interface SearchOptions {
  query: string;
  /**
   * Single partition. Kept for backward compatibility. Optional now because a
   * caller may instead pass `agent`/`scope` and let `MemoryService.search` resolve
   * the partitions (ADR-0007).
   */
  namespace?: string;
  /**
   * Multi-partition search (cross-agent scope layering, ADR-0007). When present
   * this wins over `namespace`, the partitions are searched independently and the
   * merged candidate set goes through MMR + the hard budget exactly once.
   */
  namespaces?: string[];
  /** Agent that asked. Additive: used for result stamping and scope resolution by callers. */
  agent?: string;
  /** Which layer to read when no explicit partition is given. */
  scope?: MemoryScope | null;
  type?: MemoryType;
  k?: number;
  budgetTokens?: number;
  threshold?: number;
  includeDeleted?: boolean;
  status?: MemoryStatus;
  includeArchived?: boolean;
  includeDraft?: boolean;
  /** Attach a per-term score breakdown to every returned memory (R1). */
  explain?: boolean;
}

export interface SearchResultItem extends Memory {
  /** Present only when the caller asked for `explain` (R1). */
  explain?: ScoreBreakdown;
  score: number;
  vectorScore: number;
  bm25Score: number;
  recencyScore: number;
  tokens: number;
}

/**
 * Where a result's score came from (R1). Four extra numbers per hit is real
 * payload on a response whose whole point is a token budget, so this is opt-in.
 */
export interface ScoreBreakdown {
  vector: number;
  bm25: number;
  recency: number;
  strength: number;
  pinBoost: number;
  weighted: { vector: number; bm25: number; recency: number; strength: number };
  final: number;
}

/**
 * Drop the vector from a memory on its way out.
 *
 * A 384-float embedding is ~9 kB of a response whose point is text and a score, and
 * both consumers inside this repo already discard it — the MCP tools and the CLI strip
 * it after receipt, so this only ever removed wasted bytes on the wire. It lives here
 * because three layers need the same three lines, and a fourth copy is how they drift.
 */
export function stripEmbedding<T extends { embedding?: unknown }>(memory: T): Omit<T, "embedding"> {
  const { embedding: _drop, ...rest } = memory;
  return rest;
}

export interface SearchResult {
  memories: SearchResultItem[];
  tokensUsed: number;
  truncated: boolean;
  summary: string | null;
  /** Additive (ADR-0007): which agent asked and which partitions were actually searched. */
  agent?: string;
  scopes?: string[];
}
