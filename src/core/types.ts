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
  importance: number; // 0-1
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
}

export interface SearchResultItem extends Memory {
  score: number;
  vectorScore: number;
  bm25Score: number;
  recencyScore: number;
  tokens: number;
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
