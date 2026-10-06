import type { Memory, MemoryInput } from "../types.js";

export interface VectorStore {
  init(): Promise<void>;
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
   * Retrieval reinforcement (R2): every id that came back above threshold gets a
   * little stronger and its use clock reset. One UPDATE, no read-modify-write
   * race between the agents sharing this store.
   */
  reinforce(ids: string[]): Promise<number>;
  prune(opts: { olderThanMs: number; maxImportance: number; type?: string }): Promise<number>;
  // for budget/BM25 we need raw access; list already covers
}
