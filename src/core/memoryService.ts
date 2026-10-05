import "../config.js";
import type { EmbeddingProvider } from "./embedding/provider.js";
import { createEmbeddingProvider } from "./embedding/index.js";
import type { VectorStore } from "./store/interface.js";
import { HybridRetriever } from "./retrieval/hybrid.js";
import type { Memory, MemoryInput, SearchOptions, SearchResult } from "./types.js";
import { Extractor } from "./extraction/extractor.js";
import { InMemoryVectorStore } from "./store/memory.js";
import { resolveDbPath } from "./dbPath.js";
import { resolveScopeKeys, resolveWriteKey, type MemoryScope } from "./scope.js";

export class MemoryService {
  public store: VectorStore;
  public embedder: EmbeddingProvider;
  public retriever: HybridRetriever;
  public extractor: Extractor;
  private dedupThreshold: number;
  private dbPath?: string;

  constructor(opts?: { store?: VectorStore; embedder?: EmbeddingProvider; dbPath?: string; dedupThreshold?: number }) {
    this.dbPath = resolveDbPath(opts?.dbPath);
    // store is injected for tests (InMemory) — otherwise lazy-created in init() to avoid static node:sqlite import
    if (opts?.store) {
      this.store = opts.store;
    } else {
      this.store = new InMemoryVectorStore();
      (this as unknown as { _needsSqlite: boolean })._needsSqlite = true;
    }
    this.embedder = opts?.embedder ?? createEmbeddingProvider();
    this.retriever = new HybridRetriever(this.store, this.embedder);
    this.extractor = new Extractor();
    this.dedupThreshold = opts?.dedupThreshold ?? 0.92;
  }

  async init(): Promise<void> {
    const needsSqlite = (this as unknown as { _needsSqlite?: boolean })._needsSqlite;
    if (needsSqlite) {
      // lazy-load sqlite store only in production path (not tests)
      const mod = await import(/* @vite-ignore */ "./store/sqlite.js");
      const sqliteStore = new mod.SqliteVectorStore(this.dbPath);
      this.store = sqliteStore;
      // rewire retriever to use real store
      (this.retriever as unknown as { store: VectorStore }).store = sqliteStore;
    }
    await this.store.init();
  }
  close(): void {
    this.store.close();
  }

  /**
   * Save one memory.
   *
   * `input.namespace` is still the whole story when supplied. Otherwise `scope`
   * decides the layer: `shared` → `shared:<user>`, `private` (default) →
   * `<agent>:<user>`. Dedup deliberately compares inside one partition only, so the
   * same sentence may legitimately exist as a private note and a shared fact.
   */
  async save(input: Omit<MemoryInput, "namespace" | "scope"> & { namespace?: string; agent?: string; user?: string; scope?: MemoryScope }): Promise<Memory> {
    const namespace = input.namespace?.trim()
      ? input.namespace
      : resolveWriteKey({ agent: input.agent, user: input.user, scope: input.scope });
    const target: MemoryInput = { ...input, namespace };
    const embedding = await this.embedder.embed(target.text, { inputType: "passage" });
    const existing = await this.store.vectorSearch({
      namespace,
      queryEmbedding: embedding,
      type: target.type,
      limit: 5,
      includeDeleted: false
    });
    for (const { memory, vectorScore } of existing) {
      if (vectorScore > this.dedupThreshold && memory.text.trim().toLowerCase() === target.text.trim().toLowerCase()) {
        return memory;
      }
    }
    return this.store.insert(target, embedding);
  }

  async get(id: string): Promise<Memory | null> {
    return this.store.getById(id);
  }

  /**
   * Like `get`, but a soft-deleted memory counts as absent.
   *
   * `get` deliberately sees tombstones so `restore` can revive them; anything that
   * answers an agent must use this instead, or a "forgotten" fact would keep being
   * served back to the model.
   */
  async getActive(id: string): Promise<Memory | null> {
    const memory = await this.store.getById(id);
    return memory && memory.isDeleted !== 1 ? memory : null;
  }

  async list(opts: { namespace: string; type?: string; includeDeleted?: boolean; status?: string; includeArchived?: boolean; includeDraft?: boolean; limit?: number; offset?: number; query?: string }) {
    return this.store.list(opts as never);
  }

  async delete(id: string): Promise<void> {
    await this.store.deleteSoft(id);
  }

  async updateMeta(
    id: string,
    patch: { status?: string; pin?: number; visibility?: string; isDeleted?: number }
  ): Promise<Memory | null> {
    return this.store.updateMeta(id, patch);
  }

  async supersede(oldId: string, newInput: MemoryInput): Promise<Memory> {
    const embedding = await this.embedder.embed(newInput.text, { inputType: "passage" });
    return this.store.supersede(oldId, newInput, embedding);
  }

  /**
   * Search. Partitions resolve in this order: explicit `namespaces` → explicit
   * `namespace` → `agent`/`scope` (private layer first, then shared). An explicit
   * `namespace` therefore still means "exactly that partition", unchanged.
   */
  async search(opts: SearchOptions): Promise<SearchResult> {
    const namespaces =
      opts.namespaces && opts.namespaces.length > 0
        ? opts.namespaces
        : opts.namespace
          ? [opts.namespace]
          : resolveScopeKeys({ agent: opts.agent, scope: opts.scope ?? undefined });
    return this.retriever.search({ ...opts, namespaces });
  }

  async extractAndSave(turnText: string, namespace: string): Promise<Memory[]> {
    const extracted = await this.extractor.extract(turnText);
    const saved: Memory[] = [];
    for (const ex of extracted) {
      const mem = await this.save({
        namespace,
        type: ex.type,
        text: ex.text,
        importance: ex.importance,
        tags: ex.tags,
        source: "extractor"
      });
      saved.push(mem);
    }
    return saved;
  }
}
