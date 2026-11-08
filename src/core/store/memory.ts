import { randomUUID } from "crypto";
import type { KnowledgeEdge, Memory, MemoryEvent, MemoryEventKind, MemoryInput, WriteEventMeta } from "../types.js";
import type { KnowledgeCapability, ProjectSummary, VectorStore } from "./interface.js";
import { DF_CAP_RATIO, LEXICAL_RAREST_K, LEXICAL_TOKEN_LIMIT, MIN_ROWS_FOR_DF_CAP } from "./interface.js";
import { cosineSimilarity } from "../embedding/provider.js";
import { indexTerms, queryTerms } from "../retrieval/terms.js";
import { deriveKind } from "../write/kind.js";
import { facetTagsOf, rederiveTags } from "../write/facets.js";
import { extractValidAt, textHash } from "../write/text.js";
import { median } from "../stats.js";
import {
  BUCKET_ABSTRACT_ROWS,
  accumulateCentroid,
  addToCentroid,
  boundCanReachFloor,
  bucketScanBound,
  bucketScanOrder,
  buildAbstract,
  bucketPrefilterEnabled,
  BUCKET_RADIUS_SLACK,
  finishCentroid,
  planBucketRefresh,
  queryToCentroid,
  type BucketRefreshReport,
} from "./buckets.js";

/** In-memory mirror of a `memory_buckets` row (P8, ADR-0048): the same shape, no BLOB. */
interface BucketSummary {
  namespace: string;
  projectKey: string; // '' encodes the unscoped backlog, exactly as the SQL PK does
  abstract: string;
  dim: number;
  /** The bucket's unit centroid; null for a write's placeholder (stale by definition). */
  centroid: number[] | null;
  norm: number;
  cosTheta: number;
  total: number;
  pending: number;
  updatedAt: number;
}

export class InMemoryVectorStore implements VectorStore {
  private map = new Map<string, Memory>();
  /**
   * The bucket summaries (P8, ADR-0048), mirror of the SQL `memory_buckets` table —
   * maintained by the same call sites, decided by the same shared `buckets.ts`
   * helpers, so a test that passes on one backend means the same thing on the other.
   * Like the SQL rows, these never enter `list` or any result set.
   */
  private buckets = new Map<string, BucketSummary>();
  /**
   * The facet postings (P4, ADR-0046), mirror of the SQL `memory_facets` table keyed
   * the way its `memory_id` index reads it: one memory -> its facet values, lowercased
   * exactly as `indexFacetsSync` stores them. Maintained by the same call sites the
   * SQL store reindexes on, so a drift bug in one backend fails the same test on both.
   * Tombstones keep their postings, like the SQL rows do — visibility is the read's
   * job (`isDeleted` in the candidate filter), not the index's.
   */
  private facetsByMemory = new Map<string, string[]>();
  /** Store-level KV, mirror of the SQL `store_meta` table (P2, ADR-0016 amendment). */
  private meta = new Map<string, string>();
  /**
   * The write history (P6, ADR-0045), mirror of the SQL `memory_events` table: an
   * append-only array with a monotonic id, so `history(id)` reads the same shape both
   * stores answer and a test that passes on one proves the other. Nothing here ever
   * removes an entry — not even a purge.
   */
  private events: MemoryEvent[] = [];
  private eventSeq = 0;

  async init(): Promise<void> {}
  close(): void {}

  /**
   * The two bucket helpers (P8, ADR-0048), mirror of the SQL store's. The flag is
   * read per write here rather than snapshotted: this store has no init() a caller
   * is obliged to await, so there is no single moment the snapshot could hang on —
   * and an in-memory write is a map set, where one `process.env` read is noise.
   */
  private get bucketWritesEnabled(): boolean {
    return bucketPrefilterEnabled();
  }

  private static bucketKey(namespace: string, projectKey: string): string {
    return `${namespace}\u0000${projectKey}`;
  }

