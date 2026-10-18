import "../config.js";
import type { EmbeddingProvider } from "./embedding/provider.js";
import { createEmbeddingProvider } from "./embedding/index.js";
import type { VectorStore } from "./store/interface.js";
import { HybridRetriever } from "./retrieval/hybrid.js";
import type { Memory, MemoryInput, SearchOptions, SearchResult } from "./types.js";
import { Extractor } from "./extraction/extractor.js";
import { InMemoryVectorStore } from "./store/memory.js";
import { resolveDbPath } from "./dbPath.js";
import { runtimeEnv } from "./settings.js";
import { resolveScopeKeys, resolveWriteKey, type MemoryScope } from "./scope.js";
import { reconcile, DEFAULT_THRESHOLDS, type Decision, type RelationJudge } from "./write/reconciler.js";

export type SaveInput = Omit<MemoryInput, "namespace" | "scope"> & { namespace?: string; agent?: string; user?: string; scope?: MemoryScope };

export interface SaveResult {
  memory: Memory;
  decision: Decision;
}

/** A knob that is set but unreadable falls back to the default instead of NaN. */
function envNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export class MemoryService {
  public store: VectorStore;
  public embedder: EmbeddingProvider;
  public retriever: HybridRetriever;
  public extractor: Extractor;
  private dedupThreshold: number;
  private dbPath?: string;
  /** Injected in tests; the jev judge is wired in the next stage. */
  private relation?: RelationJudge;

  constructor(opts?: { store?: VectorStore; embedder?: EmbeddingProvider; dbPath?: string; dedupThreshold?: number; relation?: RelationJudge }) {
    this.dbPath = resolveDbPath(opts?.dbPath);
    // store is injected for tests (InMemory) — otherwise lazy-created in init() to avoid static node:sqlite import
    if (opts?.store) {
      this.store = opts.store;
    } else {
      this.store = new InMemoryVectorStore();
      (this as unknown as { _needsSqlite: boolean })._needsSqlite = true;
    }
    // Merged env, so a `settings.json` applies without a caller knowing it exists.
    this.embedder = opts?.embedder ?? createEmbeddingProvider(runtimeEnv());
    this.retriever = new HybridRetriever(this.store, this.embedder);
    this.extractor = new Extractor();
    this.dedupThreshold = opts?.dedupThreshold ?? 0.92;
    this.relation = opts?.relation;
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
    // Refuse to serve a store whose vectors do not match the embedder. Cosine over
    // mismatched dims throws (or worse, silently compares the first N numbers), so
    // the failure has to land here, where the message can name both dims and the
    // file to move aside — not in a search result that looks merely wrong.
    const stored = await this.store.storedDim();
    if (stored !== null && stored !== this.embedder.dim) {
      throw new Error(
        `embedding dim mismatch: ${this.dbPath ?? "this store"} holds ${stored}-dim vectors, ` +
        `but the ${this.embedder.name} embedder produces ${this.embedder.dim}.\n` +
        `The vector column stores raw JSON, so searching across dimensions returns garbage, not an error.\n` +
        `Fix: run \`ai-memory reembed\` to rewrite every vector with the current provider, ` +
        `or set EMBEDDING_PROVIDER back to what wrote this file, or move it aside and start fresh ` +
        `(e.g. mv ${this.dbPath ?? "memory.db"} ${this.dbPath ?? "memory.db"}.bak).`,
      );
    }
  }
  close(): void {
    this.store.close();
  }

  /**
   * Save one memory and report what it did to the store.
   *
   * `input.namespace` is still the whole story when supplied. Otherwise `scope`
   * decides the layer: `shared` → `shared:<user>`, `private` (default) →
   * `<agent>:<user>`. Reconciling happens inside one partition only, so the same
   * sentence may legitimately exist as a private note and a shared fact.
   *
   * The neighbour query below is the one the old dedup loop already ran: the five
   * nearest rows in this partition and type. It was thrown away after an exact-string
   * compare; `reconcile` is the only thing that changed about it.
   */
  async saveDetailed(input: SaveInput): Promise<SaveResult> {
    const env = runtimeEnv();
    const namespace = input.namespace?.trim()
      ? input.namespace
      : resolveWriteKey({ agent: input.agent, user: input.user, scope: input.scope });
    const target: MemoryInput = {
      namespace,
      type: input.type,
      text: input.text,
      importance: input.importance,
      strength: input.strength,
      source: input.source,
      tags: input.tags,
      supersedesId: input.supersedesId ?? null,
      visibility: input.visibility,
      status: input.status,
      pin: input.pin
    };
    const embedding = await this.embedder.embed(target.text, { inputType: "passage" });

    if (env.MEMORY_RECONCILE === "off") {
      const existing = await this.store.vectorSearch({
        namespace,
        queryEmbedding: embedding,
        type: target.type,
        limit: 5,
        includeDeleted: false
      });
      for (const { memory, vectorScore } of existing) {
        if (vectorScore > this.dedupThreshold && memory.text.trim().toLowerCase() === target.text.trim().toLowerCase()) {
          return {
            memory,
            decision: { action: "reinforce", reason: "disabled", oldId: memory.id, text: memory.text, tags: memory.tags ?? [], lexical: 1 }
          };
        }
      }
      const memory = await this.store.insert(target, embedding);
      return { memory, decision: { action: "insert", reason: "disabled", text: memory.text, tags: memory.tags ?? [], lexical: 0 } };
    }

    const neighbours = await this.store.vectorSearch({
      namespace,
      queryEmbedding: embedding,
      type: target.type,
      limit: 5,
      includeDeleted: false
    });
    const decision = await reconcile({
      text: input.text,
      type: target.type,
      source: input.source,
      callerTags: input.tags,
      neighbours,
      embedderKind: this.embedder.name,
      relation: this.relation,
      thresholds: {
        lexical: envNumber(env.MEMORY_RECONCILE_LEX, DEFAULT_THRESHOLDS.lexical),
        cosine: envNumber(env.MEMORY_RECONCILE_COS, DEFAULT_THRESHOLDS.cosine)
      }
    });

    if (decision.action === "reinforce" && decision.oldId) {
      await this.store.reinforce([decision.oldId]);
      const memory = await this.getActive(decision.oldId);
      if (memory) return { memory, decision };
      // The row vanished between the neighbour query and the reinforce. Store the write
      // rather than report a rule that did not happen.
    }

    if (decision.action === "supersede" && decision.oldId) {
      const old = neighbours.find((n) => n.memory.id === decision.oldId)?.memory;
      // A merge changed the text, so the vector has to be rebuilt: a stored vector that
      // does not describe its own text never matches a query again.
      const storedEmbedding = decision.text === input.text
        ? embedding
        : await this.embedder.embed(decision.text, { inputType: "passage" });
      const memory = await this.store.supersede(decision.oldId, {
        ...target,
        text: decision.text,
        tags: decision.tags,
        importance: Math.max(old?.importance ?? 0, input.importance ?? 0.5)
      }, storedEmbedding);
      return { memory, decision };
    }

    const memory = await this.store.insert({ ...target, tags: decision.tags }, embedding);
    return {
      memory,
      decision: decision.action === "insert" ? decision : { ...decision, action: "insert", oldId: undefined, reason: "no-neighbour" }
    };
  }

  /** The old entry point, unchanged for every existing caller: the memory, no decision. */
  async save(input: SaveInput): Promise<Memory> {
    return (await this.saveDetailed(input)).memory;
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
