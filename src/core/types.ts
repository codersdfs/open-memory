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
  /**
   * How many above-threshold retrievals this row has earned (P2, ADR-0016
   * amendment 2026-11-07). `lastUsedAt` says *when* it was last used and is a
   * binary "used at all" on its own; decay's hotness rule needs the count, since
   * a row recalled once a year and one recalled every day look identical without
   * it. 0 for rows written before the column existed — the migration backfills
   * zeros, so an old store starts scoring from "no evidence" rather than a guess.
   */
  useCount: number;
  source?: string;
  tags?: string[];
  supersedesId?: string | null;
  isDeleted: number; // 0/1
  visibility: MemoryVisibility; // always 'private' for solo (ADR-0006)
  status: MemoryStatus; // governance-lite
  pin: number; // 0/1 — pinned memories rank first
  /**
   * The event-time clock (P6, ADR-0045): epoch ms parsed from the row's own
   * `(at:YYYY-MM-DD)` stamp (ADR-0015) — when the fact became true, as the text
   * states it. `created_at` is when the store learned it; the two differ by however
   * long the agent waited to write. NULL when the text carries no stamp — a column
   * that guessed would be worse than one that admits it does not know.
   */
  validAt: number | null;
  /**
   * The invalidation clock (P6, ADR-0045): epoch ms of the supersede that retired
   * this row, written in the same UPDATE that sets `is_deleted = 1`. A plain forget
   * leaves it NULL — a tombstone means "removed", not "stopped being true".
   */
  invalidAt: number | null;
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
  /**
   * The share of the query's own facets the row holds (P4, ADR-0046) — reported raw
   * here, weighted by `w.entity` in `weighted.entity`. The weight defaults to 0, so
   * the term is always visible and contributes nothing unless a caller turns it up;
   * like coverage it never gates.
   */
  entity: number;
  pinBoost: number;
  weighted: { vector: number; bm25: number; recency: number; strength: number; entity: number };
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
  /**
   * Why this search came back empty (ADR-0037).
   *
   * Populated **only when `memories.length === 0`** — the key is absent otherwise,
   * not merely undefined. The happy path must not pay for it: a response's whole
   * purpose is a token budget, and a caller that got an answer has nothing to
   * explain.
   */
  diagnostics?: SearchDiagnostics;
}

/** How many live rows a searched partition actually holds (ADR-0037). */
export interface SearchPartitionCount {
  namespace: string;
  /** Rows matching the search's own filters (type/status/project/kind), not the whole partition. */
  total: number;
}

/** A candidate the relevance gate rejected, kept so an empty result can explain itself. */
export interface SearchNearMiss {
  text: string;
  /** The number the gate compared against `threshold`. */
  relevance: number;
  bm25: number;
  vector: number;
  coverage: number;
}

/**
 * Why a search came back empty (ADR-0037).
 *
 * Present only when `memories` is empty: the happy path must not pay for it, because
 * a response's whole purpose is a token budget.
 */
export interface SearchDiagnostics {
  /** The threshold that rejected the near misses. */
  threshold: number;
  /** One entry per partition actually searched, in the order searched. */
  partitions: SearchPartitionCount[];
  /** Rejected candidates, best first. Empty when nothing was even a candidate. */
  nearMisses: SearchNearMiss[];
  /**
   * Partitions this read did not cover that the same user still holds rows in
   * (ADR-0039). Same shape as `partitions` — a name and a count — because it is the
   * same question asked about the other side of the boundary.
   *
   * Only rows the search's own filters would have admitted are counted, and only
   * non-empty partitions are listed: "366 rows sit in default:default" is the fact
   * that changes the caller's next move, and an empty partition outside the scope
   * changes nothing. Absent on a store that cannot enumerate partitions.
   */
  outside?: SearchPartitionCount[];
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

/**
 * The four write points that get a history row (P6, ADR-0045). Shape follows mem0's
 * history table (bench/.venv-mem0/.../storage.py:108-119: id/memory_id/old_memory/
 * new_memory/event) — the one thing that file measured is that an append-only log
 * keyed by memory id is enough to answer "what happened to this fact".
 */
export type MemoryEventKind = "insert" | "reinforce" | "supersede" | "archive";

/**
 * One append-only history row. Never updated, never deleted — not even by
 * `purgeDeleted`, whose whole point is removing rows while keeping the story of
 * what happened to them.
 *
 * `oldValue`/`newValue` mean a different thing per event kind, because the four
 * write points change different things:
 *   - `insert`    — old NULL, new = the stored text; `reason` = the row's `source`.
 *   - `reinforce` — both NULL: the text did not change, and the single-UPDATE shape
 *     (no read-modify-write race, ADR-0028's lesson) is worth more than two copies
 *     of an unchanged string. The event itself is the record of the retrieval.
 *   - `supersede` — old = the replaced text, new = the successor's text;
 *     `reason` = the reconcile reason, `model` = the judge that made the call.
 *   - `archive`   — old = the previous status, new = `archived`;
 *     `reason` = the rule that archived (e.g. `decay:hotness`).
 */
export interface MemoryEvent {
  id: number;
  memoryId: string;
  event: MemoryEventKind;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  model: string | null;
  /** Epoch ms — when the write happened, not when anyone read about it. */
  at: number;
}

/**
 * What a caller hands a store write so the history row can name the decision that
 * caused it. Optional everywhere: a caller that does not know says nothing, and the
 * event still lands with the fields it does know.
 */
export interface WriteEventMeta {
  reason?: string | null;
  model?: string | null;
}

/**
 * The full supersede chain of one row, walked only when asked (`?drill=1` /
 * `ai-memory get <id> --history`; ADR-0045). `ancestors` is nearest-first along
 * `supersedesId`, `successors` is breadth-first over the rows that supersede this
 * one, `events` is the origin row's write history. A purged id still answers —
 * `memory` null with whatever events survived it, which is the audit half of P6.
 */
export interface ChainView {
  memory: Memory | null;
  ancestors: Memory[];
  successors: Memory[];
  events: MemoryEvent[];
}