  /**
   * One write marks its bucket pending (the SQL `noteChange` tail, mirrored): the
   * prefilter then treats the bucket as summary-less and scans it in full, so a row
   * written moments ago is never skipped. The placeholder this can create carries no
   * embedding — stale by construction, the safe state until the next refresh.
   */
  private markBucketPending(m: Memory): void {
    if (!this.bucketWritesEnabled) return;
    const projectKey = m.project ?? "";
    const key = InMemoryVectorStore.bucketKey(m.namespace, projectKey);
    const row = this.buckets.get(key);
    if (row) row.pending++;
    else
      this.buckets.set(key, {
        namespace: m.namespace,
        projectKey,
        abstract: "",
        dim: 0,
        centroid: null,
        norm: 0,
        cosTheta: 0,
        total: 0,
        pending: 1,
        updatedAt: 0
      });
  }

  /** Drop the summaries the rare sweeps strand (rename/detach/forget — no noteChange there). */
  private dropBucketsFor(project: string | null): void {
    const projectKey = project ?? "";
    for (const [key, row] of this.buckets) {
      if (row.projectKey === projectKey) this.buckets.delete(key);
    }
  }

  async getMeta(key: string): Promise<string | null> {
    return this.meta.get(key) ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.meta.set(key, value);
  }

  /**
   * Bucket refresh (P8, ADR-0048), mirror of the SQL implementation over the same
   * shared `planBucketRefresh` / `buildAbstract` / centroid helpers: the thresholds,
   * the sampling, the geometry and the report have one implementation; only the
   * plumbing differs. Needs no embedder — the centroid is the mean of the rows' own
   * vectors, so a refresh is pure local compute.
   */
  async refreshBucketSummaries(opts: { now?: number } = {}): Promise<BucketRefreshReport> {
    const now = opts.now ?? Date.now();
    const universeRows = new Map<string, { namespace: string; projectKey: string; total: number; sample: Memory[] }>();
    for (const m of this.map.values()) {
      if (m.isDeleted !== 0 || m.status !== "active") continue;
      const projectKey = m.project ?? "";
      const key = InMemoryVectorStore.bucketKey(m.namespace, projectKey);
      const bucket = universeRows.get(key);
      if (bucket) {
        bucket.total++;
        bucket.sample.push(m);
      } else {
        universeRows.set(key, { namespace: m.namespace, projectKey, total: 1, sample: [m] });
      }
    }
    const planned = planBucketRefresh(
      [...universeRows.keys()].map((key) => ({ key, total: universeRows.get(key)!.total })),
      new Map(
        [...this.buckets.entries()].map(([key, r]) => [
          key,
          { dim: r.dim, total: r.total, pending: r.pending },
        ])
      ),
      await this.storedDim()
    );
    for (const key of planned.dropped) this.buckets.delete(key);

    const targets = [...universeRows.entries()].filter(([key]) => planned.targets.includes(key));
    const currentDim = await this.storedDim();
    let refreshed = 0;
    for (const [key, bucket] of targets) {
      if (currentDim === null) continue;
      // Newest first, id as the tie-break — the same ORDER BY the SQL sample reads.
      const rows = bucket.sample
        .sort((a, z) => z.createdAt - a.createdAt || (a.id < z.id ? -1 : a.id > z.id ? 1 : 0))
        .slice(0, BUCKET_ABSTRACT_ROWS);
      const usable = bucket.sample.map((m) => m.embedding).filter((v) => v.length === currentDim);
      if (usable.length === 0) continue; // nothing scannable — leave the summary absent
      const acc = accumulateCentroid(currentDim);
      for (const v of usable) addToCentroid(acc, v);
      const geo = finishCentroid(acc, 1);
      let cosTheta = 1;
      for (const v of usable) cosTheta = Math.min(cosTheta, queryToCentroid(v, geo.centroid, geo.norm));
      this.buckets.set(key, {
        namespace: bucket.namespace,
        projectKey: bucket.projectKey,
        abstract: buildAbstract(rows.map((m) => m.text)),
        dim: geo.centroid.length,
        centroid: geo.centroid,
        norm: geo.norm,
        cosTheta: Math.max(-1, cosTheta - BUCKET_RADIUS_SLACK),
        total: bucket.total,
        pending: 0,
        updatedAt: now
      });
      refreshed++;
    }
    return { refreshed, skipped: planned.skipped, dropped: planned.dropped.length, total: universeRows.size };
  }

