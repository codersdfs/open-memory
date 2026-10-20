// @ts-nocheck
import { randomUUID } from "crypto";
import { statSync } from "node:fs";
import type { KnowledgeEdge, Memory, MemoryInput } from "../types.js";
import type { KnowledgeCapability, VectorStore } from "./interface.js";
import { DF_CAP_RATIO, LEXICAL_RAREST_K, LEXICAL_TOKEN_LIMIT, MIN_ROWS_FOR_DF_CAP } from "./interface.js";
import { tokenize } from "../retrieval/bm25.js";
import { deriveKind } from "../write/kind.js";
import { median } from "../stats.js";

/**
 * The candidate pool that vectorSearch and cosineSpread must agree on. They are read
 * against each other, so two hand-written WHERE clauses would eventually drift and
 * quietly measure different corpora.
 */
function candidateWhere(
  opts: {
    namespace: string;
    includeDeleted?: boolean;
    type?: string;
    status?: string;
    includeArchived?: boolean;
    includeDraft?: boolean;
    project?: string | null;
    kind?: string;
    knowledge?: string | null;
  },
  alias = "memories"
): { whereSql: string; params: (string | number)[] } {
  const col = (c: string) => `${alias}.${c}`;
  const where: string[] = [`${col("namespace")} = ?`];
  const params: (string | number)[] = [opts.namespace];
  if (!opts.includeDeleted) where.push(`${col("is_deleted")} = 0`);
  // ADR-0020: `undefined` means "any project", `null` means "the pre-project
  // backlog". Collapsing the two would make `--project ""` silently return
  // every row, which is the failure mode a scoped read must not have.
  if (opts.project !== undefined) {
    if (opts.project === null) where.push(`${col("project")} IS NULL`);
    else {
      where.push(`${col("project")} = ?`);
      params.push(opts.project);
    }
  }
  if (opts.kind) {
    where.push(`${col("kind")} = ?`);
    params.push(opts.kind);
  }
  // ADR-0023: same three-way contract as project — `undefined` every row, `null`
  // only ordinary memories, an id only that page. Reconcile passes `null` so a
  // chat memory can never merge into a file's index.
  if (opts.knowledge !== undefined) {
    if (opts.knowledge === null) where.push(`${col("knowledge_id")} IS NULL`);
    else {
      where.push(`${col("knowledge_id")} = ?`);
      params.push(opts.knowledge);
    }
  }
  if (opts.type) {
    where.push(`${col("type")} = ?`);
    params.push(opts.type);
  }
  if (opts.status) {
    where.push(`${col("status")} = ?`);
    params.push(opts.status);
  } else {
    if (!opts.includeArchived) where.push(`${col("status")} != 'archived'`);
    if (!opts.includeDraft) where.push(`${col("status")} != 'draft'`);
  }
  return { whereSql: where.join(" AND "), params };
}

// ---------------------------------------------------------------------------
// Vector storage (ADR-0017). A 384-d embedding as JSON text is ~6 KB of digits and
// `JSON.parse` on every row of every search; the same vector as a float32 blob is
// 1.5 KB and decodes to a typed array without allocating. At 10^5 rows those two
// choices are the difference between a 1.1 GB file searched in 2.8 s and a 0.5 GB
// file searched in ~100 ms. The norm is stored beside the vector so cosine is one
// dot product instead of a second pass over the row.
// ---------------------------------------------------------------------------

