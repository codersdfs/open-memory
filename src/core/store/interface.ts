import type { ChainView, KnowledgeEdge, Memory, MemoryEvent, MemoryInput, WriteEventMeta } from "../types.js";

export type { ChainView, KnowledgeEdge, MemoryEvent };

/**
 * Lexical candidate hygiene at scale (ADR-0019), shared by both stores so their
 * ranking cannot drift. A word appearing in more than a third of a large store cannot
 * single a row out - its idf is near zero - and summing its postings is the largest
 * single cost of a lexical query. Below 1000 rows both limits are off, which keeps
 * small-store behaviour (and the tests that pin it) exactly as it was.
 */
export const MIN_ROWS_FOR_DF_CAP = 1000;
export const DF_CAP_RATIO = 1 / 3;
export const LEXICAL_TOKEN_LIMIT = 64;
export const LEXICAL_RAREST_K = 8;

/**
 * Below this total df the lexical arm pins its join order (ADR-0033).
 *
 * Pinning makes the query seek the token index and probe `memories` once per posting,
 * which is what stops a marker-word lookup from costing a scan of the partition — at
 * 20k rows a word held by one row went from 8.8 ms to 0.005 ms. Once the chosen words
 * are held by thousands of rows that probe count dominates, and letting the planner
 * walk the partition index once is cheaper (measured at 10k rows / df 2,500: 9.7 ms
 * planner vs 13.2 ms pinned). 2,000 sits between the two measured regimes. Both plans
 * read the same rows, so this is a speed switch and never a correctness one.
 */
export const PINNED_ORDER_DF = 2000;

/**
 * The project/kind slice of a query (ADR-0020, ADR-0021). Both stores implement it
 * identically or a test that passes on one proves nothing about the other:
 *   - `undefined` → do not filter (every project, every kind)
 *   - a slug      → only that project
 *   - `null`      → only rows with no project (the pre-project backlog)
 */
export interface MemoryFilter {
  project?: string | null;
  kind?: string;
  /**
   * Knowledge index slice (ADR-0023). `undefined` → do not filter, a page id →
   * only that page's sections, `null` → only ordinary memories. Writes that go
   * through reconcile pass `null`: a knowledge section is a file's index, and a
   * chat memory must never merge into (or supersede) one.
   */
  knowledge?: string | null;
}

/**
 * Knowledge pages (ADR-0023), optional like the other additions so a v0.6
 * third-party store keeps compiling. Files stay the truth; these operations are
 * the only things the index needs from a store.
 *
 * Knowledge rows are ordinary memories carrying a `knowledge_id` and a
 * `knowledge_section`, so the page tree is a projection of the memories table
 * rather than a second copy of it.
 */
export interface KnowledgeCapability {
  /** Live rows of one page, ordered by section key. */
  listByKnowledge(knowledgeId: string): Promise<Memory[]>;
  /** Every page id the index currently holds a live row for. */
  listKnowledgeIds(namespace?: string): Promise<string[]>;
  /**
   * Live knowledge rows of these partitions, page ids and section keys only.
   *
   * ADR-0030: `list` returns ordinary memories too, so a vault of 1,000 rows living
   * in a partition of 21,000 made the knowledge index read and decode twenty rows
   * for every one it kept — 388 ms, and memory proportional to the chat history
   * rather than to the vault. Optional so a store that cannot filter by page keeps
   * compiling; the caller falls back to `list`.
   */
  listKnowledge?(namespaces: string[]): Promise<Memory[]>;
  /** Replace one page's outgoing links in one transaction. */
  replaceLinks(from: string, edges: KnowledgeEdge[]): Promise<void>;
  /** Outgoing links of one page, or every edge when `from` is omitted. */
  links(from?: string): Promise<KnowledgeEdge[]>;
}

/**
 * One project's footprint in the store (ADR-0020), as management reads it.
 *
 * Derived from the `project` column, never stored twice: a project exists because
 * rows carry it, so a summary is a GROUP BY, not a registry row. `project` is null
 * for the unscoped backlog — callers render that as "(unscoped)", the same key
 * `stats.byProject` uses.
 */