  async bucketSummaries() {
    return [...this.buckets.values()]
      .map((r) => ({
        namespace: r.namespace,
        project: r.projectKey === "" ? null : r.projectKey,
        dim: r.dim,
        total: r.total,
        pending: r.pending,
        hasEmbedding: r.centroid !== null && r.centroid.length > 0,
        updatedAt: r.updatedAt
      }))
      .sort((a, b) => a.namespace.localeCompare(b.namespace) || (a.project ?? "").localeCompare(b.project ?? ""));
  }

  /** Drop every summary (P8, ADR-0048) — `reembedAll`'s invalidation, same as the SQL store. */
  async dropBucketSummaries(): Promise<void> {
    this.buckets.clear();
  }

  /** Append one history row; the caller owns "same instant as the write". */
  private logEvent(
    memoryId: string,
    event: MemoryEventKind,
    at: number,
    fields: { oldValue?: string | null; newValue?: string | null; reason?: string | null; model?: string | null } = {}
  ): void {
    this.events.push({
      id: ++this.eventSeq,
      memoryId,
      event,
      oldValue: fields.oldValue ?? null,
      newValue: fields.newValue ?? null,
      reason: fields.reason ?? null,
      model: fields.model ?? null,
      at
    });
  }

  async insert(input: MemoryInput, embedding: number[]): Promise<Memory> {
    const now = Date.now();
    // Facet postings commit with the row (P4, ADR-0046) — here the "transaction" is
    // two map writes in one synchronous block, which is the same guarantee in a
    // smaller material.
    const facets = facetTagsOf(input.tags).map((t) => t.toLowerCase());
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
      // P2: mirror of the SQL store — a fresh row has earned nothing; the counter
      // only moves on `reinforce`.
      useCount: 0,
      source: input.source,
      tags: input.tags,
      supersedesId: input.supersedesId ?? null,
      isDeleted: 0,
      visibility: input.visibility ?? "private",
      status: input.status ?? "active",
      pin: input.pin ?? 0,
      // P6: event-time clock from the text's own stamp, same derivation as the SQL
      // buildRow — the two stores must agree by construction.
      validAt: extractValidAt(input.text),
      invalidAt: null,
      createdAt: now,
      updatedAt: now
    };
    this.map.set(mem.id, mem);
    this.facetsByMemory.set(mem.id, facets);
    this.logEvent(mem.id, "insert", now, { newValue: mem.text, reason: input.source ?? null });
    this.markBucketPending(mem);
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
    facet?: string;
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
    // P5 (ADR-0047): the facet slice over the postings mirror, lowercased exactly as
    // `indexFacetsSync` stores them — the same derived state `facetCandidates` ranks.
    if (opts.facet) {
      const wanted = String(opts.facet).toLowerCase();
      arr = arr.filter((m) => (this.facetsByMemory.get(m.id) ?? []).includes(wanted));
    }
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
    facet?: string;
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
    // P8 (ADR-0048): the move changed bucket membership without noteChange — drop
    // both slugs' summaries, the same rare-sweep clear the SQL store does.
    if (moved > 0) {
      this.dropBucketsFor(from);
      this.dropBucketsFor(to);
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
    if (detached > 0) {
      // P8: detach moves rows into the unscoped bucket — both summaries go.
      this.dropBucketsFor(slug);
      this.dropBucketsFor(null);
    } else if (deleted > 0) {
      this.dropBucketsFor(slug);
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
    facet?: string;
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
    // P5 (ADR-0047): the same postings-mirror filter the candidate reads apply, so a
    // filtered page and a filtered search agree about what carries a facet.
    if (opts.facet) {
      const wanted = String(opts.facet).toLowerCase();
      arr = arr.filter((m) => (this.facetsByMemory.get(m.id) ?? []).includes(wanted));
    }
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
    // No history row, `invalid_at` stays NULL — same contract as the SQL store: a
    // plain forget is a tombstone, not one of the four write points.
    const m = this.map.get(id);
    if (m) {
      m.isDeleted = 1;
      m.updatedAt = Date.now();
      this.markBucketPending(m); // P8: the bucket's rows changed; scan it fully until refresh
    }
  }

  async updateEmbedding(id: string, embedding: number[], text: string): Promise<void> {
    const m = this.map.get(id);
    // The text changed, so the clocks that describe it follow — same as the SQL
    // store's transaction: hash is derived per read here, valid_at recomputed.
    // P4 (ADR-0046): the facets follow the text the same way — `rederiveTags` keeps
    // the caller's plain tags and re-derives the facets from what the row now says,
    // and the postings are rewritten from those tags, which is what keeps the
    // invariant (facet postings == the row's facet tags) true on this path.
    if (m) {
      const tags = rederiveTags(m.tags, text);
      m.embedding = embedding;
      m.text = text;
      m.tags = tags;
      m.validAt = extractValidAt(text);
      m.updatedAt = Date.now();
      this.facetsByMemory.set(id, facetTagsOf(tags).map((t) => t.toLowerCase()));
    }
  }

  async updateMeta(id: string, patch: { status?: string; pin?: number; visibility?: string; isDeleted?: number; importance?: number; tags?: string[]; knowledgeId?: string | null; knowledgeSection?: string | null }, meta?: WriteEventMeta): Promise<Memory | null> {
    const m = this.map.get(id);
    if (!m) return null;
    if (patch.status !== undefined) {
      // The archive write point (P6, ADR-0045), mirror of the SQL transaction: the
      // prior status read before the flip, the event written with it, a re-archive
      // a no-op, a restore unrecorded.
      if (patch.status === "archived" && m.status !== "archived") {
        this.logEvent(id, "archive", Date.now(), {
          oldValue: m.status,
          newValue: "archived",
          reason: meta?.reason ?? null
        });
      }
      m.status = patch.status as Memory["status"];
    }
    if (patch.pin !== undefined) m.pin = patch.pin;
    if (patch.visibility !== undefined) m.visibility = patch.visibility as Memory["visibility"];
    if (patch.isDeleted !== undefined) m.isDeleted = patch.isDeleted;
    if (patch.importance !== undefined) m.importance = patch.importance;
    if (patch.tags !== undefined) {
      // A tags patch rewrites the row's join keys (P4, ADR-0046) — the same bargain
      // as the SQL branch: the column and the postings move together, in one block.
      m.tags = patch.tags;
      this.facetsByMemory.set(id, facetTagsOf(patch.tags).map((t) => t.toLowerCase()));
    }
    if (patch.knowledgeId !== undefined) m.knowledgeId = patch.knowledgeId;
    if (patch.knowledgeSection !== undefined) m.knowledgeSection = patch.knowledgeSection;
    m.updatedAt = Date.now();
    this.markBucketPending(m); // P8: status/visibility/restores change what the bucket's scan returns
    return m;
  }

  /**
   * Mirror of the SQL supersede (P6, ADR-0045): successor's insert event, the old
   * row's invalidation with `invalidAt = now` in the same mutation, the supersede
   * event carrying the decision. There is no transaction to wrap here — the map
   * mutations below are the same three writes the SQL version commits atomically.
   */
  async supersede(oldId: string, newInput: MemoryInput, newEmbedding: number[], meta?: WriteEventMeta): Promise<Memory> {
    const old = this.map.get(oldId);
    if (!old) throw new Error(`old memory ${oldId} not found`);
    const created = await this.insert({ ...newInput, supersedesId: oldId }, newEmbedding);
    const now = Date.now();
    old.isDeleted = 1;
    old.invalidAt = now;
    old.updatedAt = now;
    this.markBucketPending(old); // P8: the predecessor left the pool (the successor marked via insert)
    this.logEvent(oldId, "supersede", now, {
      oldValue: old.text,
      newValue: created.text,
      reason: meta?.reason ?? null,
      model: meta?.model ?? null
    });
    return created;
  }

  /** The append-only history of one id (P6, ADR-0045), oldest first — purge-proof by construction. */
  async history(id: string): Promise<MemoryEvent[]> {
    return this.events.filter((e) => e.memoryId === id).sort((a, b) => a.id - b.id);
  }

  /** Forward half of the chain: every row whose `supersedesId` names this id, tombstones included. */
  async successorsOf(id: string): Promise<Memory[]> {
    return [...this.map.values()]
      .filter((m) => m.supersedesId === id)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
    facet?: string;
  }): Promise<{ memory: Memory; vectorScore: number }[]> {
    // P8 (ADR-0048): the prefilter, mirroring the SQL path. The candidate pool comes
    // from `candidates(opts)` — the same population the exact scan ranks — and the
    // prefilter only decides which buckets get their cosines computed; any
    // incapability falls through to the full scan.
    if (bucketPrefilterEnabled()) {
      const hit = this.vectorSearchBucketed(opts);
      if (hit !== null) return hit;
    }
    const scored = this.candidates(opts).flatMap((memory) =>
      memory.embedding.length !== opts.queryEmbedding.length
        ? [] // stale width from an interrupted reembed: skip, do not throw
        : [{ memory, vectorScore: cosineSimilarity(opts.queryEmbedding, memory.embedding) }]
    );
    scored.sort((a, b) => b.vectorScore - a.vectorScore);
    return scored.slice(0, opts.limit);
  }