function packVector(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

/** Zero-copy view when the blob happens to be aligned, copy otherwise. */
function unpackVector(raw: any): Float32Array {
  const buf: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buf.byteOffset % 4 === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
  }
  const out = new Float32Array(buf.length >> 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

function vectorNorm(vec: Float32Array): number {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  return Math.sqrt(n);
}

/** Cosine against an already-normalised query, without touching the raw numbers twice. */
function cosineFast(query: Float32Array, queryNorm: number, vec: Float32Array, vecNorm: number): number {
  let dot = 0;
  for (let i = 0; i < vec.length; i++) dot += query[i] * vec[i];
  const denom = queryNorm * vecNorm;
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// int8 shortlist (ADR-0025). Each vector keeps a per-row max-abs scale and one
// signed byte per dimension; a scan ranks on those, then the winners are
// re-scored exactly against the float32 blob.
//
// The premise worth remembering: at 2048d the *blob read* was measured at 61% of
// a search and the dot product at 7%, which suggested reading four times fewer
// bytes. Doing that saved only 26 ms of 116 ms — the rest of that phase is
// per-row object construction and the JOIN, and those do not shrink when the
// payload does. Measured end to end: 1.45x (181.6 -> 125.5 ms at 10k rows),
// still over budget at 10^5, hence off by default (ADR-0026).
// ---------------------------------------------------------------------------

/**
 * int8 quantisation of one vector: `q[i] = round(v[i] / maxAbs * 127)`.
 *
 * The result must agree with `unpackQ8` element for element, and the reason is a
 * trap worth spelling out: the bytes are produced as unsigned (`v + 256` for
 * negatives) and are meant to be read back as SIGNED. `cosineQ8` multiplies two
 * of these together, so if one side is still a `Buffer` (unsigned elements) while
 * the other came through `unpackQ8` (signed), the same dimension contributes
 * +130 on one side and -126 on the other. The dot product flips sign and the true
 * neighbour ranks LAST instead of first — measured: a self-query scored -0.55 and
 * ranked 2000/2000, with recall@20 = 0. Returning `Int8Array` and not `Buffer` is
 * what keeps both sides in the same unit.
 */
function quantizeVector(vec: ArrayLike<number>): { q8: Int8Array; scale: number } {
  let maxAbs = 0;
  for (let i = 0; i < vec.length; i++) {
    const a = Math.abs(vec[i]);
    if (a > maxAbs) maxAbs = a;
  }
  const out = new Int8Array(vec.length);
  if (maxAbs === 0) return { q8: out, scale: 0 };
  const k = 127 / maxAbs;
  for (let i = 0; i < vec.length; i++) {
    // Math.round against the signed target: no `+256`, because Int8Array already
    // wraps -126 to the same byte a Uint8Array would store as 130.
    out[i] = Math.round(vec[i] * k);
  }
  return { q8: out, scale: maxAbs };
}

/**
 * Int8 view over a blob read back from SQLite.
 *
 * `node:sqlite` hands back a plain `Uint8Array`, and `Buffer.from(uint8Array)` does
 * NOT copy it: it is placed in Node's shared buffer pool, so the resulting Buffer's
 * `byteOffset` is an offset into an 8 KB pool, not into the original bytes. Building
 * `new Int8Array(buf.buffer, buf.byteOffset, buf.length)` from that reads whatever
 * happens to sit at that pool offset — silently wrong data, and the reason the first
 * version of this path returned the same top-20 for every query. Copy through
 * `Uint8Array.from` so the view is over bytes this function owns.
 */
function unpackQ8(raw: any): Int8Array {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as any);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Int8Array(copy.buffer);
}

/** L2 norm of the integer copy, used to normalise the quantised query side. */
function vectorNorm64(vec: Int8Array): number {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  return Math.sqrt(n);
}

/**
 * Approximate cosine from the int8 copy. Both sides must be expressed in their
 * ORIGINAL units before dividing: `dot(q8_q, q8_v)` is in units of
 * `127*127/(qScale*rowScale)`, so multiplying by `(qScale*rowScale)/(127*127)`
 * yields the true dot product. The norms in the denominator are the exact float32
 * norms, never the quantised ones — mixing a quantised query norm with a float row
 * norm scales scores by an arbitrary constant and destroys the ranking entirely
 * (measured: recall@20 fell to 0 before this was fixed).
 */
function cosineQ8(
  q: Int8Array,
  qScale: number,
  qNorm: number,
  row: Int8Array,
  rowScale: number,
  rowNorm: number
): number {
  let dot = 0;
  for (let i = 0; i < q.length; i++) dot += q[i] * row[i];
  const denom = qNorm * rowNorm;
  if (denom === 0) return 0;
  return (dot * (qScale * rowScale)) / (127 * 127 * denom);
}


// Lazy load node:sqlite. Resolved through `createRequire` so the id never enters a
// bundler's resolver: a dynamic `import("node:sqlite")` — even with @vite-ignore — came out
// as the bare id "sqlite" under vitest, because this Node's builtin list does not carry
// node:sqlite. No test could therefore open the real store, and the schema's CHECK
// constraints were never exercised; that is how a status the CHECK rejects shipped
// advertised. A runtime `require` keeps the lookup inside node.
let DatabaseSync: any;
async function getDatabaseSync() {
  if (DatabaseSync) return DatabaseSync;
  const { createRequire } = await import("node:module");
  const mod = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: unknown };
  DatabaseSync = mod.DatabaseSync;
  return DatabaseSync;
}

export class SqliteVectorStore implements VectorStore {
  private db: any;
  private dbPath: string;
  private ready = false;

  constructor(dbPath = process.env.MEMORY_DB_PATH ?? "memory.db") {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    if (this.ready) return;
    // SQLite refuses to create a file in a directory that does not exist, and
    // the default store is ~/.ai-memory/memory.db — a path that is not there
    // on a fresh machine. Creating it here is the one place that knows the file
    // is about to be opened; every caller goes through init().
    if (this.dbPath !== ":memory:" && !this.dbPath.startsWith("file:")) {
      const { mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(this.dbPath), { recursive: true });
    }
    const D = await getDatabaseSync();
    this.db = new D(this.dbPath);
    // Shared-store durability (ADR-0007): four different agents may open this file
    // at the same time — each with its own MCP server process, plus the daemon. WAL
    // lets readers proceed while a writer commits; busy_timeout makes a concurrent
    // writer wait for the lock instead of throwing SQLITE_BUSY at the agent.
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.db.exec("PRAGMA synchronous = NORMAL");
    } catch {
      // Builds without WAL still work; retryWrite() covers the remaining contention.
    }
    // 1. create table (IF NOT EXISTS — safe for new + old DBs)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('episodic','semantic','procedural','working')),
        project TEXT,
        kind TEXT NOT NULL DEFAULT 'note'
          CHECK(kind IN ('decision','convention','gotcha','fact','task','note')),
        knowledge_id TEXT,
        knowledge_section TEXT,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        strength REAL NOT NULL DEFAULT 0.5,
        last_used_at INTEGER,
        source TEXT,
        tags TEXT,
        supersedes_id TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility='private'),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','draft')),
        pin INTEGER NOT NULL DEFAULT 0 CHECK(pin IN (0,1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // 2. migrate existing DBs that lack 008 lite columns (BEFORE indexes)
    const cols = new Set<string>((this.db.prepare(`PRAGMA table_info(memories)`).all() as { name: string }[]).map(r => r.name));
    if (!cols.has("visibility")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility='private')`);
    }
    if (!cols.has("status")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived','draft'))`);
    }
    if (!cols.has("pin")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN pin INTEGER NOT NULL DEFAULT 0 CHECK(pin IN (0,1))`);
    }
    // R2. Backfill from importance: a memory that already earned its score keeps
    // it, and every existing row starts with the clock it was created with.
    if (!cols.has("strength")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN strength REAL NOT NULL DEFAULT 0.5`);
      this.db.exec(`UPDATE memories SET strength = importance`);
    }
    if (!cols.has("last_used_at")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN last_used_at INTEGER`);
    }
    // ADR-0020/0021. Both columns are added together because they answer the same
    // question — "which effort is this, and why does it deserve to survive" — and a
    // store with one but not the other would brief on kind while ignoring project.
    if (!cols.has("project")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN project TEXT`);
    }
    if (!cols.has("kind")) {
      this.db.exec(
        `ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'
           CHECK(kind IN ('decision','convention','gotcha','fact','task','note'))`
      );
      // The column is brand new here, so every existing row is unclassified rather
      // than genuinely a `note`. Classify once, in batches, instead of paying a
      // regex per row on every later read. A crash mid-backfill leaves rows at the
      // default, which is the same value a failed classification would have given.
      this.backfillKinds();
    }
    // ADR-0023: the knowledge index. Both columns are added together — a row that
    // knew its page but not its section could not be updated in place on the next
    // sync, which is the whole point of the index.
    if (!cols.has("knowledge_id")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN knowledge_id TEXT`);
    }
    if (!cols.has("knowledge_section")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN knowledge_section TEXT`);
    }
    // 3. create indexes (after columns guaranteed to exist)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_ns_type ON memories(namespace, type);
      CREATE INDEX IF NOT EXISTS idx_memories_ns_deleted ON memories(namespace, is_deleted);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_supersedes ON memories(supersedes_id);
      CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project, created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_project_kind ON memories(project, kind, created_at);
      -- ADR-0023: one live row per (page, section). The partial predicate is what
      -- lets the column be NULL for every ordinary memory and still enforce the
      -- identity a sync needs to update a section in place.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_knowledge_section
        ON memories(knowledge_id, knowledge_section)
        WHERE knowledge_id IS NOT NULL AND is_deleted = 0;
      CREATE INDEX IF NOT EXISTS idx_memories_knowledge ON memories(knowledge_id)
        WHERE knowledge_id IS NOT NULL;
    `);
    // 4. lexical index (ADR-0012). Kept alongside the embedding instead of in an
    // FTS5 virtual table: the retriever needs term frequencies it can project
    // through the same SQL filters (namespace/status/deleted) and the same
    // tokenizer as bm25.ts, and FTS5's default tokenizer has no notion of CJK
    // unigrams at all. PRIMARY KEY (token, memory_id) is the inverted index;
    // idx_terms_memory is what makes "re-index this one row" cheap.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_terms (
        token TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        tf INTEGER NOT NULL,
        PRIMARY KEY (token, memory_id)
      );
      CREATE INDEX IF NOT EXISTS idx_terms_memory ON memory_terms(memory_id);
      CREATE TABLE IF NOT EXISTS term_df (
        token TEXT PRIMARY KEY,
        n INTEGER NOT NULL
      );
    `);
    // 5. knowledge links (ADR-0023). A row per written link, not per resolved edge:
    // a target that resolves only when a second page is created has to be visible
    // as debt (to_id NULL), and `target` is what tells an editor which line to fix.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_links (
        from_id TEXT NOT NULL,
        to_id TEXT,
        target TEXT NOT NULL,
        PRIMARY KEY (from_id, target)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_links_to ON knowledge_links(to_id);
    `);
    this.backfillTerms();
    this.rebuildTermDfIfEmpty();
    this.migrateVectors();
    this.ready = true;
  }

  /**
   * Vector storage migration (ADR-0017). Before v0.5 every row carried its embedding
   * as JSON text inside `memories`: ~6 KB of digits for a 384-d vector, re-parsed on
   * every search. Here the numbers move to `memory_vectors` as float32 blobs with
   * their norm precomputed, and the old column is emptied to '' — kept, not dropped,
   * because a downgrade must still find readable rows and because SQLite cannot drop
   * a NOT NULL column in place.
   *
   * Batched and re-entrant: a crash mid-migration loses one batch, and the next open
   * picks up exactly the rows that still have JSON. That is why the driver is the
   * `NOT EXISTS` anti-join rather than `PRAGMA user_version` alone — version 2 is
   * recorded for future migrations, but this pass is its own repair.
   */
  private migrateVectors(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_vectors (
        memory_id TEXT PRIMARY KEY,
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL,
        norm REAL NOT NULL
      );
    `);
    // ADR-0025: the int8 copy and its per-row scale are added in place. A store
    // written before this version has neither column, so both arrive by ALTER and
    // the backfill below fills them — no rebuild, no data loss, no version flag.
    const cols = this.db.prepare(`PRAGMA table_info(memory_vectors)`).all() as { name: string }[];
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("q8")) this.db.exec(`ALTER TABLE memory_vectors ADD COLUMN q8 BLOB`);
    if (!have.has("scale")) this.db.exec(`ALTER TABLE memory_vectors ADD COLUMN scale REAL`);
    for (;;) {
      const batch = this.db
        .prepare(
          `SELECT id, embedding FROM memories m
            WHERE m.embedding IS NOT NULL AND m.embedding != ''
              AND NOT EXISTS (SELECT 1 FROM memory_vectors v WHERE v.memory_id = m.id)
            LIMIT 5000`
        )
        .all() as { id: string; embedding: string }[];
      if (batch.length === 0) break;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const clear = this.db.prepare(`UPDATE memories SET embedding = '' WHERE id = ?`);
        for (const row of batch) {
          let vec: number[] = [];
          try {
            const parsed = JSON.parse(row.embedding);
            if (Array.isArray(parsed)) vec = parsed as number[];
          } catch {
            vec = [];
          }
          if (vec.length > 0) this.writeVectorSync(row.id, vec);
          clear.run(row.id);
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
        throw err;
      }
      if (batch.length < 5000) break;
    }
    this.db.exec("PRAGMA user_version = 2");

    // Same driver as above, one column over: rows whose q8 is still NULL were
    // written by a version that predates it (or by a crash mid-backfill). Driving on
    // the data rather than a flag keeps this re-entrant and lets an old database
    // opened by a new binary repair itself on first open.
    for (;;) {
      const batch = this.db
        .prepare(
          `SELECT memory_id, vec FROM memory_vectors WHERE q8 IS NULL LIMIT 5000`
        )
        .all() as { memory_id: string; vec: Buffer }[];
      if (batch.length === 0) break;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const stmt = this.db.prepare(`UPDATE memory_vectors SET q8 = ?, scale = ? WHERE memory_id = ?`);
        for (const row of batch) {
          const { q8, scale } = quantizeVector(unpackVector(row.vec));
          stmt.run(q8, scale, row.memory_id);
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
        throw err;
      }
      if (batch.length < 5000) break;
    }
  }

  /** Vector row write. Caller owns the transaction. */
  private writeVectorSync(id: string, embedding: number[]): void {
    if (!embedding || embedding.length === 0) {
      this.db.prepare(`DELETE FROM memory_vectors WHERE memory_id = ?`).run(id);
      return;
    }
    let norm = 0;
    for (const v of embedding) norm += v * v;
    // ADR-0025: the int8 copy is written in the same statement as the float32 one,
    // so a row can never be visible to a scan without its shortlist representation.
    const { q8, scale } = quantizeVector(embedding);
    this.db
      .prepare(`INSERT OR REPLACE INTO memory_vectors (memory_id, dim, vec, norm, q8, scale) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, embedding.length, packVector(embedding), Math.sqrt(norm), q8, scale);
  }

  /** Full rows for a set of ids, one query. Missing ids are simply absent. */
  private fetchByIds(ids: string[]): Map<string, Row> {
    const out = new Map<string, Row>();
    if (ids.length === 0) return out;
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${ids.map(() => "?").join(", ")})`)
      .all(...(ids as any)) as Row[];
    for (const r of rows) out.set(r.id, r);
    return out;
  }

  /**
   * Attach stored vectors to rows that were read without them. `mmr.ts` needs the
   * vectors of the rows it is diversifying, and `?embedding=true` is a documented
   * API response, so "no embedding in the hot path" must not become "no embedding
   * anywhere" — the scan avoids vectors, the final page does not.
   */
  private attachVectors(memories: Memory[]): Memory[] {
    if (memories.length === 0) return memories;
    const ids = memories.map((m) => m.id);
    const rows = this.db
      .prepare(`SELECT memory_id, vec FROM memory_vectors WHERE memory_id IN (${ids.map(() => "?").join(", ")})`)
      .all(...(ids as any)) as { memory_id: string; vec: Buffer }[];
    const byId = new Map(rows.map((r) => [r.memory_id, r.vec]));
    for (const m of memories) {
      const blob = byId.get(m.id);
      if (blob) m.embedding = Array.from(unpackVector(blob));
    }
    return memories;
  }

  /** Terms for one text: distinct token -> count. Empty for punctuation-only text. */
  private termRows(text: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
    return counts;
  }

  /** Replace this row's posting list. Caller owns the transaction. */
  private indexTermsSync(id: string, text: string): void {
    // Document frequency has to be maintained on both sides of the replacement: the
    // old postings stop counting before they are deleted, or a row that is edited ten
    // times would look ten rows common.
    const old = this.db.prepare(`SELECT token FROM memory_terms WHERE memory_id = ?`).all(id) as { token: string }[];
    if (old.length > 0) this.bumpDf(old.map((r) => r.token), -1);
    this.db.prepare(`DELETE FROM memory_terms WHERE memory_id = ?`).run(id);
    const stmt = this.db.prepare(`INSERT INTO memory_terms (token, memory_id, tf) VALUES (?, ?, ?)`);
    const terms = this.termRows(text);
    for (const [token, tf] of terms) stmt.run(token, id, tf);
    if (terms.size > 0) this.bumpDf(terms.keys(), 1);
  }

  /**
   * `term_df` is the document frequency of every token, kept next to the postings
   * (ADR-0019). Counting it with `GROUP BY token` per search meant scanning the
   * postings of every query word — on a 10k-row store that was 103 ms per search,
   * more than the vector scan it was meant to complement.
   */
  private bumpDf(tokens: Iterable<string>, delta: 1 | -1): void {
    if (delta > 0) {
      const stmt = this.db.prepare(
        `INSERT INTO term_df (token, n) VALUES (?, 1) ON CONFLICT(token) DO UPDATE SET n = n + 1`
      );
      for (const token of tokens) stmt.run(token);
    } else {
      const stmt = this.db.prepare(`UPDATE term_df SET n = MAX(0, n - 1) WHERE token = ?`);
      for (const token of tokens) stmt.run(token);
    }
  }

  /** Recompute `term_df` from the postings. Used on open (legacy files) and after a purge. */
  private rebuildTermDf(): void {
    this.db.exec(`DELETE FROM term_df`);
    this.db.exec(`INSERT INTO term_df (token, n) SELECT token, COUNT(*) FROM memory_terms GROUP BY token`);
  }

  /**
   * Rows written before `term_df` existed open with an empty table. A missing df row
   * would silently drop that token from every lexical query, so the table is rebuilt
   * once from the postings it is supposed to describe.
   */
  private rebuildTermDfIfEmpty(): void {
    const df = (this.db.prepare(`SELECT COUNT(*) AS n FROM term_df`).get() as any).n as number;
    if (df > 0) return;
    const postings = (this.db.prepare(`SELECT COUNT(*) AS n FROM memory_terms`).get() as any).n as number;
    if (postings > 0) this.rebuildTermDf();
  }

  /**
   * Index rows written before this table existed. An existing store opens with
   * an empty memory_terms, and a search that silently lost its lexical half
   * would look like a regression rather than a migration gap. `NOT EXISTS`
   * rather than a marker row, so a crashed write is repaired on the next open
   * instead of leaving one unsearchable memory forever.
   */
  private backfillTerms(): void {
    const missing = this.db
      .prepare(
        `SELECT id, text FROM memories m
         WHERE NOT EXISTS (SELECT 1 FROM memory_terms t WHERE t.memory_id = m.id)
         LIMIT 5000`
      )
      .all() as { id: string; text: string }[];
    if (missing.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of missing) this.indexTermsSync(row.id, row.text);
      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
      throw err;
    }
  }

  /**
   * One-time classification of rows that predate the `kind` column (ADR-0021).
   * Batched in a single transaction: the heuristic is a few regexes per row and
   * 10^5 rows is a one-off cost on the first open after upgrade, not per search.
   */
  private backfillKinds(): void {
    const rows = this.db
      .prepare(`SELECT id, text, type FROM memories WHERE kind = 'note' LIMIT 200000`)
      .all() as { id: string; text: string; type: string }[];
    if (rows.length === 0) return;
    const stmt = this.db.prepare(`UPDATE memories SET kind = ? WHERE id = ?`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const kind = deriveKind(row.text, { type: row.type as any });
        if (kind !== "note") stmt.run(kind, row.id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
      throw err;
    }
  }

  private ensure() {
    if (!this.ready || !this.db) throw new Error("store not initialized — call init()");
  }
  /**
   * Wrap a write in bounded retries. `busy_timeout` already handles the normal
   * case; this covers the concurrent-writer corner where SQLite returns BUSY
   * immediately instead of waiting (e.g. a WAL checkpoint racing a commit).
   */
  private async retryWrite<T>(op: () => Promise<T> | T, attempts = 6): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await op();
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (!/SQLITE_BUSY|database is locked/i.test(msg)) throw err;
        lastErr = err;
        await new Promise((r) => setTimeout(r, 25 * (i + 1)));
      }
    }
    throw lastErr;
  }

  close(): void {
    try { this.db?.close(); } catch {}
    this.ready = false;
  }

  async insert(input: MemoryInput, embedding: number[]): Promise<Memory> {
    this.ensure();
    const mem = this.buildRow(input, embedding);
    const stmt = this.insertStmt();
    // Row + posting list + vector in one transaction: a memory whose terms never
    // landed would be invisible to lexical search while looking perfectly healthy,
    // and a row whose vector is missing is invisible to every search at once.
    await this.retryWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.runInsert(stmt, mem);
        this.indexTermsSync(mem.id, mem.text);
        this.writeVectorSync(mem.id, embedding);
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
        throw err;
      }
    });
    return mem;
  }

  /**
   * Bulk insert in ONE transaction (ADR-0018). Importing a project's history is a
   * thousand writes; at one commit each, 10k rows spent as long on fsync as on
   * anything else. Nothing here reconciles — `saveMany` is the caller that decides
   * that, because the write-time reconcile runs a 5-neighbour search per row and
   * that turns a bulk load quadratic.
   */
  async insertMany(items: { input: MemoryInput; embedding: number[] }[]): Promise<Memory[]> {
    this.ensure();
    if (items.length === 0) return [];
    const stmt = this.insertStmt();
    const made = items.map((it) => this.buildRow(it.input, it.embedding));
    await this.retryWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (let i = 0; i < made.length; i++) {
          this.runInsert(stmt, made[i]);
          this.indexTermsSync(made[i].id, made[i].text);
          this.writeVectorSync(made[i].id, items[i].embedding);
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
        throw err;
      }
    });
    return made;
  }

  private buildRow(input: MemoryInput, embedding: number[]): Memory {
    const now = Date.now();
    return {
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
  }

  private insertStmt(): any {
    return this.db.prepare(
      `INSERT INTO memories (id, namespace, type, project, kind, knowledge_id, knowledge_section, text, embedding, importance, strength, last_used_at, source, tags, supersedes_id, is_deleted, visibility, status, pin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
  }

  private runInsert(stmt: any, mem: Memory): void {
    stmt.run(
      mem.id,
      mem.namespace,
      mem.type,
      mem.project,
      mem.kind,
      mem.knowledgeId,
      mem.knowledgeSection,
      mem.text,
      // ADR-0017: the vector lives in memory_vectors; this column is a marker for
      // rows written before that table existed, never the current representation.
      "",
      mem.importance,
      mem.strength,
      mem.lastUsedAt,
      mem.source ?? null,
      mem.tags ? JSON.stringify(mem.tags) : null,
      mem.supersedesId ?? null,
      mem.isDeleted,
      mem.visibility,
      mem.status,
      mem.pin,
      mem.createdAt,
      mem.updatedAt
    );
  }

  async getById(id: string): Promise<Memory | null> {
    this.ensure();
    const stmt = this.db.prepare(`SELECT * FROM memories WHERE id = ?`);
    const row = stmt.get(id) as Row | undefined;
    return row ? this.attachVectors([memoryFromRow(row)])[0] : null;
  }

  async storedDim(): Promise<number | null> {
    this.ensure();
    // The vector table is the only place a width can now be read from, and its dim
    // column means this no longer parses an embedding just to count its numbers.
    const row = this.db.prepare(`SELECT dim FROM memory_vectors LIMIT 1`).get() as { dim: number } | undefined;
    return row ? row.dim : null;
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
    this.ensure();
    const where: string[] = ["namespace = ?"];
    const params: (string | number)[] = [opts.namespace];
    if (!opts.includeDeleted) where.push("is_deleted = 0");
    if (opts.project !== undefined) {
      if (opts.project === null) where.push("project IS NULL");
      else {
        where.push("project = ?");
        params.push(opts.project);
      }
    }
    if (opts.kind) {
      where.push("kind = ?");
      params.push(opts.kind);
    }
    if (opts.type) {
      where.push("type = ?");
      params.push(opts.type);
    }
    if (opts.knowledge !== undefined) {
      if (opts.knowledge === null) where.push("knowledge_id IS NULL");
      else {
        where.push("knowledge_id = ?");
        params.push(opts.knowledge);
      }
    }
    // governance-lite status filter (ADR-0006)
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    } else {
      if (!opts.includeArchived) where.push("status != 'archived'");
      if (!opts.includeDraft) where.push("status != 'draft'");
    }
    if (opts.query) {
      where.push("text LIKE ?");
      params.push(`%${opts.query}%`);
    }
    const whereSql = where.join(" AND ");
    const totalRow = this.db.prepare(`SELECT COUNT(*) as c FROM memories WHERE ${whereSql}`).get(...(params as any)) as { c: number };
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE ${whereSql} ORDER BY pin DESC, created_at DESC LIMIT ? OFFSET ?`)
      .all(...(params as any), limit, offset) as Row[];
    return { memories: this.attachVectors(rows.map(memoryFromRow)), total: totalRow.c };
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
    this.ensure();
    const { whereSql, params } = candidateWhere(opts, "m");
    // Same two-phase shape as vectorSearch, and the same reason: this pass exists to
    // read a population's cosines, so it must not drag whole rows (text, tags, JSON)
    // through memory to do it.
    const rows = this.db
      .prepare(
        `SELECT v.vec AS vec, v.dim AS dim, v.norm AS norm
           FROM memories m JOIN memory_vectors v ON v.memory_id = m.id
          WHERE ${whereSql}`
      )
      .all(...(params as any)) as { vec: Buffer; dim: number; norm: number }[];
    const q = opts.queryEmbedding;
    const qf = new Float32Array(q);
    let qn = 0;
    for (let i = 0; i < q.length; i++) qn += q[i] * q[i];
    qn = Math.sqrt(qn);
    const cosines: number[] = [];
    for (const r of rows) {
      // Same width rule as the search: a stale row is skipped, not fatal.
      if (r.dim !== q.length) continue;
      cosines.push(cosineFast(qf, qn, unpackVector(r.vec), r.norm));
    }
    return { median: median(cosines), count: cosines.length };
  }

  async distinctNamespaces(opts: { includeDeleted?: boolean } = {}): Promise<string[]> {
    this.ensure();
    // includeDeleted exists for `reembed`: a forgotten row keeps its vector, and
    // restoring it later must not hand the retriever a vector of the wrong width.
    const where = opts.includeDeleted ? "" : "WHERE is_deleted = 0 ";
    const rows = this.db
      .prepare(`SELECT DISTINCT namespace FROM memories ${where}ORDER BY namespace`)
      .all() as { namespace: string }[];
    return rows.map((r) => r.namespace);
  }

  async deleteSoft(id: string): Promise<void> {
    this.ensure();
    const stmt = this.db.prepare(`UPDATE memories SET is_deleted = 1, updated_at = ? WHERE id = ?`);
    await this.retryWrite(() => stmt.run(Date.now(), id));
  }

  async updateEmbedding(id: string, embedding: number[], text: string): Promise<void> {
    this.ensure();
    const stmt = this.db.prepare(`UPDATE memories SET embedding = '', text = ?, updated_at = ? WHERE id = ?`);
    // `reembed` can arrive with different text; the posting list has to follow or
    // lexical search keeps matching the words the row used to have. The vector row
    // is rewritten in the same transaction for the same reason.
    await this.retryWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        stmt.run(text, Date.now(), id);
        this.indexTermsSync(id, text);
        this.writeVectorSync(id, embedding);
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
        throw err;
      }
    });
  }

  async updateMeta(id: string, patch: { status?: string; pin?: number; visibility?: string; isDeleted?: number }): Promise<Memory | null> {
    this.ensure();
    const fields: string[] = [];
    const vals: (string | number)[] = [];
    if (patch.status !== undefined) { fields.push("status = ?"); vals.push(patch.status); }
    if (patch.pin !== undefined) { fields.push("pin = ?"); vals.push(patch.pin); }
    if (patch.visibility !== undefined) { fields.push("visibility = ?"); vals.push(patch.visibility); }
    // Restore support: `forget` is a soft delete, so un-forgetting is a flag flip.
    if (patch.isDeleted !== undefined) { fields.push("is_deleted = ?"); vals.push(patch.isDeleted); }
    // ADR-0023: a sync relabels an adopted pre-v0.7 row without re-embedding, so
    // tags and the two knowledge columns have to be patchable here.
    if (patch.tags !== undefined) { fields.push("tags = ?"); vals.push(JSON.stringify(patch.tags)); }
    if (patch.knowledgeId !== undefined) { fields.push("knowledge_id = ?"); vals.push(patch.knowledgeId); }
    if (patch.knowledgeSection !== undefined) { fields.push("knowledge_section = ?"); vals.push(patch.knowledgeSection); }
    if (fields.length === 0) return this.getById(id);
    fields.push("updated_at = ?"); vals.push(Date.now());
    const stmt = this.db.prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`);
    await this.retryWrite(() => stmt.run(...vals, id));
    return this.getById(id);
  }

  async supersede(oldId: string, newInput: MemoryInput, newEmbedding: number[]): Promise<Memory> {
    this.ensure();
    const old = await this.getById(oldId);
    if (!old) throw new Error(`old memory ${oldId} not found`);
    const created = await this.insert({ ...newInput, supersedesId: oldId }, newEmbedding);
    await this.deleteSoft(oldId);
    return created;
  }

  /**
   * Two-phase vector search (ADR-0017): score ids against vectors only, then read the
   * top-k rows. The previous version read `SELECT *` for the whole partition and
   * parsed every embedding, which at 10^5 rows meant decoding 1.1 GB of digits to
   * return twenty memories. Measured on this store: 279 ms per search at 10k rows,
   * extrapolating to ~2.8 s at 10^5 — against a 700 ms budget.
   */
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
    this.ensure();
    const { whereSql, params } = candidateWhere(opts, "m");
    const q = opts.queryEmbedding;
    if (this.q8Enabled()) {
      const hit = this.vectorSearchQ8(whereSql, params, q, opts.limit);
      if (hit) return hit;
    }
    const rows = this.db
      .prepare(
        `SELECT m.id AS id, v.vec AS vec, v.dim AS dim, v.norm AS norm
           FROM memories m JOIN memory_vectors v ON v.memory_id = m.id
          WHERE ${whereSql}`
      )
      .all(...(params as any)) as { id: string; vec: Buffer; dim: number; norm: number }[];
    const qf = new Float32Array(q);
    let qn = 0;
    for (let i = 0; i < q.length; i++) qn += q[i] * q[i];
    qn = Math.sqrt(qn);
    const scored: { id: string; vectorScore: number; vec: Float32Array }[] = [];
    for (const r of rows) {
      // A row left at the old width by an interrupted "ai-memory reembed" is skipped,
      // not fatal. Without this a single stale row would break every search in its
      // partition; re-embedding is how a store gets back in shape, and searching must
      // not be the thing that crashes while that happens.
      if (r.dim !== q.length) continue;
      const vec = unpackVector(r.vec);
      scored.push({ id: r.id, vectorScore: cosineFast(qf, qn, vec, r.norm), vec });
    }
    scored.sort((a, b) => b.vectorScore - a.vectorScore);
    const top = scored.slice(0, opts.limit);
    const byId = this.fetchByIds(top.map((s) => s.id));
    return top.flatMap((s) => {
      const row = byId.get(s.id);
      if (!row) return [];
      const memory = memoryFromRow(row);
      // The scan already had this vector in hand; reading it back would be a second
      // trip for data the caller (MMR) genuinely needs.
      memory.embedding = Array.from(s.vec);
      return [{ memory, vectorScore: s.vectorScore }];
    });
  }

  /**
   * ADR-0025 rollback lever, defaulting to OFF.
   *
   * Measured on 10k rows at 2048d, same machine and same data: p50 181.6 ms off vs
   * 125.5 ms on (1.45x), which extrapolates to ~1.09 s at 10^5 rows — still over the
   * 700 ms budget, and the q8 + scale columns cost +25% disk at that width
   * (14,112 -> 17,702 bytes/row). A 1.45x that does not reach the target is not worth
   * paying storage for by default, so the faster path is opt-in until an index (not a
   * narrower blob) makes the difference an order of magnitude. See ADR-0026.
   *
   * Set MEMORY_Q8=on (or 1/true) to enable it.
   */
  private q8Enabled(): boolean {
    const v = (process.env.MEMORY_Q8 ?? "").trim().toLowerCase();
    return v === "on" || v === "1" || v === "true";
  }

  /**
   * int8 shortlist + float32 rerank (ADR-0025).
   *
   * Phase A scores the compact int8 copy for the whole candidate set; phase B re-reads
   * the float32 blob for the shortlist only and ranks that exactly. The returned
   * ordering is therefore the *exact* ordering of the shortlist, not an approximation of
   * the full set — which is why the multiplier below is 4: the shortlist must be wide
   * enough that nothing genuinely in the top-k is excluded by quantisation noise.
   *
   * What this does and does not buy: the scan reads 4x fewer bytes per row, and that was
   * measured at 1.45x end to end (181.6 -> 125.5 ms at 10k rows / 2048d). It is not more,
   * because per-row object construction and the JOIN dominate that phase and do not care
   * how wide the payload is. Passive behind MEMORY_Q8 (off by default, ADR-0026).
   *
   * Returns null when the fast path cannot answer (a row still missing its q8, or a
   * candidate set smaller than the limit), and the caller falls back to the full scan.
   * A half-populated table is the one case where being slower is strictly better than
   * being wrong.
   */
  private vectorSearchQ8(
    whereSql: string,
    params: (string | number)[],
    q: number[],
    limit: number
  ): { memory: Memory; vectorScore: number }[] | null {
    // Phase A: ids, int8 bytes, scale and the exact norm. No float32 blob.
    const rows = this.db
      .prepare(
        `SELECT m.id AS id, v.q8 AS q8, v.dim AS dim, v.norm AS norm, v.scale AS scale
           FROM memories m JOIN memory_vectors v ON v.memory_id = m.id
          WHERE ${whereSql}`
      )
      .all(...(params as any)) as {
        id: string;
        q8: Uint8Array | null;
        dim: number;
        norm: number;
        scale: number | null;
      }[];
    if (rows.length === 0) return null;
    for (const r of rows) if (r.q8 === null || r.scale === null) return null;

    const qf = new Float32Array(q);
    const qn = vectorNorm(qf);
    const { q8: qq, scale: qScale } = quantizeVector(q);

    const approx: { id: string; approxScore: number }[] = [];
    for (const r of rows) {
      // Width rule is the same as the exact path: a stale row is skipped, not fatal.
      if (r.dim !== q.length) continue;
      approx.push({
        // qn is the FLOAT norm of the query, matching r.norm which is the float norm
        // of the row. Passing the int8 norm here instead would mix units and the
        // ranking collapses (measured: recall@20 = 0).
        id: r.id,
        approxScore: cosineQ8(qq, qScale, qn, unpackQ8(r.q8), r.scale as number, r.norm),
      });
    }
    if (approx.length === 0) return [];
    approx.sort((a, b) => b.approxScore - a.approxScore);

    const shortlistSize = Math.min(approx.length, Math.max(limit * 4, 20 * 4));
    // If the shortlist would cover the whole candidate set there is nothing to
    // save by quantising — the caller's full scan reads the same bytes once.
    if (shortlistSize >= approx.length) return null;

    const shortlist = approx.slice(0, shortlistSize);
    // Phase B: exact float32 rerank over the shortlist only.
    const vecRows = this.db
      .prepare(
        `SELECT memory_id, vec, norm FROM memory_vectors
          WHERE memory_id IN (${shortlist.map(() => "?").join(", ")})`
      )
      .all(...(shortlist.map((s) => s.id) as any)) as {
      memory_id: string;
      vec: Buffer;
      norm: number;
    }[];
    const byId = new Map(vecRows.map((r) => [r.memory_id, r]));
    const scored: { id: string; vectorScore: number; vec: Float32Array }[] = [];
    for (const s of shortlist) {
      const vr = byId.get(s.id);
      if (!vr) continue;
      const vec = unpackVector(vr.vec);
      scored.push({ id: s.id, vectorScore: cosineFast(qf, qn, vec, vr.norm), vec });
    }
    scored.sort((a, b) => b.vectorScore - a.vectorScore);
    const top = scored.slice(0, limit);
    const rowsById = this.fetchByIds(top.map((s) => s.id));
    return top.flatMap((s) => {
      const row = rowsById.get(s.id);
      if (!row) return [];
      const memory = memoryFromRow(row);
      memory.embedding = Array.from(s.vec);
      return [{ memory, vectorScore: s.vectorScore }];
    });
  }

  /**
   * Lexical candidate generation (ADR-0012). Ranking here only decides which
   * rows get to enter the union and in what order they are considered; the
   * retriever re-scores every candidate with bm25Score against its own
   * weights, so this score never reaches the caller. That is why plain tf-idf
   * is enough: no length normalisation, no k1/b, no second opinion to keep in
   * sync with bm25.ts.
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
    this.ensure();
    const tokens = [...new Set(tokenize(opts.query))].slice(0, LEXICAL_TOKEN_LIMIT);
    if (tokens.length === 0) return [];
    // Rarity first. On a 10^5-row store a query's common words ("the", "did") have
    // postings longer than the result list; summing all sixty-four of them was
    // measured at 118 ms per search at 10k rows — 1.2 s at 10^5. The eight rarest
    // words are what actually identify the row, and this is also the shape the
    // recall probe asked for. The score is only ever used to order the union; the
    // retriever re-scores every candidate with real BM25 and idf.
    //
    // `term_df` is maintained in the write transaction, so this is eight primary-key
    // lookups instead of a GROUP BY over the postings of every query word.
    const dfRows = this.db
      .prepare(`SELECT token, n FROM term_df WHERE token IN (${tokens.map(() => "?").join(", ")}) AND n > 0`)
      .all(...(tokens as any)) as { token: string; n: number }[];
    if (dfRows.length === 0) return [];
    // Words that appear in more than a third of the live store cannot single a row
    // out: BM25's idf for them is near zero, and aggregating their postings is the
    // single largest cost of this query. Skipped above a threshold (`MIN_ROWS_FOR_DF_CAP`)
    // so a small store keeps the exact v0.4 behaviour and the tests that pin it.
    const live = (this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE is_deleted = 0`).get() as any).n as number;
    const cap = live >= MIN_ROWS_FOR_DF_CAP ? Math.floor(live * DF_CAP_RATIO) : Number.MAX_SAFE_INTEGER;
    const chosen = dfRows
      .filter((r) => r.n <= cap)
      .sort((a, b) => a.n - b.n)
      .slice(0, LEXICAL_RAREST_K);
    if (chosen.length === 0) return [];
    const marks = chosen.map(() => "?").join(", ");
    const { whereSql, params } = candidateWhere(opts, "m");
    // Driven by the token index, not by a materialised list of every eligible id:
    // the scan starts at `memory_terms` for eight rare tokens and only then touches
    // `memories` for the filters, so its cost tracks how rare the words are instead
    // of how large the partition is. Their df comes in as a literal list because it
    // was just read from `term_df`.
    const dfList = chosen.map(() => "SELECT ? AS token, ? AS n").join(" UNION ALL ");
    const dfParams = chosen.flatMap((r) => [r.token, r.n]);
    const rows = this.db
      .prepare(
        `SELECT t.memory_id AS id, SUM(t.tf * 1.0 / df.n) AS score
           FROM memory_terms t
           JOIN (${dfList}) df ON df.token = t.token
           JOIN memories m ON m.id = t.memory_id
          WHERE ${whereSql}
          GROUP BY t.memory_id
          ORDER BY score DESC, t.memory_id
          LIMIT ?`
      )
      .all(...(dfParams as any), ...(params as any), opts.limit) as { id: string; score: number }[];
    if (rows.length === 0) return [];
    const byId = this.fetchByIds(rows.map((r) => r.id));
    const memories: Memory[] = [];
    const scores: number[] = [];
    for (const r of rows) {
      const row = byId.get(r.id);
      if (!row) continue;
      memories.push(memoryFromRow(row));
      scores.push(r.score);
    }
    this.attachVectors(memories);
    return memories.map((memory, i) => ({ memory, lexicalScore: scores[i] }));
  }

  /**
   * R2. One statement, no read-modify-write: two agents reinforcing the same
   * memory at once both land, because SQLite does the arithmetic.
   */
  async reinforce(ids: string[]): Promise<number> {
    this.ensure();
    const unique = [...new Set(ids)];
    if (unique.length === 0) return 0;
    const now = Date.now();
    // One statement, no read-modify-write: two agents reinforcing the same memory at
    // once both land, because SQLite does the arithmetic. Batched into a single
    // UPDATE because a search reinforces what it returns, and one commit per hit put
    // five fsyncs on the read path.
    const res = await this.retryWrite(() =>
      this.db
        .prepare(
          `UPDATE memories SET strength = MIN(0.95, strength + 0.02), last_used_at = ?, updated_at = ?
            WHERE id IN (${unique.map(() => "?").join(", ")}) AND is_deleted = 0`
        )
        .run(now, now, ...(unique as any))
    );
    return (res as unknown as { changes: number }).changes ?? 0;
  }

  async prune(opts: { olderThanMs: number; maxImportance: number; type?: string; kind?: string }): Promise<number> {
    this.ensure();
    const cutoff = Date.now() - opts.olderThanMs;
    // Age is time-since-last-use where there has been a use, else since creation:
    // recalling an old memory is evidence it is not stale, and it resets the
    // clock without needing a second decay formula.
    //
    // v0.4: eviction needs BOTH numbers, and that is what finally makes decay
    // reachable. This used to test `strength <= maxImportance` alone; since
    // strength starts at the judge's importance (never below 0.4 in a real
    // store) and only rises with use, a 0.3 threshold could never fire — measured
    // on a real 335-row store, decay reclaimed 0 rows while 91.9% had never been
    // read at all. `importance` says "this was never worth much" and `strength`
    // says "and nobody ever came back for it"; requiring both keeps R2's promise
    // that use protects a memory, while a 0.5 threshold can actually match the
    // low-importance rows the rule was written for.
    const where: string[] = [
      "COALESCE(last_used_at, created_at) < ?",
      "importance <= ?",
      "strength <= ?",
      "is_deleted = 0"
    ];
    const params: (string | number)[] = [cutoff, opts.maxImportance, opts.maxImportance];
    if (opts.kind) {
      where.push("kind = ?");
      params.push(opts.kind);
    }
    if (opts.type) {
      where.push("type = ?");
      params.push(opts.type);
    }
    const stmt = this.db.prepare(`UPDATE memories SET is_deleted = 1, updated_at = ? WHERE ${where.join(" AND ")}`);
    const res = await this.retryWrite(() => stmt.run(Date.now(), ...(params as any)));
    return (res as unknown as { changes: number }).changes ?? 0;
  }

  /**
   * Hard-delete tombstones older than `olderThanMs`, with their postings and vectors.
   *
   * Soft delete is for audit (ADR-0006): the row stays, so the reason a memory was
   * removed can still be read. That is also why a store only grows — measured on the
   * real 335-row store, 36 tombstones of 335 rows were 10.7% of it and nothing ever
   * deleted them. Purging is the opt-in other half, and it is a separate call from
   * `prune` on purpose: `prune` must stay reversible, and this must not be.
   */
  async purgeDeleted(opts: { olderThanMs: number }): Promise<number> {
    this.ensure();
    const cutoff = Date.now() - opts.olderThanMs;
    let purged = 0;
    // Chunked: one statement per 5000 ids keeps the parameter list inside SQLite's
    // limits and lets a large purge finish in bounded steps.
    for (;;) {
      const ids = (this.db
        .prepare(`SELECT id FROM memories WHERE is_deleted = 1 AND updated_at < ? LIMIT 5000`)
        .all(cutoff) as { id: string }[]).map((r) => r.id);
      if (ids.length === 0) break;
      const marks = ids.map(() => "?").join(", ");
      await this.retryWrite(() => {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.prepare(`DELETE FROM memory_terms WHERE memory_id IN (${marks})`).run(...(ids as any));
          this.db.prepare(`DELETE FROM memory_vectors WHERE memory_id IN (${marks})`).run(...(ids as any));
          this.db.prepare(`DELETE FROM memories WHERE id IN (${marks})`).run(...(ids as any));
          this.db.exec("COMMIT");
        } catch (err) {
          try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
          throw err;
        }
      });
      purged += ids.length;
    }
    // The postings are gone but `term_df` counted them; one GROUP BY over what is
    // left is cheaper and safer than decrementing token by token after the fact.
    if (purged > 0) this.rebuildTermDf();
    return purged;
  }

  /**
   * Give back the bytes a delete keeps.
   *
   * `prune` only flips `is_deleted`, and a tombstone still carries its text, its
   * postings and its vector; `purgeDeleted` removes the rows but SQLite keeps the
   * pages on a freelist. VACUUM is the rewrite that actually shrinks the file, so the
   * two are meant to be used together: purge, then compact.
   *
   * The size has to be the *footprint*, not `statSync(dbPath)`: the store runs in WAL
   * mode, so recent writes — including the tombstones just created — sit in `-wal`
   * while the main file stays at its last checkpoint (measured: 4 KB main + 1 MB WAL).
   * Checkpointing first folds them in, so the "before" number is the real one; after
   * VACUUM a second checkpoint truncates the WAL the rewrite grew.
   *
   * Deliberately *not* wrapped in `retryWrite`: VACUUM refuses to run inside a
   * transaction and `retryWrite` wraps statements in one.
   */
  async compact(): Promise<{ bytesBefore: number; bytesAfter: number }> {
    this.ensure();
    const footprint = (): number => {
      let total = 0;
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          total += statSync(this.dbPath + suffix).size;
        } catch {
          // A file that does not exist contributes nothing.
        }
      }
      return total;
    };
    // Fold the WAL into the file, then measure: otherwise "before" is the size the
    // file had at the last checkpoint, which is not what is on disk.
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* a busy reader keeps it */ }
    const bytesBefore = footprint();
    this.db.exec("VACUUM");
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* same */ }
    return { bytesBefore, bytesAfter: footprint() };
  }

  /**
   * Knowledge index (ADR-0023). Files stay the truth; this is the capability the
   * sync needs so a page's rows and its links can be updated in place instead of
   * re-inserted on every run.
   */
  get knowledge(): KnowledgeCapability {
    return this as unknown as KnowledgeCapability;
  }

  async listByKnowledge(knowledgeId: string): Promise<Memory[]> {
    this.ensure();
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
          WHERE knowledge_id = ? AND is_deleted = 0
          ORDER BY knowledge_section`
      )
      .all(knowledgeId) as Row[];
    return this.attachVectors(rows.map(memoryFromRow));
  }

  async listKnowledgeIds(): Promise<string[]> {
    this.ensure();
    const rows = this.db
      .prepare(
        `SELECT DISTINCT knowledge_id AS id FROM memories
          WHERE knowledge_id IS NOT NULL AND is_deleted = 0
          ORDER BY knowledge_id`
      )
      .all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  async replaceLinks(from: string, edges: KnowledgeEdge[]): Promise<void> {
    this.ensure();
    const del = this.db.prepare(`DELETE FROM knowledge_links WHERE from_id = ?`);
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO knowledge_links (from_id, to_id, target) VALUES (?, ?, ?)`
    );
    await this.retryWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        del.run(from);
        for (const e of edges) ins.run(from, e.to, e.target);
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        throw err;
      }
    });
  }

  async links(from?: string): Promise<KnowledgeEdge[]> {
    this.ensure();
    const rows = from
      ? (this.db
          .prepare(`SELECT from_id, to_id, target FROM knowledge_links WHERE from_id = ? ORDER BY target`)
          .all(from) as { from_id: string; to_id: string | null; target: string }[])
      : (this.db
          .prepare(`SELECT from_id, to_id, target FROM knowledge_links ORDER BY from_id, target`)
          .all() as { from_id: string; to_id: string | null; target: string }[]);
    return rows.map((r) => ({ from: r.from_id, to: r.to_id ?? null, target: r.target }));
  }
}

