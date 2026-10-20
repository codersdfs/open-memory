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
import { normalizeProject, resolveProject } from "./project.js";
import { deriveKind, KIND_IMPORTANCE } from "./write/kind.js";
import { assembleBrief } from "./retrieval/brief.js";
import { neighborsOf, knowledgeIndex, knowledgePages, type KnowledgeIndexView, type KnowledgePageView } from "./knowledge/view.js";
import { syncKnowledge, type SyncKnowledgeOptions, type SyncKnowledgeReport } from "./knowledge/sync.js";
import type { BriefOptions, BriefResult } from "./types.js";
import { reconcile, DEFAULT_THRESHOLDS, type Decision, type RelationJudge } from "./write/reconciler.js";
import { jevEnabled, jevRelation, DEFAULT_RELATION_MARGIN } from "./judgment/judge.js";

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
  /** Injected in tests; otherwise the jev judge is used when one is configured. */
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
    // ADR-0020/0021. An explicit `project` (including explicit null) wins; otherwise
    // the project is whatever repository this process is running in, so an agent that
    // knows nothing about projects still files its writes under one. Kind is derived
    // the same way, and an explicit kind also supplies the importance nobody gave.
    const project = input.project !== undefined
      ? normalizeProject(input.project)
      : resolveProject().project;
    const kind = deriveKind(input.text, { explicit: input.kind, type: input.type });
    const importance = input.importance ?? (input.kind ? KIND_IMPORTANCE[kind] : undefined);
    const target: MemoryInput = {
      namespace,
      project,
      kind,
      type: input.type,
      text: input.text,
      importance,
      strength: input.strength,
      source: input.source,
      tags: input.tags,
      supersedesId: input.supersedesId ?? null,
      visibility: input.visibility,
      status: input.status,
      pin: input.pin
    };
    const embedding = await this.embedder.embed(target.text, { inputType: "passage" });

    // Case-insensitive: a rollback typed as OFF is a rollback, not a silent no-op.
    if ((env.MEMORY_RECONCILE ?? "").trim().toLowerCase() === "off") {
      const existing = await this.store.vectorSearch({
        namespace,
        project: target.project,
        // ADR-0023: an ordinary write never reconciles into a knowledge row. A chat
        // sentence that happens to match a page's section must not reinforce it away,
        // because the section's text belongs to the file.
        knowledge: null,
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
      // Reconcile stays inside one project: the same sentence filed under two
      // repositories is two facts with two lifetimes, and reinforcing one into the
      // other would delete the loser from the brief of the project that needed it.
      project: target.project,
      // Same reason as the dedup path above: knowledge rows are out of reach here.
      knowledge: null,
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
      relation: this.relationJudge(),
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
      // The row can only vanish under a concurrent writer. Inserting the write is the
      // only honest outcome; `supersede` would throw and lose the whole save.
      if (old) {
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
      // A model decision that deleted a row is the one event a user cannot reconstruct
      // from the store afterwards, so it leaves a line behind.
      if (decision.reason.startsWith("model-")) {
        console.warn(`[reconcile] superseded ${decision.oldId} (${decision.reason}) -> ${memory.id}`);
      }
      return { memory, decision };
      }
    }

    const memory = await this.store.insert({ ...target, tags: decision.tags }, embedding);
    return {
      memory,
      // A decision that named an action this service could not carry out keeps its
      // reason: reporting "no-neighbour" after a vanished row hides what happened.
      decision: decision.action === "insert" ? decision : { ...decision, action: "insert", oldId: undefined }
    };
  }

  /**
   * The relation judge for this call.
   *
   * Injected judges win (tests). Otherwise jev answers, and only when a judge is actually
   * configured: no key means no call, not a call that fails. The margin is read per call
   * so a value saved in the console applies to the next write without a restart.
   */
  private relationJudge(): RelationJudge | undefined {
    if (this.relation) return this.relation;
    if (!jevEnabled()) return undefined;
    return (oldText: string, newText: string) =>
      jevRelation(oldText, newText, {
        margin: envNumber(runtimeEnv().MEMORY_RECONCILE_MARGIN, DEFAULT_RELATION_MARGIN)
      })
        .then((r) => r?.relation ?? null)
        .catch(() => null);
  }

  /** The old entry point, unchanged for every existing caller: the memory, no decision. */
  async save(input: SaveInput): Promise<Memory> {
    return (await this.saveDetailed(input)).memory;
  }

  /**
   * Bulk save for imports and replayed history (ADR-0018).
   *
   * `reconcile` defaults to **off** here, unlike `save`. Write-time reconcile runs a
   * 5-neighbour vector search per write to decide insert/reinforce/supersede; doing
   * that for 10k rows is 10k full scans *plus* 10k commits, which is quadratic in
   * everything that matters. A bulk import is new material by definition — the
   * caller that is replaying something it already stored can turn reconcile back on
   * explicitly. Embeddings go through `embedBatch` where the provider offers one, so
   * a remote embedder costs one round trip instead of one per row.
   */
  async saveMany(
    inputs: SaveInput[],
    opts: { reconcile?: boolean } = {}
  ): Promise<{ memories: Memory[]; skipped: number }> {
    if (inputs.length === 0) return { memories: [], skipped: 0 };
    if (opts.reconcile) {
      const memories: Memory[] = [];
      for (const input of inputs) memories.push((await this.saveDetailed(input)).memory);
      return { memories, skipped: 0 };
    }
    const targets = inputs.map((input) => {
      const namespace = input.namespace?.trim()
        ? input.namespace
        : resolveWriteKey({ agent: input.agent, user: input.user, scope: input.scope });
      const project = input.project !== undefined
        ? normalizeProject(input.project)
        : resolveProject().project;
      const kind = deriveKind(input.text, { explicit: input.kind, type: input.type });
      const target: MemoryInput = {
        namespace,
        project,
        kind,
        type: input.type,
        text: input.text,
        importance: input.importance ?? (input.kind ? KIND_IMPORTANCE[kind] : undefined),
        strength: input.strength,
        source: input.source,
        tags: input.tags,
        supersedesId: input.supersedesId ?? null,
        visibility: input.visibility,
        status: input.status,
        pin: input.pin
      };
      return target;
    });
    const embeddings = await this.embedder.embedBatch(
      targets.map((t) => t.text),
      { inputType: "passage" }
    );
    const items = targets.map((input, i) => ({ input, embedding: embeddings[i] }));
    if (this.store.insertMany) {
      return { memories: await this.store.insertMany(items), skipped: 0 };
    }
    const memories: Memory[] = [];
    for (const it of items) memories.push(await this.store.insert(it.input, it.embedding));
    return { memories, skipped: 0 };
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

  async list(opts: { namespace: string; type?: string; project?: string | null; kind?: string; includeDeleted?: boolean; status?: string; includeArchived?: boolean; includeDraft?: boolean; limit?: number; offset?: number; query?: string }) {
    return this.store.list(opts as never);
  }

  /**
   * Project brief (ADR-0022): what a session should know before it starts, with no
   * query to supply. Partitions resolve like `search` so a shared convention and a
   * private gotcha both show up; `project` defaults to the repository this process
   * is running in, exactly like writes default.
   */
  async brief(opts: BriefOptions = {}): Promise<BriefResult> {
    const namespaces =
      opts.namespaces && opts.namespaces.length > 0
        ? opts.namespaces
        : opts.namespace
          ? [opts.namespace]
          : resolveScopeKeys({ agent: opts.agent, scope: opts.scope ?? undefined });
    const project = opts.project !== undefined ? normalizeProject(opts.project) : resolveProject().project;
    return assembleBrief(this.store, { ...opts, project, namespaces });
  }

  async delete(id: string): Promise<void> {
    await this.store.deleteSoft(id);
  }

  /**
   * Knowledge index (ADR-0023): markdown pages become searchable rows, in place.
   *
   * The store has no filesystem access by design, so the sync lives here — it is
   * the one object that owns both the embedder and the store.
   */
  async syncKnowledge(opts: SyncKnowledgeOptions = {}): Promise<SyncKnowledgeReport> {
    return syncKnowledge({ store: this.store, embedder: this.embedder }, opts);
  }

  /** Every knowledge page in the given partitions (default: this user's layers). */
  async knowledge(opts: { namespaces?: string[]; namespace?: string; agent?: string; scope?: MemoryScope } = {}): Promise<KnowledgeIndexView> {
    const namespaces = this.knowledgeNamespaces(opts);
    return knowledgeIndex(this.store, { namespaces });
  }

  async knowledgePage(opts: { namespaces?: string[]; namespace?: string; agent?: string; scope?: MemoryScope } & { id: string }): Promise<KnowledgePageView | null> {
    const pages = await knowledgePages(this.store, { namespaces: this.knowledgeNamespaces(opts) });
    return pages.find((p) => p.id === opts.id) ?? null;
  }

  /** Explicit link expansion. Reading through links is never implicit (ADR-0023). */
  async knowledgeNeighbors(opts: { namespaces?: string[]; namespace?: string; agent?: string; scope?: MemoryScope } & { id: string; depth?: number }): Promise<{ id: string; neighbors: KnowledgePageView[] }> {
    const namespaces = this.knowledgeNamespaces(opts);
    const pages = await knowledgePages(this.store, { namespaces });
    const edges = pages.flatMap((p) => p.links);
    const ids = neighborsOf(edges, opts.id, opts.depth ?? 1);
    return { id: opts.id, neighbors: pages.filter((p) => ids.includes(p.id)) };
  }

  private knowledgeNamespaces(opts: { namespaces?: string[]; namespace?: string; agent?: string; scope?: MemoryScope }): string[] {
    return opts.namespaces && opts.namespaces.length > 0
      ? opts.namespaces
      : opts.namespace
        ? [opts.namespace]
        : resolveScopeKeys({ agent: opts.agent, scope: opts.scope ?? undefined });
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

  /**
   * Extract and store. `referenceDate` is the moment the turn was said, so a replayed
   * old turn stamps "yesterday" onto the right day instead of onto today; callers that
   * have no better answer omit it and get the wall clock.
   */
  async extractAndSave(turnText: string, namespace: string, referenceDate?: number): Promise<Memory[]> {
    const extracted = await this.extractor.extract(turnText, referenceDate ?? Date.now());
    // A replayed turn carries the project of the repository being replayed, not of
    // whatever directory this process happens to sit in.
    const project = resolveProject().project;
    const saved: Memory[] = [];
    for (const ex of extracted) {
      const mem = await this.save({
        namespace,
        project,
        type: ex.type,
        kind: deriveKind(ex.text, { type: ex.type }),
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
