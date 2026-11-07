import { randomUUID } from "crypto";
import type { KnowledgeEdge, Memory, MemoryInput } from "../types.js";
import type { KnowledgeCapability, ProjectSummary, VectorStore } from "./interface.js";
import { DF_CAP_RATIO, LEXICAL_RAREST_K, LEXICAL_TOKEN_LIMIT, MIN_ROWS_FOR_DF_CAP } from "./interface.js";
import { cosineSimilarity } from "../embedding/provider.js";
import { indexTerms, queryTerms } from "../retrieval/terms.js";
import { deriveKind } from "../write/kind.js";
import { textHash } from "../write/text.js";
import { median } from "../stats.js";

export class InMemoryVectorStore implements VectorStore {
  private map = new Map<string, Memory>();

  async init(): Promise<void> {}
  close(): void {}

  async insert(input: MemoryInput, embedding: number[]): Promise<Memory> {
    const now = Date.now();
    const mem: Memory = {
      id: randomUUID(),
      namespace: input.namespace,
      project: input.project ?? null,
      kind: input.kind ?? deriveKind(input.text),
      type: input.type,
      knowledgeId: input.knowledgeId ?? null,
      knowledgeSection: input.knowledgeSection ?? null,
      text: input.text,
      embedding,
      importance: input.importance ?? 0.5,
      strength: input.strength ?? input.importance ?? 0.5,
      lastUsedAt: null,
      source: input.source,
      tags: input.tags,
      supersedesId: input.supersedesId ?? null,
      isDeleted: 0,
      visibility: input.visibility ?? "private",
      status: input.status ?? "active",
      pin: input.pin ?? 0,
      createdAt: now,
      updatedAt: now
    };
    this.map.set(mem.id, mem);
    return mem;
  }

  /** Mirror of the SQL batch insert: same rows, no transaction to save. */
  async insertMany(items: { input: MemoryInput; embedding: number[] }[]): Promise<Memory[]> {
    const out: Memory[] = [];
    for (const it of items) out.push(await this.insert(it.input, it.embedding));
    return out;
  }

  /**
   * Mirror of the SQL duplicate lookup (ADR-0018 amendment): the hash is derived
   * from `text` on both sides, never stored on the row, so the two stores agree by
   * construction. It applies the same readable-live population (tombstone, archived
   * and draft rows excluded) and the same partition scoping (`project`/`type`) as
   * the SQL store's WHERE — a test that passes on one proves the other.
   */
  async findExistingHashes(opts: {
    namespace: string;
    hashes: string[];
    project?: string | null;
    type?: string;
  }): Promise<Set<string>> {
    const wanted = new Set(opts.hashes);
    const found = new Set<string>();
    for (const m of this.map.values()) {
      // Readable-live population, exactly as the SQL store's WHERE: a row outside
      // the population `list()` shows blocks nothing, and the fold never crosses
      // project or type.
      if (m.namespace !== opts.namespace || m.isDeleted !== 0) continue;
      if (m.status === "archived" || m.status === "draft") continue;
      if (opts.project !== undefined) {
        if (opts.project === null ? m.project !== null : m.project !== opts.project) continue;
      }
      if (opts.type && m.type !== opts.type) continue;
      const h = textHash(m.text);
      if (wanted.has(h)) found.add(h);
    }
    return found;
  }

  async getById(id: string): Promise<Memory | null> {
    return this.map.get(id) ?? null;
  }

  /** The pool every vector query works over; mirrors the SQL store's filters. */
  private candidates(opts: {
    namespace: string;
    includeDeleted?: boolean;
    type?: string;
    status?: string;
    includeArchived?: boolean;
    includeDraft?: boolean;
    project?: string | null;
    kind?: string;
    knowledge?: string | null;
  }): Memory[] {
    let arr = [...this.map.values()].filter((m) => m.namespace === opts.namespace);
    if (!opts.includeDeleted) arr = arr.filter((m) => m.isDeleted === 0);
    // ADR-0020/0021, mirroring candidateWhere: undefined = any, null = unscoped.
    if (opts.project !== undefined) {
      arr = arr.filter((m) => (opts.project === null ? m.project === null : m.project === opts.project));
    }
    if (opts.kind) arr = arr.filter((m) => m.kind === opts.kind);
    if (opts.knowledge !== undefined) {
      arr = arr.filter((m) =>
        opts.knowledge === null ? m.knowledgeId === null : m.knowledgeId === opts.knowledge
      );
    }
    if (opts.type) arr = arr.filter((m) => m.type === opts.type);
    if (opts.status) arr = arr.filter((m) => m.status === opts.status);
    else {
      if (!opts.includeArchived) arr = arr.filter((m) => m.status !== "archived");
      if (!opts.includeDraft) arr = arr.filter((m) => m.status !== "draft");
    }
    return arr;
  }