export interface ProjectSummary {
  project: string | null;
  /**
   * Rows a read can actually hand out: `status = 'active' AND is_deleted = 0`, the
   * same population `list()` shows by default and the brief reads. Archived rows and
   * tombstones belong to audit (stats and `--includeDeleted` see them); a project
   * whose rows are all archived honestly reads as empty here.
   */
  rows: number;
  byKind: Record<string, number>;
  /** MAX(created_at) over those rows; 0 when the project holds none. */
  lastActivityAt: number;
}

export interface VectorStore {
  init(): Promise<void>;

  /**
   * Dimension of the vectors already in this store, or null when it is empty.
   *
   * Vector dimensions are load-bearing (the column holds raw JSON), so a provider
   * swap has to be caught before the first search rather than returning cosine
   * noise. `null` means "nothing written yet — any provider is fine".
   */
  storedDim(): Promise<number | null>;
  close(): void;
  insert(input: MemoryInput, embedding: number[]): Promise<Memory>;
  /**
   * Bulk insert in one transaction. Importing a project's history is thousands of
   * writes; one commit each is what made bulk ingest cost as much in fsync as in
   * parsing. Optional like the rest: a third-party store keeps compiling and
   * `MemoryService.saveMany` falls back to a loop.
   */
  insertMany?(items: { input: MemoryInput; embedding: number[] }[]): Promise<Memory[]>;
  /**
   * Which of these `textHash` values already have a READABLE LIVE row in one
   * partition — the same population `list()` shows by default: not tombstoned, not
   * archived, not draft (ADR-0018 amendment 2026-11-07). A row outside that default
   * population is what no ordinary search can return, so it must not block a
   * re-import either; `project`/`type` scope the fold to the partition `reconcile`
   * reads over, so one project's copy of a sentence never folds away another's
   * (ADR-0020).
   *
   * Optional like the rest: a third-party store written before it keeps compiling,
   * and `saveMany` then inserts every survivor as if it were new — it cannot know
   * otherwise, and losing an import to an unknown store would be the worse error.
   */
  findExistingHashes?(opts: {
    namespace: string;
    hashes: string[];
    project?: string | null;
    type?: string;
  }): Promise<Set<string>>;
  getById(id: string): Promise<Memory | null>;
  list(opts: {
    namespace: string;
    type?: string;
    includeDeleted?: boolean;
    status?: string;
    includeArchived?: boolean;
    includeDraft?: boolean;
    limit?: number;
    offset?: number;
    query?: string;
    project?: string | null;
    kind?: string;
    knowledge?: string | null;
    /**
     * Skip the vector join. The knowledge index reads thousands of rows to build a
     * page tree and never looks at an embedding; attaching them is about 150 MB of
     * copying at 10^5 rows. Optional and defaulting to `true` so a third-party store
     * that predates it keeps behaving exactly as before.
     */
    withVectors?: boolean;
  }): Promise<{ memories: Memory[]; total: number }>;
  /**
   * Every partition holding at least one live memory. 
   *
   * A caller cannot guess these names, and guessing is exactly what made the CLI
   * report an empty search for data that was sitting in a partition nobody named.
   */
  distinctNamespaces(opts?: { includeDeleted?: boolean }): Promise<string[]>;
  deleteSoft(id: string): Promise<void>;
  updateEmbedding(id: string, embedding: number[], text: string): Promise<void>;
  /**
   * Patch the mutable metadata. `tags` and the knowledge columns are here because
   * a knowledge sync has to relabel an adopted pre-v0.7 row without re-embedding
   * it (ADR-0023) — the alternative was a second nearly identical method.
   * `importance` is here because retroactive curation demotes a stock row's rank
   * without re-judging it (ADR-0040 amendment 2026-11-08, `ai-memory triage`):
   * the write-time ladder owns the value, triage only sinks an existing one.
   */
  updateMeta(id: string, patch: {
    status?: string;
    pin?: number;
    visibility?: string;
    isDeleted?: number;
    importance?: number;
    tags?: string[];
    knowledgeId?: string | null;
    knowledgeSection?: string | null;
  }, meta?: WriteEventMeta): Promise<Memory | null>;
  /**
   * Retire `oldId` and store `newInput` in its place. `meta` is what the history row
   * records about the decision (P6, ADR-0045): the reconcile reason and the judge
   * that made the call. The invalidation (`is_deleted = 1`, `invalid_at = now`) and
   * the supersede event land in one transaction with the successor's insert.
   */
  supersede(oldId: string, newInput: MemoryInput, newEmbedding: number[], meta?: WriteEventMeta): Promise<Memory>;
  // brute-force vector scan over namespace partition
  vectorSearch(opts: {
    namespace: string;
    queryEmbedding: number[];
    type?: string;
    limit: number;
    includeDeleted?: boolean;
    status?: string;
    includeArchived?: boolean;
    includeDraft?: boolean;
    project?: string | null;
    kind?: string;
    knowledge?: string | null;
  }): Promise<{ memory: Memory; vectorScore: number }[]>;

