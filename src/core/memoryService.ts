import "../config.js";
import type { EmbeddingProvider } from "./embedding/provider.js";
import { createEmbeddingProvider } from "./embedding/index.js";
import type { ProjectSummary, VectorStore } from "./store/interface.js";
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
import { curate, CurationRejected, DEMOTE_IMPORTANCE, DEMOTE_KIND, ADVICE, type CurationVerdict } from "./write/curation.js";
import { jevEnabled, jevRelation, jevWriteGate, writeGateEnabled, importanceFor, WRITE_GATE_MIN, DEFAULT_RELATION_MARGIN } from "./judgment/judge.js";

export type SaveInput = Omit<MemoryInput, "namespace" | "scope"> & { namespace?: string; agent?: string; user?: string; scope?: MemoryScope };

export interface SaveResult {
  memory: Memory;
  decision: Decision;
  /**
   * Present only when curation demoted the write (ADR-0040) — the row carries its
   * `curation:*` tag already, and a field on every result would make the common case
   * carry the uncommon one, the same trade `SearchResult.diagnostics` makes.
   */
  curation?: CurationVerdict;
}

export { CurationRejected };

/** A knob that is set but unreadable falls back to the default instead of NaN. */
function envNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Rows the extractor's jev already priced carry the tag; the write gate never asks twice. */
function alreadyJevJudged(input: SaveInput): boolean {
  return (input.tags ?? []).includes("judged:jev");
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
    let importance = input.importance ?? (input.kind ? KIND_IMPORTANCE[kind] : undefined);
    // Curation (ADR-0040) runs before the embed: a rejected candidate must not cost a
    // vector round trip, and a demoted one changes the very values the rest of this
    // method would embed and store. An explicit kind or importance is the caller's
    // own verdict, so demotion only applies to values the store derived.
    const origin = input.source === "extractor" ? ("extracted" as const) : ("explicit" as const);
    let effectiveKind = kind;
    let curationTag: string | undefined;
    let curation: CurationVerdict | undefined;
    if ((env.MEMORY_CURATE ?? "").trim().toLowerCase() !== "off") {
      const verdict = curate(input.text, { origin });
      if (verdict.action === "reject") throw new CurationRejected(verdict);
      if (verdict.action === "demote" && input.kind === undefined && input.importance === undefined) {
        effectiveKind = DEMOTE_KIND;
        importance = DEMOTE_IMPORTANCE;
        curationTag = verdict.tag;
        curation = verdict;
      }
    }
    // The write gate (ADR-0041) is the judgement call no regex settles, asked once for
    // every write no judge has seen. Rows the extractor's jev already priced carry
    // `judged:jev` and skip this — one judgement per row, never two. A curation
    // demotion also stands: the structural verdict outranks the model's optimism about
    // the same sentence. Fail-open, like everything else on the judge wire — no key or
    // a failed call stores the write unjudged rather than losing it.
    if (!curation && !alreadyJevJudged(input) && writeGateEnabled() && input.text.trim().length >= 12) {
      const verdict = await jevWriteGate(input.text);
      if (verdict) {
        const callerSetValues = input.kind === undefined && input.importance === undefined;
        if (verdict.keep < WRITE_GATE_MIN() || verdict.scaffold >= 0.5) {
          if (origin === "extracted") {
            throw new CurationRejected({ action: "reject", junk: "low-value", advice: ADVICE["low-value"] });
          }
          if (callerSetValues) {
            // An explicit write is the caller's ask: priced, not refused — the same
            // bargain the weak curation classes strike with a named caller.
            effectiveKind = DEMOTE_KIND;
            importance = DEMOTE_IMPORTANCE;
            curationTag = "curation:low-value";
            curation = { action: "demote", junk: "low-value", advice: ADVICE["low-value"], tag: curationTag };
          } else {
            curationTag = "judged:write-gate";
          }
        } else if (callerSetValues) {
          // Only derived values get priced: a caller who named an importance made
          // their own judgement about this row, and the store does not second-guess it.
          importance = importanceFor(verdict.keep);
          curationTag = "judged:write-gate";
        } else {
          curationTag = "judged:write-gate";
        }
      }
    }
    const target: MemoryInput = {
      namespace,
      project,
      kind: effectiveKind,
      type: input.type,
      text: input.text,
      importance,
      strength: input.strength,
      source: input.source,
      tags: curationTag ? [...(input.tags ?? []), curationTag] : input.tags,
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
      // The curation tag rides in the caller tags: reconcile builds the row's tags
      // from these, so a demotion tag passed only via `target` would be dropped on
      // the insert path and the row would sit at the bottom unexplained.
      callerTags: curationTag ? [...(input.tags ?? []), curationTag] : input.tags,
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
      decision: decision.action === "insert" ? decision : { ...decision, action: "insert", oldId: undefined },
      ...(curation ? { curation } : {})
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
   * a remote embedder costs one round trip instead of one per row. Curation is off
   * here for the same reason: an import is a deliberate act, and a 5,000-row file
   * that fails on row 3 because one line ends in a colon is a hostile gate.
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

  async list(opts: { namespace: string; type?: string; project?: string | null; kind?: string; includeDeleted?: boolean; status?: string; includeArchived?: boolean; includeDraft?: boolean; limit?: number; offset?: number; query?: string; withVectors?: boolean }) {
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

  /**
   * Project management (ADR-0042). The operations are bulk statements over the
   * `project` column, resolved the same way writes are: an explicit slug wins,
   * otherwise the repository this process runs in.
   */

  /**
   * Every project the store holds, live rows only. Native stores answer with one
   * GROUP BY; the fallback sweeps partitions and groups in memory, which is correct
   * at any size and only slow — the trade `countNeverRetrieved` already accepts.
   */
  async listProjects(): Promise<ProjectSummary[]> {
    if (this.store.listProjects) return this.store.listProjects();
    const bySlug = new Map<string, ProjectSummary>();
    const fold = (m: Memory) => {
      const key = m.project ?? "\0unscoped";
      let summary = bySlug.get(key);
      if (!summary) {
        summary = { project: m.project, rows: 0, byKind: {}, lastActivityAt: 0 };
        bySlug.set(key, summary);
      }
      summary.rows++;
      summary.byKind[m.kind] = (summary.byKind[m.kind] ?? 0) + 1;
      if (m.createdAt > summary.lastActivityAt) summary.lastActivityAt = m.createdAt;
    };
    for (const ns of await this.store.distinctNamespaces()) {
      for (let offset = 0; ; offset += 500) {
        const page = await this.store.list({ namespace: ns, status: "active", limit: 500, offset, withVectors: false });
        for (const m of page.memories) fold(m);
        if (page.memories.length === 0 || offset + page.memories.length >= page.total) break;
      }
    }
    return [...bySlug.values()].sort(
      (a, b) => b.rows - a.rows || (a.project ?? "").localeCompare(b.project ?? "")
    );
  }

  /**
   * Make a project visible now, without waiting for its first real write.
   *
   * Idempotent: an initialized or already-written project is reported, not written
   * again. The marker is one durable `decision` row tagged `project:init` in the
   * shared layer — a project is a cross-agent concern — and the brief skips the tag,
   * so visibility costs the brief nothing.
   */
  async initProject(opts: { project?: string | null; note?: string; namespace?: string; agent?: string; user?: string } = {}): Promise<{
    project: string;
    created: boolean;
    rows: number;
    memory: Memory | null;
  }> {
    const slug = opts.project !== undefined ? normalizeProject(opts.project) : resolveProject().project;
    if (!slug) {
      throw new Error(
        "init: no project to initialize — pass a slug ([a-z0-9._-], max 40 chars) or run inside a git checkout"
      );
    }
    const existing = (await this.listProjects()).find((s) => s.project === slug);
    if (existing) return { project: slug, created: false, rows: existing.rows, memory: null };

    const text = opts.note?.trim() || `Project ${slug} initialized.`;
    const namespace = opts.namespace?.trim()
      ? opts.namespace.trim()
      : resolveWriteKey({ agent: opts.agent, user: opts.user, scope: "shared" });
    // A direct store write, not save(): the marker is system-authored, and the
    // curation gate (ADR-0040) would read "Project X initialized." as scaffold and
    // demote it. Skipping reconcile is the other half of the same call — re-initializing
    // after a forget must insert, never "reinforce" into a tombstone. `saveMany` and
    // the knowledge sync bypass the gates the same way for deliberate writes.
    const embedding = await this.embedder.embed(text, { inputType: "passage" });
    const memory = await this.store.insert(
      {
        namespace,
        project: slug,
        kind: "decision",
        type: "semantic",
        text,
        importance: KIND_IMPORTANCE.decision,
        source: "project:init",
        tags: ["project:init"]
      },
      embedding
    );
    return { project: slug, created: true, rows: 1, memory };
  }

  async renameProject(from: string, to: string, opts: { merge?: boolean } = {}): Promise<{ renamed: number; project: string }> {
    const source = normalizeProject(from);
    const target = normalizeProject(to);
    if (!source || !target) {
      throw new Error("rename: both slugs must normalize to a project slug ([a-z0-9._-], max 40 chars)");
    }
    if (!this.store.renameProject) throw new Error("this store does not support project management");
    if (source === target) return { renamed: 0, project: target };
    const summaries = await this.listProjects();
    if (!summaries.some((s) => s.project === source)) {
      throw new Error(`rename: unknown project "${source}"`);
    }
    // A rename onto an occupied slug is a merge of two efforts' history — legal, but
    // never a side effect of a typo, so it is asked for explicitly.
    const occupying = summaries.find((s) => s.project === target);
    if (occupying && occupying.rows > 0 && !opts.merge) {
      throw new Error(`rename: project "${target}" already holds ${occupying.rows} row(s) — pass merge to fold them together`);
    }
    const renamed = await this.store.renameProject(source, target);
    return { renamed, project: target };
  }

  async forgetProject(slug: string, opts: { mode?: "detach" | "delete" } = {}): Promise<{ detached: number; deleted: number; project: string }> {
    const target = normalizeProject(slug);
    if (!target) {
      throw new Error(`forget: "${slug}" does not normalize to a project slug ([a-z0-9._-], max 40 chars)`);
    }
    if (!this.store.forgetProject) throw new Error("this store does not support project management");
    if (!(await this.listProjects()).some((s) => s.project === target)) {
      throw new Error(`forget: unknown project "${target}"`);
    }
    // Soft delete by default: every row stays restorable, the same bargain a single
    // `forget` strikes. Detaching is the explicit alternative for rows that outlive
    // the project they were filed under.
    const res = await this.store.forgetProject(target, { mode: opts.mode ?? "delete" });
    return { ...res, project: target };
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
   *
   * Curation rejections are the expected outcome here, not errors: an extractor that
   * slices three candidates out of every turn and keeps none of them did its job
   * (Mem0's `{"facts": []}` is a success). `rejected` says how many were refused and
   * why-shaped, so a caller can tell "the turn held nothing durable" apart from
   * "the extractor was off".
   */
  async extractAndSave(turnText: string, namespace: string, referenceDate?: number): Promise<{ memories: Memory[]; rejected: number }> {
    const extracted = await this.extractor.extract(turnText, referenceDate ?? Date.now());
    // A replayed turn carries the project of the repository being replayed, not of
    // whatever directory this process happens to sit in.
    const project = resolveProject().project;
    const saved: Memory[] = [];
    let rejected = 0;
    for (const ex of extracted) {
      try {
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
      } catch (e) {
        if (e instanceof CurationRejected) {
          rejected += 1;
          continue;
        }
        throw e;
      }
    }
    return { memories: saved, rejected };
  }
}