  async cosineSpread(opts: {
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
  }): Promise<{ median: number; count: number }> {
    const cosines = this.candidates(opts)
      .filter((m) => m.embedding.length === opts.queryEmbedding.length)
      .map((m) => cosineSimilarity(opts.queryEmbedding, m.embedding));
    return { median: median(cosines), count: cosines.length };
  }

  async distinctNamespaces(opts: { includeDeleted?: boolean } = {}): Promise<string[]> {
    const held = [...this.map.values()]
      .filter((m) => opts.includeDeleted || m.isDeleted === 0)
      .map((m) => m.namespace);
    return [...new Set(held)].sort();
  }

  /** Cross-partition on purpose (ADR-0042): a project spans every partition that wrote into it. */
  async listProjects(): Promise<ProjectSummary[]> {
    const bySlug = new Map<string, ProjectSummary>();
    for (const m of this.map.values()) {
      if (m.isDeleted !== 0 || m.status !== "active") continue;
      const key = m.project ?? "\0unscoped";
      let summary = bySlug.get(key);
      if (!summary) {
        summary = { project: m.project, rows: 0, byKind: {}, lastActivityAt: 0 };
        bySlug.set(key, summary);
      }
      summary.rows++;
      summary.byKind[m.kind] = (summary.byKind[m.kind] ?? 0) + 1;
      if (m.createdAt > summary.lastActivityAt) summary.lastActivityAt = m.createdAt;
    }
    return [...bySlug.values()].sort(
      (a, b) => b.rows - a.rows || (a.project ?? "").localeCompare(b.project ?? "")
    );
  }

  async renameProject(from: string, to: string): Promise<number> {
    let moved = 0;
    for (const m of this.map.values()) {
      if (m.project === from) {
        // Identity metadata, not content: `updated_at` keeps its old value, the
        // same rule the SQL store's single UPDATE follows.
        m.project = to;
        moved++;
      }
    }
    return moved;
  }

  async forgetProject(slug: string, opts: { mode: "detach" | "delete" }): Promise<{ detached: number; deleted: number }> {
    let detached = 0;
    let deleted = 0;
    const now = Date.now();
    for (const m of this.map.values()) {
      if (m.project !== slug) continue;
      if (opts.mode === "detach") {
        m.project = null;
        detached++;
      } else if (m.isDeleted === 0) {
        m.isDeleted = 1;
        m.updatedAt = now;
        deleted++;
      }
    }
    return { detached, deleted };
  }

  async storedDim(): Promise<number | null> {
    for (const memory of this.map.values()) return memory.embedding.length;
    return null;
  }