  /**
   * Lexical candidates: rows in one partition that share at least one query
   * token, best overlap first, capped at `limit`.
   *
   * Exists because `vectorSearch` can only rank what the embedder already likes.
   * Measured on a 295-row store: 32.5% of known targets sat outside the vector
   * top-20, and recall@5 was exactly P(target inside the vector top-20) — the
   * candidate set, not the scoring, was the ceiling. Serving this from an
   * inverted index (token, memory_id) means it never parses an embedding, so it
   * is affordable on every search rather than only on the slow path.
   *
   * Optional on purpose: `VectorStore` is exported for third-party stores, and a
   * store written against v0.3 must keep compiling. A store without it degrades
   * to the v0.3 candidate set (vector-only), which is exactly the A/B arm the
   * v0.4 measurements compare against.
   */
  lexicalCandidates?(opts: {
    namespace: string;
    query: string;
    limit: number;
    type?: string;
    includeDeleted?: boolean;
    status?: string;
    includeArchived?: boolean;
    includeDraft?: boolean;
    project?: string | null;
    kind?: string;
    knowledge?: string | null;
  }): Promise<{ memory: Memory; lexicalScore: number }[]>;

  /**
   * Document frequency of each token in this partition's live rows, from the
   * inverted index's own df table (ADR-0019 maintains it in the write
   * transaction). Feeds the idf-weighted coverage (ADR-0028): a query word held
   * by every row must not count toward coverage the same way a word two rows
   * hold. Tokens the partition has never seen are absent from the returned map —
   * that is information, not an error. Optional like `lexicalCandidates`: a
   * third-party store without it keeps compiling, and the retriever falls back
   * to the df of its own candidate set, which is a coarser estimate of the same
   * quantity.
   */
  termDf?(tokens: string[]): Promise<Map<string, number>>;

  /**
   * How this query's cosines are distributed across one partition.
   *
   * A top-1 cosine cannot say whether a match is real: measured on a 53-row corpus,
   * unrelated queries reached 0.120 / 0.147 / 0.256 while genuine paraphrases sat at
   * 0.271 and 0.304 — overlapping ranges. A *relative* number can: the noise never led
   * its partition by more than 0.176 over the median, while four of six paraphrases led
   * by 0.231-0.345. Full scan on purpose: the median of the over-fetched top-N is not
   * the partition's median, and that difference is the whole measurement.
   */
  cosineSpread(opts: {
    namespace: string;
    queryEmbedding: number[];
    type?: string;
    includeDeleted?: boolean;
    status?: string;
    includeArchived?: boolean;
    includeDraft?: boolean;
    project?: string | null;
    kind?: string;
    knowledge?: string | null;
  }): Promise<{ median: number; count: number }>;
  /**
   * Retrieval reinforcement (R2): every id that came back above threshold gets a
   * little stronger, its use clock reset, and — since the P2 hotness rule (ADR-0016
   * amendment) — its `useCount` incremented. One UPDATE, no read-modify-write
   * race between the agents sharing this store.
   */
  reinforce(ids: string[]): Promise<number>;
  prune(opts: { olderThanMs: number; maxImportance: number; type?: string; kind?: string }): Promise<number>;