  /**
   * The bucketed scan (P8, ADR-0048), the SQL `vectorSearchBucketed` over maps:
   * universe from the data (never from the summaries), stale buckets always scanned,
   * the bound walk from the shared helpers — per bucket an upper bound on the cosine
   * any of its rows can reach, walked best-bound first with an early stop at the
   * floor. `null` = run the plain full scan.
   */
  private vectorSearchBucketed(opts: {
    namespace: string;
    queryEmbedding: number[];
    limit: number;
    includeDeleted?: boolean;
    status?: string;
    includeArchived?: boolean;
    includeDraft?: boolean;
  }): { memory: Memory; vectorScore: number }[] | null {
    // P8 exactness guard (independent review, 2026-11-08) — the InMemory mirror of
    // the SQL store's: the summaries cover the DEFAULT population only
    // (`is_deleted = 0 AND status = 'active'`), so a search over a wider one ranks
    // buckets by caps that do not cover those rows and falls back to the exact scan
    // rather than skip one. Narrower filters are safe: a cap over a superset still
    // bounds the subset.
    if (opts.status !== undefined || opts.includeDeleted || opts.includeArchived || opts.includeDraft) {
      return null;
    }
    if (this.buckets.size === 0) return null;
    const q = opts.queryEmbedding;
    const groups = new Map<string, Memory[]>();
    for (const m of this.candidates(opts)) {
      if (m.embedding.length !== q.length) continue; // the exact path skips these too
      const key = m.project ?? "";
      const rows = groups.get(key);
      if (rows) rows.push(m);
      else groups.set(key, [m]);
    }
    if (groups.size < 2) return null; // one bucket is the exact scan already
    const fresh: { key: string; bound: number }[] = [];
    const stale: string[] = [];
    for (const [key, rows] of groups) {
      const s = this.buckets.get(InMemoryVectorStore.bucketKey(opts.namespace, key));
      // Stale = no summary, no centroid yet (a write's placeholder), a summary at
      // another width, a degenerate centroid, or writes since the refresh.
      if (!s || s.centroid === null || s.dim !== q.length || s.norm <= 0 || s.pending > 0) {
        stale.push(key);
        continue;
      }
      fresh.push({ key, bound: bucketScanBound(queryToCentroid(q, s.centroid, s.norm), s.cosTheta) });
    }
    const order = bucketScanOrder(fresh, stale);

    const merged: { memory: Memory; vectorScore: number }[] = [];
    let floor = Number.NEGATIVE_INFINITY;
    for (const step of order) {
      if (merged.length >= opts.limit && !boundCanReachFloor(step.bound, floor)) break;
      for (const memory of groups.get(step.key) ?? []) {
        merged.push({ memory, vectorScore: cosineSimilarity(q, memory.embedding) });
      }
      if (merged.length > 0) {
        merged.sort((a, b) => b.vectorScore - a.vectorScore || (a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0));
        if (merged.length > opts.limit) merged.length = opts.limit;
        floor = merged[merged.length - 1]!.vectorScore;
      }
    }
    return merged;
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
    facet?: string;
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

  /**
   * Mirror of the SQL facet read (P4, ADR-0046): rows whose tags share at least one
   * of the given facets, most shared first, id as the tie-break — the same ranking
   * the GROUP BY orders by, over the same lowercased postings the write paths keep.
   * The visibility filter is `candidates`, the same pool `vectorSearch` works over,
   * exactly as the SQL JOIN applies `candidateWhere`.
   */
  async facetCandidates(opts: {
    namespace: string;
    facets: string[];
    limit: number;
    type?: string;
    includeDeleted?: boolean;
    status?: string;
    includeArchived?: boolean;
    includeDraft?: boolean;
    project?: string | null;
    kind?: string;
    knowledge?: string | null;
    facet?: string;
  }): Promise<{ memory: Memory; sharedFacets: string[] }[]> {
    const wanted = new Set(
      [...new Set(opts.facets)].map((f) => String(f ?? "").toLowerCase()).filter((f) => f.length > 0)
    );
    if (wanted.size === 0 || opts.limit <= 0) return [];
    const scored = this.candidates(opts).flatMap((memory) => {
      const shared = [...new Set((this.facetsByMemory.get(memory.id) ?? []).filter((f) => wanted.has(f)))];
      return shared.length === 0 ? [] : [{ memory, sharedFacets: shared, shared: shared.length }];
    });
    scored.sort((a, b) => b.shared - a.shared || (a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0));
    return scored.slice(0, opts.limit).map(({ memory, sharedFacets }) => ({ memory, sharedFacets }));
  }

  /**
   * R2. Mirror of the SQL: +0.02, capped, the use clock reset, and — since P2
   * (ADR-0016 amendment) — the retrieval count incremented. The `?? 0` guards a
   * row built before the field existed, exactly as the SQL `COALESCE` does.
   */  async reinforce(ids: string[]): Promise<number> {
    const now = Date.now();
    let n = 0;
    for (const id of new Set(ids)) {
      const m = this.map.get(id);
      // Tombstones skip, exactly as the SQL WHERE's `is_deleted = 0` — and so does
      // their history row: the event is written inside the branch that moved.
      if (!m || m.isDeleted !== 0) continue;
      m.strength = Math.min(0.95, m.strength + 0.02);
      m.useCount = (m.useCount ?? 0) + 1;
      m.lastUsedAt = now;
      m.updatedAt = now;
      // The text did not change, so old/new stay NULL (see MemoryEvent in types.ts).
      this.logEvent(id, "reinforce", now);
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
        this.markBucketPending(m); // P8: mirror of the SQL sweep's summary invalidation
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
