import type { Memory, MemoryInput } from "../types.js";

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
  updateMeta(id: string, patch: { status?: string; pin?: number; visibility?: string; isDeleted?: number }): Promise<Memory | null>;
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
  }): Promise<{ memory: Memory; vectorScore: number }[]>;

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
  }): Promise<{ median: number; count: number }>;
  /**
   * Retrieval reinforcement (R2): every id that came back above threshold gets a
   * little stronger and its use clock reset. One UPDATE, no read-modify-write
   * race between the agents sharing this store.
   */
  reinforce(ids: string[]): Promise<number>;
  prune(opts: { olderThanMs: number; maxImportance: number; type?: string }): Promise<number>;
  // for budget/BM25 we need raw access; list already covers
}