  /**
   * Store-level KV bookkeeping (P2, ADR-0016 amendment 2026-11-07): today only the
   * maintenance scheduler's `last_maintenance_at` and its report — the file's own
   * history, not any memory's, which is why it is a KV table and not a column.
   * Optional like every late capability: a store that predates it keeps compiling,
   * and the scheduler then runs on the timer alone, with no open-the-store-catch-up
   * to lose (it cannot know it is overdue), and `/stats` shows the absence.
   */
  getMeta?(key: string): Promise<string | null>;
  setMeta?(key: string, value: string): Promise<void>;

  /**
   * Reclaim file space. `prune` is a soft delete: the row, its postings and its
   * vector stay on disk until the file is rewritten, and `purgeDeleted` removes the
   * tombstones but leaves their pages on SQLite's freelist. Optional because a store
   * with no file to rewrite (`InMemoryVectorStore`, a third-party store) has nothing
   * to compact, and reporting a fake saving would be worse than not offering it.
   */
  compact?(): Promise<{ bytesBefore: number; bytesAfter: number }>;

  /**
   * Hard-delete tombstones older than `olderThanMs`. The other half of soft delete:
   * audit keeps the row, and nothing else ever removes it, so the store only grows.
   * Separate from `prune` because `prune` has to stay reversible and this must not.
   * Optional in the same way `insertMany` is: a v0.3 store still compiles.
   */
  purgeDeleted?(opts: { olderThanMs: number }): Promise<number>;

  /**
   * The write history of one memory (P6, ADR-0045): the append-only `memory_events`
   * rows for that id, oldest first. Events survive the row itself — `purgeDeleted`
   * removes the memory and never its history, so a purged id still answers with the
   * story of what happened to it. Optional like every late capability: a third-party
   * store written before it keeps compiling, and `MemoryService.drill` then reports
   * the chain without the events instead of pretending there were none.
   */
  history?(id: string): Promise<MemoryEvent[]>;

  /**
   * The live rows whose `supersedes_id` names this id — the forward half of the
   * chain. Tombstones included on purpose: the rows that superseded this one are
   * themselves retired the moment something supersedes them, so an includeDeleted
   * filter would cut the chain off one hop in. Optional: without it, `drill` falls
   * back to paging the partition and filtering (correct at any size, only slow —
   * the same trade `listProjects` accepts).
   */
  successorsOf?(id: string): Promise<Memory[]>;
  /**
   * Knowledge index (ADR-0023). Optional: the capability arrived in v0.7 and a
   * v0.6 store must keep compiling. `MemoryService.syncKnowledge` reports the
   * missing capability instead of writing rows no one can link.
   */
  knowledge?: KnowledgeCapability;

  /**
   * Project management (ADR-0042), optional like every other late capability so a
   * store written against an earlier version keeps compiling. The operations are
   * bulk statements over the `project` column — the dimension ADR-0020 added — and
   * never touch namespaces: a project spans every partition that wrote into it.
   * `MemoryService` falls back to a per-partition sweep for `listProjects` when a
   * store lacks it; rename and forget have no row-wise fallback, so the service
   * reports the missing capability instead of pretending.
   */
  listProjects?(): Promise<ProjectSummary[]>;
  /**
   * Move every row of one project to another slug, tombstones included — they are
   * that project's audit trail. Deliberately does not touch `updated_at`: a rename
   * rewrites identity, not content, and bumping the column would reset the clock
   * `purgeDeleted` judges tombstones by.
   */
  renameProject?(from: string, to: string): Promise<number>;
  /**
   * `delete` soft-deletes the project's live rows (restorable row by row); `detach`
   * unscopes them (`project = NULL`), which is how rows survive the project they
   * were filed under.
   */
  forgetProject?(slug: string, opts: { mode: "detach" | "delete" }): Promise<{ detached: number; deleted: number }>;
  // for budget/BM25 we need raw access; list already covers
}
