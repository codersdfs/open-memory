export const TYPES = ["episodic", "semantic", "procedural", "working"] as const;
/**
 * Every status the CLI, the console and the API may offer. The store's CHECK constraint
 * holds the same set. `superseded` used to sit here while the schema rejected it, so the
 * console dropdown and `meta --status superseded` both failed at the row instead of
 * storing it. A supersede is a link (`supersedesId`), not a status.
 */
export const STATUSES = ["active", "archived", "draft"] as const;
/**
 * Why a memory should survive (ADR-0021). `type` says what shape a memory has;
 * `kind` says what job it does in a long-lived project, which is the question
 * decay and the project brief actually ask. `decision`, `convention` and
 * `gotcha` are durable by contract: losing one of them silently costs the next
 * session the same discovery again, so decay never archives them.
 */
export const KINDS = ["decision", "convention", "gotcha", "fact", "task", "note"] as const;
export type MemoryKind = (typeof KINDS)[number];

export function isKind(v: unknown): v is MemoryKind {
  return typeof v === "string" && (KINDS as readonly string[]).includes(v);
}
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
  /**
   * What long-lived effort this memory belongs to (ADR-0020), or null for the
   * unscoped rows written before projects existed. A project is a slug derived
   * from the repository root, not a partition: a project's memories still live in
   * the agent partitions that wrote them, so cross-agent recall keeps working.
   */
  project: string | null;
  /** What job this memory does (ADR-0021). Always set: writes derive it. */
  kind: MemoryKind;
  type: MemoryType;
  /**
   * Indexed knowledge page (ADR-0023), or null for an ordinary memory. The page
   * id is the vault-relative path without `.md` (frontmatter `slug:` wins, so a
   * renamed file keeps its rows). Knowledge pages live as markdown; the rows are
   * only the index that makes them retrievable.
   */
  knowledgeId: string | null;
  /** Section key inside that page (`how-tokens-work`), null for ordinary rows. */
  knowledgeSection: string | null;
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
  /** Defaults to the project resolved from the environment / git root. */
  project?: string | null;
  /** Defaults to the kind derived from the text. */
  kind?: MemoryKind;
  /** Knowledge page this row indexes (ADR-0023); null/omitted = ordinary memory. */
  knowledgeId?: string | null;
  knowledgeSection?: string | null;
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
  /** Narrow to one project slug (ADR-0020). omit = every project. */
  project?: string | null;
  /** Narrow to one kind (ADR-0021). */
  kind?: MemoryKind;
  /**
   * Narrow to the knowledge index (ADR-0023). Omitted = every row, `null` = only
   * ordinary memories (never a knowledge section), a page id = only that page.
   */
  knowledge?: string | null;
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

/**
 * The project brief (ADR-0022). A search needs a query; a session start does not
 * have one. The brief is the deterministic answer to "what should I know about
 * this repository before I touch it": the standing conventions, the decisions
 * already made (newest wins), the traps that cost someone a day, and what was
 * open when the last session ended — assembled from the store, no model call.
 */
export const BRIEF_SECTIONS = ["conventions", "decisions", "gotchas", "open", "recent"] as const;
export type BriefSectionName = (typeof BRIEF_SECTIONS)[number];

export interface BriefOptions {
  /** Project slug; defaults to the resolved project for this process. */
  project?: string | null;
  agent?: string;
  user?: string;
  scope?: MemoryScope | null;
  /** Explicit partitions (tests, importers). Wins over agent/scope resolution. */
  namespaces?: string[];
  /** One partition, exactly — same precedence as in `SearchOptions`. */
  namespace?: string;
  budgetTokens?: number;
  /** How far back the `open` and `recent` sections look. Default 14 days. */
  sinceMs?: number;
  /** Restrict sections, in the fixed order of `BRIEF_SECTIONS`. */
  sections?: BriefSectionName[];
  /** Clock seam for tests. */
  now?: number;
}

export interface BriefItem {
  id: string;
  kind: MemoryKind;
  text: string;
  tokens: number;
  createdAt: number;
  importance: number;
  strength: number;
  namespace: string;
}

export interface BriefSection {
  name: BriefSectionName;
  items: BriefItem[];
  tokens: number;
}

export interface BriefResult {
  project: string | null;
  /** Rendered brief, ready to paste into a prompt. */
  text: string;
  tokensUsed: number;
  budgetTokens: number;
  truncated: boolean;
  sections: BriefSection[];
  counts: Record<BriefSectionName, number>;
  /** Partitions that were read, for the same transparency reason as SearchResult. */
  scopes?: string[];
}

/**
 * One link between knowledge pages (ADR-0023). `to` is null when the target does
 * not resolve (missing page, or two files share its basename): the edge is kept
 * so maintenance debt stays visible instead of silently disappearing.
 */
export interface KnowledgeEdge {
  from: string;
  to: string | null;
  /** The link exactly as written (`[[x|alias]]` → `x|alias`), for editing. */
  target: string;
}