  async list(opts: {
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
  }): Promise<{ memories: Memory[]; total: number }> {
    let arr = [...this.map.values()].filter((m) => m.namespace === opts.namespace);
    if (!opts.includeDeleted) arr = arr.filter((m) => m.isDeleted === 0);
    if (opts.project !== undefined) {
      arr = arr.filter((m) => (opts.project === null ? m.project === null : m.project === opts.project));
    }
    if (opts.kind) arr = arr.filter((m) => m.kind === opts.kind);
    if (opts.knowledge !== undefined) {
      arr = arr.filter((m) =>
        opts.knowledge === null ? m.knowledgeId === null : m.knowledgeId === opts.knowledge
      );
    }
    if (opts.type) arr = arr.filter((m) => m.type === opts.type);
    if (opts.status) arr = arr.filter((m) => m.status === opts.status);
    else {
      if (!opts.includeArchived) arr = arr.filter((m) => m.status !== "archived");
      if (!opts.includeDraft) arr = arr.filter((m) => m.status !== "draft");
    }
    if (opts.query) arr = arr.filter((m) => m.text.toLowerCase().includes(opts.query!.toLowerCase()));
    const total = arr.length;
    // Same key the SQL store uses (`ORDER BY pin DESC, created_at DESC, id ASC`), id as a
    // final tie-break so a page is deterministic when rows share a created_at millisecond —
    // Windows clock granularity (~15.6 ms) makes exact ties routine on a bulk insert, and
    // an arbitrary tie order here would let a page drop a row a cross-layer merge expected.
    arr.sort((a, b) => (b.pin - a.pin) || (b.createdAt - a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    return { memories: arr.slice(offset, offset + limit), total };
  }

  async deleteSoft(id: string): Promise<void> {
    const m = this.map.get(id);
    if (m) { m.isDeleted = 1; m.updatedAt = Date.now(); }
  }

  async updateEmbedding(id: string, embedding: number[], text: string): Promise<void> {
    const m = this.map.get(id);
    if (m) { m.embedding = embedding; m.text = text; m.updatedAt = Date.now(); }
  }

  async updateMeta(id: string, patch: { status?: string; pin?: number; visibility?: string; isDeleted?: number; tags?: string[]; knowledgeId?: string | null; knowledgeSection?: string | null }): Promise<Memory | null> {
    const m = this.map.get(id);
    if (!m) return null;
    if (patch.status !== undefined) m.status = patch.status as Memory["status"];
    if (patch.pin !== undefined) m.pin = patch.pin;
    if (patch.visibility !== undefined) m.visibility = patch.visibility as Memory["visibility"];
    if (patch.isDeleted !== undefined) m.isDeleted = patch.isDeleted;
    if (patch.tags !== undefined) m.tags = patch.tags;
    if (patch.knowledgeId !== undefined) m.knowledgeId = patch.knowledgeId;
    if (patch.knowledgeSection !== undefined) m.knowledgeSection = patch.knowledgeSection;
    m.updatedAt = Date.now();
    return m;
  }

  async supersede(oldId: string, newInput: MemoryInput, newEmbedding: number[]): Promise<Memory> {
    const old = this.map.get(oldId);
    if (!old) throw new Error(`old memory ${oldId} not found`);
    const created = await this.insert({ ...newInput, supersedesId: oldId }, newEmbedding);
    await this.deleteSoft(oldId);
    return created;
  }

  async vectorSearch(opts: {
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
  }): Promise<{ memory: Memory; vectorScore: number }[]> {
    const scored = this.candidates(opts).flatMap((memory) =>
      memory.embedding.length !== opts.queryEmbedding.length
        ? [] // stale width from an interrupted reembed: skip, do not throw
        : [{ memory, vectorScore: cosineSimilarity(opts.queryEmbedding, memory.embedding) }]
    );
    scored.sort((a, b) => b.vectorScore - a.vectorScore);
    return scored.slice(0, opts.limit);
  }

  /**
   * Mirror of the SQL store's lexical half (ADR-0012): same tokenizer, same
   * all-rows df, same "one row enters the union at most once". Integer df over
   * the whole map (not just this partition) is what keeps a test's ranking on
   * this backend comparable to the one prod gets from memory_terms.
   */
  async lexicalCandidates(opts: {
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
  }): Promise<{ memory: Memory; lexicalScore: number }[]> {
    const queryTokens = queryTerms(opts.query).slice(0, LEXICAL_TOKEN_LIMIT);
    if (queryTokens.length === 0) return [];
    const all = [...this.map.values()];
    const total = all.filter((m) => m.isDeleted === 0).length;
    const df = new Map<string, number>();
    for (const m of all) {
      for (const token of new Set(indexTerms(m.text))) {
        if (queryTokens.includes(token)) df.set(token, (df.get(token) ?? 0) + 1);
      }
    }
    // Same hygiene as the SQL store (ADR-0019): above 200 live rows a word that
    // appears in more than a third of them is skipped and only the eight rarest
    // query words score, because that is the shape the lexical half actually uses.
    const cap = total >= MIN_ROWS_FOR_DF_CAP ? Math.floor(total * DF_CAP_RATIO) : Number.MAX_SAFE_INTEGER;
    const useful = queryTokens
      .filter((token) => (df.get(token) ?? 0) <= cap)
      .sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0))
      .slice(0, LEXICAL_RAREST_K);
    if (useful.length === 0) return [];
    const scored = this.candidates(opts).flatMap((memory) => {
      const counts = new Map<string, number>();
      for (const token of indexTerms(memory.text)) counts.set(token, (counts.get(token) ?? 0) + 1);
      let lexicalScore = 0;
      for (const token of useful) {
        const tf = counts.get(token) ?? 0;
        if (tf === 0) continue;
        lexicalScore += tf * (total / (df.get(token) ?? 1));
      }
      return lexicalScore > 0 ? [{ memory, lexicalScore }] : [];
    });
    scored.sort((a, b) => b.lexicalScore - a.lexicalScore || a.memory.id.localeCompare(b.memory.id));
    return scored.slice(0, opts.limit);
  }