type Row = {
  id: string;
  namespace: string;
  type: string;
  project: string | null;
  kind: string | null;
  knowledge_id: string | null;
  knowledge_section: string | null;
  text: string;
  embedding: string;
  importance: number;
  strength: number | null;
  last_used_at: number | null;
  source: string | null;
  tags: string | null;
  supersedes_id: string | null;
  is_deleted: number;
  visibility: string | null;
  status: string | null;
  pin: number | null;
  created_at: number;
  updated_at: number;
};

function memoryFromRow(r: Row): Memory {
  return {
    id: r.id,
    namespace: r.namespace,
    project: r.project ?? null,
    // A DB migrated by an older build may carry the default; `note` is the honest
    // reading of "nobody classified this row yet".
    kind: (r.kind as Memory["kind"]) ?? "note",
    type: r.type as Memory["type"],
    knowledgeId: r.knowledge_id ?? null,
    knowledgeSection: r.knowledge_section ?? null,
    text: r.text,
    // ADR-0017: vectors live in memory_vectors. Call sites that need one (MMR, the
    // &embedding=true response, single-row reads) attach it explicitly; the search
    // scan must not pay for 384 floats per candidate.
    embedding: [],
    importance: r.importance,
    // A column added later can be null in a DB migrated by an older build.
    strength: r.strength ?? r.importance,
    lastUsedAt: r.last_used_at ?? null,
    source: r.source ?? undefined,
    tags: r.tags ? JSON.parse(r.tags) : undefined,
    supersedesId: r.supersedes_id,
    isDeleted: r.is_deleted,
    visibility: (r.visibility as Memory["visibility"]) ?? "private",
    status: (r.status as Memory["status"]) ?? "active",
    pin: r.pin ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}
