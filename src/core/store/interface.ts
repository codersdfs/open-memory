import type { KnowledgeEdge, Memory, MemoryInput } from "../types.js";

export type { KnowledgeEdge };

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
 * third-party store keeps compiling. Files stay the truth; these four operations
 * are the only things the index needs from a store.
 */
export interface KnowledgeCapability {
  /** Live rows of one page, ordered by section key. */
  listByKnowledge(knowledgeId: string): Promise<Memory[]>;
  /** Every page id the index currently holds a live row for. */
  listKnowledgeIds(): Promise<string[]>;
  /** Replace one page's outgoing links in one transaction. */
  replaceLinks(from: string, edges: KnowledgeEdge[]): Promise<void>;
  /** Outgoing links of one page, or every edge when `from` is omitted. */
  links(from?: string): Promise<KnowledgeEdge[]>;
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
   */
  updateMeta(id: string, patch: {
    status?: string;
    pin?: number;
    visibility?: string;
    isDeleted?: number;
    tags?: string[];
    knowledgeId?: string | null;
    knowledgeSection?: string | null;
  }): Promise<Memory | null>;
  supersede(oldId: string, newInput: MemoryInput, newEmbedding: number[]): Promise<Memory>;
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
   * little stronger and its use clock reset. One UPDATE, no read-modify-write
   * race between the agents sharing this store.
   */
  reinforce(ids: string[]): Promise<number>;
  prune(opts: { olderThanMs: number; maxImportance: number; type?: string; kind?: string }): Promise<number>;

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
   * Knowledge index (ADR-0023). Optional: the capability arrived in v0.7 and a
   * v0.6 store must keep compiling. `MemoryService.syncKnowledge` reports the
   * missing capability instead of writing rows no one can link.
   */
  knowledge?: KnowledgeCapability;
  // for budget/BM25 we need raw access; list already covers
}