  /**
   * df over the whole live map, the same population `lexicalCandidates` scores
   * against — one convention per backend, so a test's weighting on this store
   * means the same thing as prod's. Absent tokens are absent from the map.
   */
  async termDf(tokens: string[]): Promise<Map<string, number>> {
    const want = new Set(tokens);
    const df = new Map<string, number>();
    if (want.size === 0) return df;
    for (const m of this.map.values()) {
      if (m.isDeleted) continue;
      for (const token of new Set(indexTerms(m.text))) {
        if (want.has(token)) df.set(token, (df.get(token) ?? 0) + 1);
      }
    }
    return df;
  }

  /** R2. Mirror of the SQL: +0.02, capped, and the use clock reset. */  async reinforce(ids: string[]): Promise<number> {
    const now = Date.now();
    let n = 0;
    for (const id of new Set(ids)) {
      const m = this.map.get(id);
      if (!m) continue;
      m.strength = Math.min(0.95, m.strength + 0.02);
      m.lastUsedAt = now;
      m.updatedAt = now;
      n++;
    }
    return n;
  }

  async prune(opts: { olderThanMs: number; maxImportance: number; type?: string; kind?: string }): Promise<number> {
    const cutoff = Date.now() - opts.olderThanMs;
    let n = 0;
    for (const m of this.map.values()) {
      // Same rule as the SQL store: clock resets on use, and eviction needs both
      // a low write-time importance and a low strength, so reinforcement still
      // protects a memory (ADR-0013).
      if (
        (m.lastUsedAt ?? m.createdAt) < cutoff &&
        m.importance <= opts.maxImportance &&
        m.strength <= opts.maxImportance &&
        m.isDeleted === 0
      ) {
        if (opts.kind && m.kind !== opts.kind) continue;
        if (opts.type && m.type !== opts.type) continue;
        m.isDeleted = 1;
        m.updatedAt = Date.now();
        n++;
      }
    }
    return n;
  }

  /** Knowledge index mirror (ADR-0023): same contract as the SQL capability. */
  get knowledge(): KnowledgeCapability {
    return {
      listByKnowledge: async (id) =>
        [...this.map.values()]
          .filter((m) => m.knowledgeId === id && m.isDeleted === 0)
          .sort((a, b) => (a.knowledgeSection ?? "").localeCompare(b.knowledgeSection ?? "")),
      listKnowledgeIds: async () => [
        ...new Set(
          [...this.map.values()]
            .filter((m) => m.knowledgeId !== null && m.isDeleted === 0)
            .map((m) => m.knowledgeId as string)
        )
      ].sort(),
      listKnowledge: async (namespaces) =>
        [...this.map.values()]
          .filter(
            (m) =>
              m.knowledgeId !== null &&
              m.isDeleted === 0 &&
              namespaces.includes(m.namespace) &&
              m.status !== "archived" &&
              m.status !== "draft"
          )
          .sort(
            (a, b) =>
              (a.knowledgeId as string).localeCompare(b.knowledgeId as string) ||
              (a.knowledgeSection ?? "").localeCompare(b.knowledgeSection ?? "")
          ),
      replaceLinks: async (from, edges) => {
        this.linksByFrom.set(from, edges.map((e) => ({ ...e })));
      },
      links: async (from) =>
        from
          ? (this.linksByFrom.get(from) ?? []).map((e) => ({ ...e }))
          : [...this.linksByFrom.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .flatMap(([, edges]) => edges.map((e) => ({ ...e })))
    };
  }

  private linksByFrom = new Map<string, KnowledgeEdge[]>();
}
