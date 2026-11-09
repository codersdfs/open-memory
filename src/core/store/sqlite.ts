// @ts-nocheck
import { randomUUID } from "crypto";
import { statSync } from "node:fs";
import type { KnowledgeEdge, Memory, MemoryEvent, MemoryEventKind, MemoryInput, WriteEventMeta } from "../types.js";
import type { KnowledgeCapability, ProjectSummary, VectorStore } from "./interface.js";
import { DF_CAP_RATIO, LEXICAL_RAREST_K, LEXICAL_TOKEN_LIMIT, MIN_ROWS_FOR_DF_CAP, PINNED_ORDER_DF } from "./interface.js";
import { indexTerms, queryTerms } from "../retrieval/terms.js";
import { PartitionCache, type PartitionRow, type PartitionVectors } from "./partitionCache.js";
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
  pendingAfterRefresh,
  planBucketRefresh,
  queryToCentroid,
  type BucketRefreshReport,
} from "./buckets.js";
import { deriveKind } from "../write/kind.js";
import { facetTagsOf, rederiveTags } from "../write/facets.js";
import { extractValidAt, textHash } from "../write/text.js";
import { DROP_LEDGER_CAP, type CurationDrop, type CurationDropInput } from "../write/curation.js";
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
    facet?: string;
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
  // P5 (ADR-0047): the facet slice reads the postings, not the tags column — the same
  // derived state `facetCandidates` ranks over, and the state the self-heal repairs on
  // open. `indexFacetsSync` lowercases, so the filter does too; a value with no postings
  // answers empty, which is information (the marker was resolved or never written), not
  // an error.
  if (opts.facet) {
    where.push(
      `EXISTS (SELECT 1 FROM memory_facets f WHERE f.memory_id = ${col("id")} AND f.facet = ?)`
    );
    params.push(String(opts.facet).toLowerCase());
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


/** Findings worth telling a human about, but not worth throwing over. Once each. */
const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  // stderr, not stdout: `memory recall` prints JSON on stdout and a warning line
  // glued in front of it turns the output into something no caller can parse.
  try {
    process.stderr.write(`open-memory: ${message}\n`);
  } catch {
    // A closed stderr must not turn a fallback into a crash.
  }
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

// ---------------------------------------------------------------------------
// Lexical postings storage.
//
// `memory_terms` + `term_df` is the inverted index: Î£ tf/df over the eight rarest
// query words, which is what orders the candidate union (ADR-0012).
//
// ADR-0031 records why there is no FTS5 arm here. An FTS5 table over the same token
// stream was built, made exactly equivalent to the postings reader (same ids, same
// scores, same filters, verified by tests/fts-lexical.test.ts), and measured slower
// in the only query shape this retriever issues: at 20,000 rows a marker query — one
// rare token plus two topic words, which is what every bench query looks like — took
// 8.0 ms through the postings and 74.9 ms through FTS5. The reason is structural
// rather than a tuning miss: MATCH has to scan for phrase matches to find which rows
// hold the token, while an inverted index answers the same question with an equality
// lookup on a primary key. FTS5 remains tempting because it is in the box (Node's
// bundled SQLite has ENABLE_FTS5) and because its df counter is free, but neither
// fixes the scan, and its B-tree cannot be counted without walking it
// (`COUNT(*) FROM memory_fts` above `COUNT(*) FROM memories`, 2.6 ms vs 0.3 ms at
// 20,000 rows).
// ---------------------------------------------------------------------------

/**
 * Score a decoded partition and keep the top-k without sorting the whole thing.
 *
 * Same arithmetic as the scan (one dot product per row, divided by the same norms),
 * so the answer is identical — the difference is that a full `sort` over 4,000
 * scores to return twenty was measured at 6.6 ms, more than the scoring itself.
 * A bounded insertion keeps a k-long sorted array and drops anything under its
 * floor, which is one comparison per row for the rows that lose.
 */
function topFromPartition(
  partition: PartitionVectors,
  qf: Float32Array,
  qn: number,
  limit: number
): { top: { id: string; vectorScore: number }[]; vecs: Float32Array[] } {
  const { flat, dim, ids, norms, rows } = partition;
  const k = Math.max(1, Math.min(limit, rows));
  const topScore = new Float64Array(k).fill(-Infinity);
  const topRow = new Int32Array(k).fill(-1);
  let filled = 0;
  let floor = -Infinity;
  // `rows`, not `ids.length`: the arrays are allocated in capacity-sized steps so an
  // insert can append in place (ADR-0035), and the tail past `rows` is unused.
  for (let row = 0; row < rows; row++) {
    const off = row * dim;
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += qf[i] * flat[off + i];
    const denom = qn * norms[row];
    const score = denom === 0 ? 0 : dot / denom;
    if (filled < k) {
      let j = filled - 1;
      while (j >= 0 && topScore[j] < score) {
        topScore[j + 1] = topScore[j];
        topRow[j + 1] = topRow[j];
        j--;
      }
      topScore[j + 1] = score;
      topRow[j + 1] = row;
      filled++;
      if (filled === k) floor = topScore[k - 1];
    } else if (score > floor) {
      let j = k - 2;
      while (j >= 0 && topScore[j] < score) {
        topScore[j + 1] = topScore[j];
        topRow[j + 1] = topRow[j];
        j--;
      }
      topScore[j + 1] = score;
      topRow[j + 1] = row;
      floor = topScore[k - 1];
    }
  }
  const top: { id: string; vectorScore: number }[] = [];
  const vecs: Float32Array[] = [];
  for (let i = 0; i < filled; i++) {
    // A hole left by a rewritten row is -1; the caller's fetchByIds would drop it
    // anyway, but skipping here keeps ids and vectors aligned.
    if (topRow[i] < 0) continue;
    top.push({ id: ids[topRow[i]], vectorScore: topScore[i] });
    vecs.push(flat.subarray(topRow[i] * dim, topRow[i] * dim + dim));
  }
  return { top, vecs };
}

/**
 * How many changed ids one catch-up pass will look up before giving up and decoding.
 *
 * The log records ids only, so the store cannot know which of them belong to *this*
 * partition without asking. One indexed query answers for the whole batch and costs
 * the same whether the partition holds 40 rows or 40,000; past a few hundred
 * parameters the batch rivals the read, and a decode also repairs any drift.
 */
const MAX_CATCHUP_ROWS = 1024;

export class SqliteVectorStore implements VectorStore {
  private db: any;
  private dbPath: string;
  private ready = false;
  /**
   * Decoded partitions, so a repeated exact scan does not re-read and re-decode
   * every vector blob. Bounded by MEMORY_VECTOR_CACHE_MB (see partitionCache.ts).
   */
  private vectors = new PartitionCache();
  /**
   * A log of the rows that changed, so a decoded partition can be brought up to
   * date instead of thrown away (ADR-0035).
   *
   * ADR-0034 let an insert leave every partition valid, on the grounds that it
   * touched no row a snapshot holds. That was true and useless: the snapshot then
   * answered without the new row, so a row whose vector equalled the query scored
   * 1.0 through the scan and was invisible through the cache. The log is what makes
   * "leave it valid" also mean "still correct" — the next read sees the id, asks
   * whether it belongs to this partition, and appends it.
   *
   * Not every write belongs here (ADR-0036). A *rewrite* — the row stays, only its
   * numbers move — is described completely by the writer, which holds the new vector,
   * so `noteRewrite` patches it into the snapshots in place and the log never sees it.
   * That is what keeps a `reembed` run from paying a decode per row: measured before
   * the change, one rewrite-plus-search cost 109.8 ms p50 at 20,000 rows and 40
   * rewrites produced 41 misses.
   *
   * What is left is the pair the writer cannot repair in place: an insert adds a row
   * a snapshot is missing, and a delete or re-label removes one it holds. Both are
   * resolved the same way — replay the ids, ask the database which of them match this
   * partition's WHERE clause, and let `absorb` append what is new. So the log records
   * ids and nothing else: no kind, no vector. 4,096 of them cost tens of KB, rather
   * than megabytes of float data most partitions would never ask for.
   */
  private changes: { seq: number; id: string }[] = [];
  private changeSeq = 0;
  /** Trim the log at twice this, so one slice amortises over many writes. */
  private static readonly CHANGE_LOG = 4096;
  /** Prepared once; `node:sqlite` statements are cheap to hold, expensive to rebuild per write. */
  private _eventStmt: any;
  private _dropStmt: any;
  /**
   * P8 (ADR-0048): whether writes mark their bucket pending. Snapshotted in init()
   * because this sits on the hottest write path (`noteChange` runs for every row of
   * every import) and a `process.env` read per write is real money on Windows; every
   * `MEMORY_*` flag in this repo is a process-lifetime knob, and this one is no
   * different — flipping it is a restart, like the provider switch.
   */
  private bucketWritesEnabled = false;
  /**
   * The per-search bucket-universe read, cached against the change log's seq (the
   * same driver the partition cache replays). A search needs the set of projects the
   * candidate population actually spans — data, not summaries — and a warm partition
   * answers it from this field instead of a GROUP BY. Cleared outright by the rare
   * sweeps that move membership without `noteChange` (rename/detach/prune/purge),
   * which are the same sweeps that already clear the vector cache wholesale.
   */
  private bucketUniverse: { seq: number; key: string; projects: (string | null)[] } | null = null;

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
    //
    // The order is load-bearing, from the 2026-11-07 final review: all three PRAGMAs
    // used to share one try/catch, and `journal_mode = WAL` is the one that answers
    // SQLITE_BUSY when another process holds the file — which is exactly what a first
    // open after an upgrade does while a peer's migration transaction is still in
    // flight. Swallowing that error swallowed `busy_timeout` with it, so every later
    // BEGIN IMMEDIATE (the migration sites below) failed instantly with "database is
    // locked" and the process died in init() — measured: a second opener crashed at
    // the `text_hash` site (sqlite.ts:481, pre-fix) ~1 s into a peer's held
    // migration transaction. Set the patience
    // first, and let each remaining setting fall back on its own.
    try {
      this.db.exec("PRAGMA busy_timeout = 5000");
    } catch {
      // A build without the pragma still works; retryWrite() covers the contention.
    }
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
    } catch {
      // Busy behind another writer, or a build without WAL: opening in the file's
      // current journal mode still works, and a later uncontended open switches it.
    }
    try {
      this.db.exec("PRAGMA synchronous = NORMAL");
    } catch {
      // The default FULL is slower, not wrong.
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
    // ADR-0018 amendment (2026-11-07): the exact-duplicate key. A derived column —
    // every write that can change `text` recomputes it (runInsert, updateEmbedding) —
    // backfilled once like `kind`, because hashing 10^5 rows on open is a one-off
    // cost and checking per read would be a per-search one. A NULL hash (only from
    // a foreign writer or an interrupted older migration) reads as "never seen":
    // the worst outcome is a duplicate on a later re-import, never a lost row.
    if (!cols.has("text_hash")) {
      // ALTER and the backfill in ONE transaction — SQLite's DDL is transactional —
      // so a crash rolls the column itself back and the next open re-runs the whole
      // migration, instead of leaving NULL hashes that never get a second pass.
      // `runMigrationTxn` keeps the shape but not the crash: this transaction holds
      // the write lock across the whole-store hash backfill, and an opener racing it
      // (daemon restart plus a first CLI write after an upgrade) must wait, not die.
      await this.runMigrationTxn(`ALTER TABLE memories ADD COLUMN text_hash TEXT`, () => this.backfillTextHashes());
    }
    // P2 (ADR-0016 amendment, 2026-11-07): the retrieval counter the hotness rule
    // reads. Same single-transaction shape as `text_hash` right above — ALTER and
    // the zero-backfill commit together or not at all, so a crash mid-migration
    // rolls the column back and the next open re-runs the whole thing instead of
    // leaving NULLs that never get a second pass. Rows predating the counter get 0:
    // "no evidence of use" is the honest reading, and the floor is what makes the
    // rule safe — a migrated store never looks hotter than it was.
    if (!cols.has("use_count")) {
      await this.runMigrationTxn(`ALTER TABLE memories ADD COLUMN use_count INTEGER`, () =>
        this.db.exec(`UPDATE memories SET use_count = 0 WHERE use_count IS NULL`)
      );
    }
    // P6 (ADR-0045): the event-time clock. `valid_at` is parsed from the row's own
    // `(at:YYYY-MM-DD)` stamp (ADR-0015) — a column for the date that used to be
    // buried in the text, because a timeline you can only reach with LIKE is not a
    // timeline. Same single-transaction shape as `text_hash`/`use_count` above:
    // ALTER and the backfill commit together or not at all, so a crash rolls the
    // column back and the next open re-runs the whole migration. Rows whose text
    // carries no stamp keep NULL — "no match does not move" is the contract; a
    // guessed date would be worse than an admitted unknown.
    if (!cols.has("valid_at")) {
      await this.runMigrationTxn(`ALTER TABLE memories ADD COLUMN valid_at INTEGER`, () => this.backfillValidAt());
    }
    // P6: the invalidation clock, the other half of the pair. Forward writes come
    // only from a supersede (the one UPDATE that flips `is_deleted` also stamps
    // `invalid_at`); the backfill recovers the supersede half for rows already in
    // that state — a superseded row retired at its successor's `created_at` — and
    // deliberately leaves plain tombstones NULL: a forget means "removed", and
    // writing a guess there would corrupt the one honest reading.
    if (!cols.has("invalid_at")) {
      await this.runMigrationTxn(
        `ALTER TABLE memories ADD COLUMN invalid_at INTEGER`,
        () =>
          this.db.exec(`
            UPDATE memories SET invalid_at = (
              SELECT succ.created_at FROM memories succ WHERE succ.supersedes_id = memories.id
              ORDER BY succ.created_at ASC LIMIT 1
            )
            WHERE is_deleted = 1 AND invalid_at IS NULL
              AND EXISTS (SELECT 1 FROM memories succ WHERE succ.supersedes_id = memories.id)
          `)
      );
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
      -- ADR-0018 amendment: the fold lookup seeks on (namespace, hash) — that pair
      -- is selective enough that the project/type/status predicates findExistingHashes
      -- then applies run over a handful of rows, not the partition. The index is
      -- partial because NULL hashes (only ever from a foreign writer) answer no query.
      CREATE INDEX IF NOT EXISTS idx_memories_text_hash ON memories(namespace, text_hash)
        WHERE text_hash IS NOT NULL;
    `);
    // 4. lexical index (ADR-0012). The postings every search reads are derived
    // state: they can always be recomputed from `memories.text`, so a corrupt or
    // stale index is repaired by dropping it, and no migration is needed.
    //
    // `memory_terms` holds one row per (token, memory) with the term frequency;
    // `term_df` holds the document frequency. Both are written by the same code
    // paths (`indexTermsSync`), which is what keeps Î£ tf/df answerable in one SQL
    // GROUP BY — see ADR-0031 for why this stays hand-rolled.
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
    // P4 (ADR-0046): the facet index, the join-key half of `tags`. Same shape as
    // `memory_terms` — a posting list keyed by the joined value, maintained by the
    // same code paths in the same transactions — because it answers the same kind of
    // question ("which rows share this key") and inherits the same crash property:
    // a row and its facets commit together or not at all. `namespace` is carried
    // denormalized so "same entity, this partition" (the P5 conflict window) is one
    // indexed seek without a join; the candidate query still joins `memories` for
    // the rest of its filters, exactly as the lexical arm does.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_facets (
        facet TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        PRIMARY KEY (facet, memory_id)
      );
      CREATE INDEX IF NOT EXISTS idx_facets_memory ON memory_facets(memory_id);
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
    // P2 (ADR-0016 amendment, 2026-11-07): store-level bookkeeping as a small KV,
    // not a column — this describes the file, not any memory, and a maintenance
    // timestamp on 10^5 rows would be the same number 10^5 times. IF NOT EXISTS,
    // like every other table here: the same migration path runs on new and old DBs.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // P6 (ADR-0045): the write history. Append-only by construction — nothing in
    // this file ever UPDATEs or DELETEs from it, and that is the point: the row a
    // hard delete removes is exactly the row whose story has to keep answering.
    // Shape follows mem0's history table (id/memory_id/old_memory/new_memory/event,
    // bench/.venv-mem0/.../storage.py:108-119), minus its `is_deleted` flag — the
    // log here is never soft-deleted, so the flag would always read 0. One row per
    // write point, written in the same transaction as the write it describes.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        event TEXT NOT NULL CHECK (event IN ('insert','reinforce','supersede','archive')),
        old_value TEXT,
        new_value TEXT,
        reason TEXT,
        model TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_memory ON memory_events(memory_id);
    `);
    // The drop ledger (ADR-0040 observability amendment): every write the curation
    // filter refused, with its class, its advice, and a MASKED preview. Its own table,
    // deliberately NOT a memory_events row — an event is keyed by a memory id, and a
    // refused note never gets one. That missing id is the whole reason a dropped note
    // used to leave no trace: the write threw before embed/insert, so there was no row,
    // no id, and nothing to answer "why is this note missing" on the next run.
    // `hash` is normalizeText's sha256 (write/text.ts), so two runs that re-send the
    // same note fold into one count without either having to keep the words.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS curation_drops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL,
        preview TEXT NOT NULL,
        junk TEXT NOT NULL,
        advice TEXT NOT NULL,
        origin TEXT NOT NULL,
        path TEXT NOT NULL,
        namespace TEXT NOT NULL,
        project TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_drops_hash ON curation_drops(hash);
      CREATE INDEX IF NOT EXISTS idx_drops_namespace ON curation_drops(namespace, at);
    `);
    // P8 (ADR-0048): the bucket summaries — one row per (namespace, project), the
    // model-free abstract, the bucket's centroid geometry, and the drift counters.
    // NOT memories: these rows never enter `list`, a search result, or any candidate
    // pool — they are derived state like the postings, rebuilt by the maintenance
    // pass and read only by the vector arm behind MEMORY_BUCKET_PREFILTER=on.
    // `project` uses '' for the unscoped backlog (the `memories.project IS NULL`
    // rows) because a PRIMARY KEY over a nullable column would let two NULL rows
    // coexist; the mapping lives at the two boundaries (bucketKeyOf / projectOfKey).
    // `embedding` is the bucket's unit centroid (mean row direction), `cos_theta` the
    // covering radius of that cap — together they bound every cosine the bucket's
    // rows can reach, which is what the prefilter's skip rule reads. The summary is
    // written in two shapes: a refresh writes abstract+geometry+counters; a write's
    // pending bump (noteChange) upserts a placeholder with no embedding — both are
    // "stale" to the search path, and stale is the safe state (full scan, never a
    // skip).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_buckets (
        namespace TEXT NOT NULL,
        project TEXT NOT NULL,
        abstract TEXT NOT NULL DEFAULT '',
        dim INTEGER NOT NULL DEFAULT 0,
        embedding BLOB,
        norm REAL NOT NULL DEFAULT 0,
        cos_theta REAL NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        pending INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (namespace, project)
      );
    `);
    this.backfillTerms();
    this.backfillFacets();
    this.rebuildTermDfIfEmpty();
    this.migrateVectors();
    this.ready = true;
    // P8 (ADR-0048): the pending marker is write-path state, so the flag is read once
    // per open — the same one-per-process reading every constructor-time knob uses.
    this.bucketWritesEnabled = bucketPrefilterEnabled();
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

  /**
   * Record that a row may have joined a partition, and drop the snapshots it left.
   *
   * Two different things, which used to be conflated:
   *
   * - The row is *in* a snapshot: the snapshot is wrong in place, so it is marked
   *   stale and the next read decodes again. Nothing can repair that in place,
   *   because an entry has no way to remove a row without compacting the flat array.
   * - The row is in *no* snapshot: this is an insert, the common write, and also a
   *   re-label that may have moved the row *into* a partition. Every entry may now be
   *   missing a row, but none of them is wrong — the log lets each one catch up when
   *   it is next read, at the cost of one memcpy instead of a decode.
   *
   * Bumping a global version for either case (what ADR-0029 did) made a single save
   * invalidate every partition, which is what ADR-0034 measured as 113 ms of decode
   * inside a 125 ms save at 20,000 rows.
   *
   * A `rewrite` does not come through here at all: the writer holds the new vector,
   * so `noteRewrite` patches the snapshots in place (ADR-0036). That keeps a reembed
   * run from paying a decode per row, which is the only reason this log exists in a
   * form that has to be replayed.
   *
   * Called *after* the transaction commits. A write that rolls back must not appear
   * here: the log's whole contract is that the ids in it are in the database.
   */
  private noteChange(id: string): void {
    this.changeSeq++;
    this.changes.push({ seq: this.changeSeq, id });
    if (this.changes.length > SqliteVectorStore.CHANGE_LOG * 2) {
      // Anything older than the tail can no longer be replayed, so a partition that
      // falls further behind than this must be rebuilt. Entries carry their own seq,
      // so the trim is safe: it only makes old entries un-updatable, never wrong.
      this.changes = this.changes.slice(-SqliteVectorStore.CHANGE_LOG);
    }
    // Precise marking: only the partitions that actually held the row lose their
    // decoded data. A blanket clear would make the cache useless under a write burst.
    this.vectors.dropRow(id);
    this.bucketUniverse = null;
    // P8 (ADR-0048): one write marks its bucket pending, so the prefilter treats the
    // bucket as summary-less until the next refresh — a row written moments ago is
    // scanned, never skipped (the ADR-0026 "written moments ago" rule, held at the
    // write path instead of an index update). One statement, upsert: the placeholder
    // it can create carries no embedding, which the search reads as stale → full
    // scan for that bucket. Off unless the feature is on: with the prefilter off
    // this adds nothing to any write, and the table stays empty.
    if (this.bucketWritesEnabled) this.markBucketPending(id);
  }

  /** `''` encodes the unscoped backlog in the bucket key (the PK column is NOT NULL). */
  private static bucketKeyOf(project: string | null | undefined): string {
    return project ?? "";
  }

  private static projectOfKey(key: string): string | null {
    return key === "" ? null : key;
  }

  /**
   * The predicate that selects one bucket's rows inside a candidate WHERE. The
   * unscoped arm matches the empty-string project too — a defensive `OR` no current
   * writer can trigger (`normalizeProject` slugs `""` to null) but the key mapping
   * folds that value into the unscoped bucket, so the scan must fold with it.
   */
  private static bucketWhere(project: string | null): string {
    return project === null ? "(m.project IS NULL OR m.project = '')" : "m.project = ?";
  }

  /**
   * Mark one row's bucket pending (P8, ADR-0048). The bucket is read off the row —
   * `noteChange` is the single choke point every write path already passes, and its
   * callers mostly hold only the id. One primary-key seek plus one upsert, the same
   * order of cost as the history event a write already records; a purged id finds no
   * row and marks nothing (nothing of it remains to scan).
   *
   * The statement stays synchronous on purpose: `noteChange` runs inline after every
   * write, and a fire-and-forget marker would let a search that immediately follows
   * its own save read the bucket table before the marker lands. Lock contention is
   * what busy_timeout (5 s) is set for, so a held write lock makes the marker WAIT,
   * not fail; the failure this catch exists for is the immediate-BUSY corner retryWrite
   * documents (a WAL checkpoint racing a commit). There the fallback is not a warn
   * alone: a lost marker with a surviving summary would make the search TRUST a cap
   * that does not contain the just-written row — the silent-stale shape the prefilter
   * exists to make impossible — so the summary row itself is dropped, which forces
   * full scans for that bucket until the next refresh rebuilds it. When even the drop
   * cannot land, the warning says exactly what is at stake instead of the old, wrong
   * "search falls back to full scans" (which was true only while no summary existed).
   */
  private markBucketPending(id: string): void {
    let bucket: { namespace: string; projectKey: string } | undefined;
    try {
      const row = this.db.prepare(`SELECT namespace, project FROM memories WHERE id = ?`).get(id) as
        | { namespace: string; project: string | null }
        | undefined;
      if (!row) return;
      bucket = { namespace: row.namespace, projectKey: SqliteVectorStore.bucketKeyOf(row.project) };
      this.db
        .prepare(
          `INSERT INTO memory_buckets (namespace, project, abstract, dim, embedding, norm, total, pending, updated_at)
           VALUES (?, ?, '', 0, NULL, 0, 0, 1, 0)
           ON CONFLICT(namespace, project) DO UPDATE SET pending = pending + 1`
        )
        .run(bucket.namespace, bucket.projectKey);
    } catch (err) {
      // A pending marker must never fail a write that already committed.
      const reason = err instanceof Error ? err.message : String(err);
      if (bucket) {
        try {
          this.db
            .prepare(`DELETE FROM memory_buckets WHERE namespace = ? AND project = ?`)
            .run(bucket.namespace, bucket.projectKey);
          warnOnce(
            "bucket-pending-drop",
            `bucket pending marker failed (${reason}); dropped the bucket summary so its bucket scans in full until the next refresh`
          );
          return;
        } catch (dropErr) {
          warnOnce(
            "bucket-pending",
            `bucket pending marker failed and the stale summary could not be dropped — the bucket may be served ` +
            `from its previous summary until the next refresh: ${dropErr instanceof Error ? dropErr.message : String(dropErr)}`
          );
          return;
        }
      }
      warnOnce("bucket-pending-seek", `bucket pending marker skipped, row unreadable: ${reason}`);
    }
  }

  /** The projects the candidate population spans — data, not summaries (a missing summary must be visible). */
  private bucketUniverseProjects(whereSql: string, params: (string | number)[]): (string | null)[] {
    // The key carries the bound values, not just the clause text: two partitions share
    // a WHERE string (`namespace = ?`), and a cache keyed on the text alone would hand
    // one partition's buckets to another.
    const key = `${whereSql}|${JSON.stringify(params)}`;
    if (this.bucketUniverse && this.bucketUniverse.seq === this.changeSeq && this.bucketUniverse.key === key) {
      return this.bucketUniverse.projects;
    }
    // The CASE folds a (never-writable) '' project into the unscoped bucket, the same
    // fold `bucketKeyOf` applies on the write side.
    const projects = (
      this.db
        .prepare(
          `SELECT DISTINCT CASE WHEN m.project IS NULL OR m.project = '' THEN NULL ELSE m.project END AS project
             FROM memories m WHERE ${whereSql}`
        )
        .all(...(params as any)) as { project: string | null }[]
    ).map((r) => r.project);
    this.bucketUniverse = { seq: this.changeSeq, key, projects };
    return projects;
  }

  /** Invalidate the bucket state the rare sweeps strand (see the call sites). */
  private dropBucketsWhere(clause: string, ...params: (string | number)[]): void {
    this.db.prepare(`DELETE FROM memory_buckets WHERE ${clause}`).run(...(params as any));
    this.bucketUniverse = null;
  }

  /**
   * A row's vector was rewritten, and the new vector is in hand (ADR-0036).
   *
   * Patching every snapshot that holds the row keeps them correct *and* warm, so a
   * rewrite costs an O(dim) copy instead of an O(partition) decode. Nothing goes in
   * the log: a snapshot that does not hold the row either has it in the log as an
   * insert (and will read the new vector then) or does not contain it at all.
   *
   * Called after the transaction commits, never inside it — a rolled-back write must
   * not leave a vector in the cache that the database never accepted.
   */
  private noteRewrite(id: string, embedding: number[]): void {
    if (!embedding || embedding.length === 0) {
      this.noteChange(id);
      return;
    }
    let norm = 0;
    for (const v of embedding) norm += v * v;
    this.vectors.patchRow(id, new Float32Array(embedding), Math.sqrt(norm));
  }

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

  /**
   * One history row (P6, ADR-0045). Caller owns the transaction — an event is only
   * truthful when it commits with the write it describes; an event that lands after
   * a rollback would report a write the store never accepted.
   */
  private insertEventSync(
    memoryId: string,
    event: MemoryEventKind,
    at: number,
    fields: { oldValue?: string | null; newValue?: string | null; reason?: string | null; model?: string | null } = {}
  ): void {
    this.eventStmt().run(
      memoryId,
      event,
      fields.oldValue ?? null,
      fields.newValue ?? null,
      fields.reason ?? null,
      fields.model ?? null,
      at
    );
  }

  private eventStmt(): any {
    if (!this._eventStmt) {
      this._eventStmt = this.db.prepare(
        `INSERT INTO memory_events (memory_id, event, old_value, new_value, reason, model, at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
    }
    return this._eventStmt;
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
    for (const token of indexTerms(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
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
   * Replace this row's facet postings (P4, ADR-0046). Caller owns the transaction —
   * every call site sits inside the same BEGIN/COMMIT as the write that moved the
   * tags, so a row whose facets drifted from its tags can only come from a writer
   * that bypassed this file, never from a crash. Values are lowercased: derived
   * facets are already slugs, and a caller-supplied `entity:Foo` joins `entity:foo`.
   */
  private indexFacetsSync(id: string, namespace: string, tags: string[] | undefined): void {
    this.db.prepare(`DELETE FROM memory_facets WHERE memory_id = ?`).run(id);
    const facets = facetTagsOf(tags);
    if (facets.length === 0) return;
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO memory_facets (facet, memory_id, namespace) VALUES (?, ?, ?)`);
    for (const facet of facets) stmt.run(facet.toLowerCase(), id, namespace);
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
        `SELECT id, rowid AS rid, text FROM memories m
         WHERE NOT EXISTS (SELECT 1 FROM memory_terms t WHERE t.memory_id = m.id)
         LIMIT 5000`
      )
      .all() as { id: string; rid: number; text: string }[];
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
   * Self-heal for rows whose tags hold facets but whose `memory_facets` postings are
   * missing (P4, ADR-0046) — rows written before the index existed, or by a writer
   * that bypassed these code paths. Same `NOT EXISTS` anti-join shape as
   * `backfillTerms`, for the same reason: no marker row to forget, so a crashed
   * write is repaired on the next open instead of one memory being unfindable by
   * its entity forever.
   *
   * Two differences from `backfillTerms`, and both come from one fact: a ZERO-FACET
   * row is common (casual prose legitimately derives nothing), where a zero-term row
   * is rare. (1) A zero-facet row is a *permanent* member of this anti-join — it will
   * never earn postings — so a LIMIT on the scan itself would let the first 5,000 of
   * them shadow an injured row further down the table on every open, and the self-heal
   * would silently die exactly on the chat-heavy stores this index matters for. The
   * scan is therefore chunked by rowid and runs to exhaustion (or to the write cap);
   * the 5,000 bounds what ONE open *repairs*, never what it *evaluates*, and only an
   * actual repair consumes the budget. (2) Zero-facet rows are skipped before the
   * write transaction opens, so the steady state is a scan per open and no write —
   * not a permanent no-op transaction.
   */
  private backfillFacets(): void {
    const scan = this.db.prepare(
      `SELECT m.rowid AS rid, m.id AS id, m.namespace AS namespace, m.tags AS tags
         FROM memories m
        WHERE m.rowid > ? AND NOT EXISTS (SELECT 1 FROM memory_facets f WHERE f.memory_id = m.id)
        ORDER BY m.rowid
        LIMIT 5000`
    );
    const repairable: { id: string; namespace: string; tags: string[] | undefined }[] = [];
    let cursor = 0;
    for (;;) {
      const rows = scan.all(cursor) as { rid: number; id: string; namespace: string; tags: string | null }[];
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]!.rid;
      for (const row of rows) {
        let tags: string[] | undefined;
        try {
          tags = row.tags ? (JSON.parse(row.tags) as string[]) : undefined;
        } catch {
          tags = undefined; // a foreign writer's malformed JSON is not ours to fix here
        }
        if (facetTagsOf(tags).length === 0) continue; // no facets, no postings, no budget spent
        repairable.push({ id: row.id, namespace: row.namespace, tags });
        if (repairable.length >= 5000) break;
      }
      if (repairable.length >= 5000) break;
    }
    if (repairable.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of repairable) this.indexFacetsSync(row.id, row.namespace, row.tags);
      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
      throw err;
    }
  }

  /**
   * One-time derivation of `text_hash` for rows that predate the column
   * (ADR-0018 amendment). Same shape and same rationale as `backfillKinds`: a
   * sha256 per row is a one-off cost on the first open after upgrade.
   */
  private backfillTextHashes(): void {
    // Called inside the caller's transaction (see the ALTER site). Chunked SELECTs
    // bound the memory — `.all()` on 10^5 rows' text would read the column twice —
    // and the loop runs to empty, so no store is big enough to silently keep NULLs.
    const stmt = this.db.prepare(`UPDATE memories SET text_hash = ? WHERE id = ?`);
    for (;;) {
      const rows = this.db
        .prepare(`SELECT id, text FROM memories WHERE text_hash IS NULL LIMIT 5000`)
        .all() as { id: string; text: string }[];
      if (rows.length === 0) break;
      for (const row of rows) stmt.run(textHash(row.text), row.id);
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

  /**
   * One-time derivation of `valid_at` for rows that predate the column
   * (P6, ADR-0045). Same shape as `backfillTextHashes`: the caller's transaction
   * holds the ALTER, chunked SELECTs bound the memory, and the loop runs to empty —
   * a store is never big enough to silently keep NULLs on rows that do carry a
   * stamp. Rows with no `(at:…)` in the text are left NULL on purpose: the column
   * records what the text states, and inventing a date from `created_at` would
   * blur the two clocks the column exists to separate.
   *
   * Unlike `backfillTextHashes` (whose `textHash` has a value for every text, so
   * every selected row leaves the set the same pass), this loop can select a row it
   * then refuses to update — and a row that stays selected forever means the loop
   * never ends, inside `init()`'s migration write lock. Two independent guards
   * close that (the 2026-11-08 review reproduced the hang with a literal
   * `(at:YYYY-MM-DD)` template in an old store):
   *   - the pre-filter demands the *numeric* shape (GLOB `[0-9]` classes, not LIKE
   *     `_`, which matches any character and let `(at:abcd-ef-gh)` through);
   *   - a pass that updated nothing ends the loop — selected-but-rejected rows are
   *     exactly the "no match does not move" population, so leaving them NULL is
   *     the contract, not a failure to retry.
   */
  private backfillValidAt(): void {
    const stmt = this.db.prepare(`UPDATE memories SET valid_at = ? WHERE id = ?`);
    for (;;) {
      const rows = this.db
        .prepare(
          `SELECT id, text FROM memories
            WHERE valid_at IS NULL
              AND text GLOB '*[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
            LIMIT 5000`
        )
        .all() as { id: string; text: string }[];
      if (rows.length === 0) break;
      let updated = 0;
      for (const row of rows) {
        const at = extractValidAt(row.text);
        if (at !== null) {
          stmt.run(at, row.id);
          updated++;
        }
      }
      // The termination guarantee: a pass with zero updates can never make progress
      // on the next one — the same rows would be selected again. Break instead of
      // holding the migration's write lock forever.
      if (updated === 0) break;
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

  /**
   * A first-open migration transaction — the two ALTER+backfill sites in `init()` —
   * as BEGIN IMMEDIATE, DDL, backfill, COMMIT under `retryWrite`, from the
   * 2026-11-07 final review.
   *
   * These sites used to be bare `exec`s: a daemon restart racing a CLI's first
   * write after an upgrade hit `database is locked` within milliseconds — the
   * migration transaction deliberately holds the write lock across the whole-store
   * `text_hash` backfill (10^5 row hashes can pass one five-second busy wait), and
   * the loser of that race used to die in `service.init()` instead of waiting. The
   * transaction shape (and with it the crash-rolls-back-then-re-run guarantee the
   * sites were built for) is unchanged; only the failure mode moved from throw to
   * wait-and-retry.
   *
   * `duplicate column name` is caught on purpose: two openers can both read the
   * schema as missing the column, and the one that wakes from its lock-wait finds
   * the winner already committed — and the winner's transaction backfilled in the
   * same commit, so "already migrated" is the whole truth and the open proceeds.
   */
  private async runMigrationTxn(ddl: string, afterAlter: () => void): Promise<void> {
    await this.retryWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(ddl);
        afterAlter();
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
        if (/duplicate column name/i.test(String((err as Error)?.message ?? err))) return;
        throw err;
      }
    });
  }

  close(): void {
    try { this.db?.close(); } catch {}
    this.ready = false;
  }

  /**
   * Store-level KV (P2, ADR-0016 amendment): today only `last_maintenance_at` and
   * the last maintenance report, written by the daemon's scheduler and read back by
   * `/stats` after a restart — the point of persisting them is precisely that a
   * restarted daemon can tell whether the store is overdue instead of blind-running.
   */
  async getMeta(key: string): Promise<string | null> {
    this.ensure();
    const row = this.db.prepare(`SELECT value FROM store_meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.ensure();
    await this.retryWrite(() =>
      this.db
        .prepare(`INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(key, value)
    );
  }

  /**
   * Bucket summary refresh (P8, ADR-0048). The threshold decision is `planBucketRefresh`
   * (shared with the in-memory store). The summary itself is local compute over the
   * vectors the store already holds — the unit centroid of the bucket's row
   * directions plus the smallest radius that covers them all (`finishCentroid`) —
   * and the abstract is `buildAbstract` over the newest live rows. No embedder: a
   * refresh never makes a network call, and the geometry is in the same space the
   * rows are by construction.
   *
   * `beforeWrite` is a test seam (not part of the store interface) invoked after a
   * target's geometry is read and before that target's summary is written — the exact
   * per-bucket window the pending-reset race lives in — with the target handed in so
   * a test can put a concurrent write inside ONE bucket's window and pin that the
   * write's drift marker survives the refresh.
   */
  async refreshBucketSummaries(opts: { now?: number; beforeWrite?: (target: { namespace: string; project: string | null }) => void | Promise<void> } = {}): Promise<BucketRefreshReport> {
    this.ensure();
    const now = opts.now ?? Date.now();
    const universe = this.db
      .prepare(
        `SELECT namespace,
                CASE WHEN project IS NULL OR project = '' THEN NULL ELSE project END AS project,
                COUNT(*) AS total
           FROM memories
          WHERE is_deleted = 0 AND status = 'active'
          GROUP BY namespace, CASE WHEN project IS NULL OR project = '' THEN NULL ELSE project END`
      )
      .all() as { namespace: string; project: string | null; total: number }[];
    const existingRows = this.db
      .prepare(`SELECT namespace, project, dim, total, pending FROM memory_buckets`)
      .all() as { namespace: string; project: string; dim: number; total: number; pending: number }[];
    const existing = new Map(existingRows.map((r) => [`${r.namespace}\u0000${r.project}`, r]));
    const planned = planBucketRefresh(
      universe.map((u) => ({ key: `${u.namespace}\u0000${SqliteVectorStore.bucketKeyOf(u.project)}`, total: u.total })),
      new Map(
        [...existing].map(([key, r]) => [key, { dim: r.dim, total: r.total, pending: r.pending }])
      ),
      await this.storedDim()
    );

    // Dropped first: a summary whose bucket holds no live row is a phantom that would
    // spend scan time ranking rows no scan can return.
    for (const key of planned.dropped) {
      const [namespace, project] = key.split("\u0000");
      await this.retryWrite(() =>
        this.db.prepare(`DELETE FROM memory_buckets WHERE namespace = ? AND project = ?`).run(namespace, project)
      );
    }

    const targets = universe.filter(
      (u) => planned.targets.includes(`${u.namespace}\u0000${SqliteVectorStore.bucketKeyOf(u.project)}`)
    );
    const currentDim = await this.storedDim();
    let refreshed = 0;
    for (const t of targets) {
      // The abstract: newest live rows, deterministically — the sample the refresh
      // can cite (kept in the table for diagnostics, never ranked on).
      const rows = this.db
        .prepare(
          `SELECT text FROM memories m
            WHERE m.namespace = ? AND ${SqliteVectorStore.bucketWhere(t.project)}
              AND m.is_deleted = 0 AND m.status = 'active'
            ORDER BY m.created_at DESC, m.id ASC
            LIMIT ?`
        )
        .all(...(t.project === null ? [t.namespace] : [t.namespace, t.project]), BUCKET_ABSTRACT_ROWS) as {
        text: string;
      }[];
      // The geometry: every live row's direction, meaned. Rows at a foreign width
      // (an interrupted reembed) are excluded here exactly as the search path
      // excludes them, so the radius covers precisely the rows a scan can score.
      if (currentDim === null) continue;
      const vectors = this.db
        .prepare(
          `SELECT v.vec AS vec, v.dim AS dim FROM memories m JOIN memory_vectors v ON v.memory_id = m.id
            WHERE m.namespace = ? AND ${SqliteVectorStore.bucketWhere(t.project)}
              AND m.is_deleted = 0 AND m.status = 'active'`
        )
        .all(...(t.project === null ? [t.namespace] : [t.namespace, t.project])) as { vec: Buffer; dim: number }[];
      const usable = vectors.filter((r) => r.dim === currentDim).map((r) => unpackVector(r.vec));
      if (usable.length === 0) continue; // nothing scannable — leave the summary absent
      const acc = accumulateCentroid(currentDim);
      for (const vec of usable) addToCentroid(acc, vec);
      const geo = finishCentroid(acc, 1);
      // The radius: the smallest centroid-to-row cosine, against the finished
      // centroid — the true cap the bound consumes.
      let cosTheta = 1;
      for (const vec of usable) cosTheta = Math.min(cosTheta, queryToCentroid(vec, geo.centroid, geo.norm));
      // The pending baseline, read in the SAME synchronous block as the geometry: it
      // is the drift count the cap about to be stored actually describes. Everything
      // that marks pending from here on is post-snapshot drift the reset below must
      // keep (review, 2026-11-09: an unconditional `pending = 0` inside the retry
      // backoff erased a concurrent write's marker, and the bucket then trusted a
      // cap that did not contain the new row).
      const planKey = `${t.namespace}\u0000${SqliteVectorStore.bucketKeyOf(t.project)}`;
      const planRow = this.db
        .prepare(`SELECT pending, updated_at FROM memory_buckets WHERE namespace = ? AND project = ?`)
        .get(t.namespace, SqliteVectorStore.bucketKeyOf(t.project)) as
        | { pending: number; updated_at: number }
        | undefined;
      const plan = planRow ? { pending: planRow.pending, updatedAt: planRow.updated_at } : null;
      if (opts.beforeWrite) await opts.beforeWrite({ namespace: t.namespace, project: t.project });
      await this.retryWrite(() => {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          // Re-read inside the lock: no writer can commit between this read and the
          // reset, so `pendingAfterRefresh`'s subtraction is atomic against writes.
          const cur = this.db
            .prepare(`SELECT pending, updated_at FROM memory_buckets WHERE namespace = ? AND project = ?`)
            .get(t.namespace, SqliteVectorStore.bucketKeyOf(t.project)) as
            | { pending: number; updated_at: number }
            | undefined;
          const newPending = pendingAfterRefresh(
            plan,
            cur ? { pending: cur.pending, updatedAt: cur.updated_at } : null
          );
          const values = [
            t.namespace,
            SqliteVectorStore.bucketKeyOf(t.project),
            buildAbstract(rows.map((r) => r.text)),
            geo.centroid.length,
            packVector(geo.centroid),
            geo.norm,
            Math.max(-1, cosTheta - BUCKET_RADIUS_SLACK),
            t.total,
            newPending,
            now
          ];
          if (cur) {
            this.db
              .prepare(
                `UPDATE memory_buckets SET abstract = ?, dim = ?, embedding = ?, norm = ?, cos_theta = ?,
                   total = ?, pending = ?, updated_at = ? WHERE namespace = ? AND project = ?`
              )
              .run(
                values[2], values[3], values[4], values[5], values[6],
                values[7], values[8], values[9], values[0], values[1]
              );
          } else {
            this.db
              .prepare(
                `INSERT INTO memory_buckets (namespace, project, abstract, dim, embedding, norm, cos_theta, total, pending, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .run(...(values as any));
          }
          this.db.exec("COMMIT");
        } catch (err) {
          try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
          throw err;
        }
      });
      refreshed++;
    }
    return { refreshed, skipped: planned.skipped, dropped: planned.dropped.length, total: universe.length };
  }

  /** The summary rows without their embedding bytes — the read side for tests and diagnostics. */
  async bucketSummaries() {
    this.ensure();
    const rows = this.db
      .prepare(`SELECT namespace, project, dim, total, pending, embedding, updated_at FROM memory_buckets`)
      .all() as {
      namespace: string;
      project: string;
      dim: number;
      total: number;
      pending: number;
      embedding: Buffer | null;
      updated_at: number;
    }[];
    return rows.map((r) => ({
      namespace: r.namespace,
      project: SqliteVectorStore.projectOfKey(r.project),
      dim: r.dim,
      total: r.total,
      pending: r.pending,
      hasEmbedding: r.embedding !== null && r.embedding.length > 0,
      updatedAt: r.updated_at
    }));
  }

  /**
   * Drop every summary — `reembedAll`'s invalidation (P8, ADR-0048). A provider swap
   * can keep the old width, so the dim check alone would leave old-model cosines
   * ranking new-model queries; no summary is the safe state (full scans everywhere)
   * until the next refresh rebuilds.
   */
  async dropBucketSummaries(): Promise<void> {
    this.ensure();
    await this.retryWrite(() => this.db.exec(`DELETE FROM memory_buckets`));
    this.bucketUniverse = null;
  }

  async insert(input: MemoryInput, embedding: number[]): Promise<Memory> {
    this.ensure();
    const mem = this.buildRow(input, embedding);
    const stmt = this.insertStmt();
    // Row + posting list + vector in one transaction: a memory whose terms never
    // landed would be invisible to lexical search while looking perfectly healthy,
    // and a row whose vector is missing is invisible to every search at once.
    // The insert event rides the same transaction (P6, ADR-0045) — an event that
    // committed without its write, or a write without its event, would both be a
    // history that lies.
    const now = mem.createdAt;
    await this.retryWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.runInsert(stmt, mem);
        this.indexTermsSync(mem.id, mem.text);
        // The facet postings ride the same transaction (P4, ADR-0046): a row whose
        // entity landed in memory_facets while its row rolled back — or the reverse —
        // would join the wrong memories together, which is worse than not joining.
        this.indexFacetsSync(mem.id, mem.namespace, mem.tags);
        this.writeVectorSync(mem.id, embedding);
        this.insertEventSync(mem.id, "insert", now, { newValue: mem.text, reason: input.source ?? null });
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
        throw err;
      }
    });
    // After the commit, never inside: the cache must never hold a vector the database
    // rejected. An insert leaves every decoded partition one row short, and this is
    // what lets each of them learn which row when it is next read (ADR-0035).
    this.noteChange(mem.id);
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
          // Same-transaction facet postings (P4, ADR-0046), one statement per row
          // exactly like the terms above — the bulk path is not a second class of
          // index consistency.
          this.indexFacetsSync(made[i].id, made[i].namespace, made[i].tags);
          this.writeVectorSync(made[i].id, items[i].embedding);
          // One event per row, same transaction as the batch (P6, ADR-0045): a bulk
          // import that left no history would be the one write nobody could audit.
          this.insertEventSync(made[i].id, "insert", made[i].createdAt, {
            newValue: made[i].text,
            reason: items[i].input.source ?? null
          });
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
        throw err;
      }
    });
    // One log entry per row, still after the commit. A bulk load is the case where
    // the log matters most: without it, importing 5,000 rows would leave every
    // decoded partition silently missing all of them (ADR-0035).
    for (const row of made) this.noteChange(row.id);
    return made;
  }

  /**
   * Which of these hashes already have a readable-live row in one partition
   * (ADR-0018 amendment). Chunked at 900 parameters so a 5,000-row import never
   * leans on SQLite's variable limit, and partial-indexed on (namespace, text_hash)
   * so a chunk is a seek, not a scan. The population is what `list()` shows by
   * default — tombstoned, archived and draft rows are excluded on purpose, so a
   * sentence no ordinary search returns can be re-imported — and `project`/`type`
   * confine the fold to one partition so one project's copy never folds another's.
   */
  async findExistingHashes(opts: {
    namespace: string;
    hashes: string[];
    project?: string | null;
    type?: string;
  }): Promise<Set<string>> {
    this.ensure();
    // The readable-live population, same exclusion `list()` applies by default:
    // a row no read can show must not block an import either.
    const extra: string[] = ["is_deleted = 0", "status != 'archived'", "status != 'draft'"];
    const head: (string | number)[] = [opts.namespace];
    if (opts.project !== undefined) {
      if (opts.project === null) extra.push("project IS NULL");
      else {
        extra.push("project = ?");
        head.push(opts.project);
      }
    }
    if (opts.type) {
      extra.push("type = ?");
      head.push(opts.type);
    }
    const found = new Set<string>();
    for (let i = 0; i < opts.hashes.length; i += 900) {
      const chunk = opts.hashes.slice(i, i + 900);
      const rows = this.db
        .prepare(
          `SELECT DISTINCT text_hash FROM memories
           WHERE namespace = ? AND ${extra.join(" AND ")} AND text_hash IN (${chunk.map(() => "?").join(", ")})`
        )
        .all(...head, ...chunk) as { text_hash: string | null }[];
      for (const row of rows) if (row.text_hash) found.add(row.text_hash);
    }
    return found;
  }

  /** `memories` is a rowid table; `last_insert_rowid` is how the FTS row finds its row. */
  private lastRowid(): number {
    return Number((this.db.prepare(`SELECT last_insert_rowid() AS r`).get() as any).r);
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
      // P2: a fresh row has earned nothing yet; the counter only moves on `reinforce`.
      useCount: 0,
      source: input.source,
      tags: input.tags,
      supersedesId: input.supersedesId ?? null,
      isDeleted: 0,
      visibility: input.visibility ?? "private",
      status: input.status ?? "active",
      pin: input.pin ?? 0,
      // P6 (ADR-0045): the event-time clock comes from the text's own stamp, or
      // stays NULL when the text names no date. Derived here, at the one INSERT
      // every write path shares, for the same reason `text_hash` is.
      validAt: extractValidAt(input.text),
      invalidAt: null,
      createdAt: now,
      updatedAt: now
    };
  }

  private insertStmt(): any {
    return this.db.prepare(
      `INSERT INTO memories (id, namespace, type, project, kind, knowledge_id, knowledge_section, text, embedding, importance, strength, last_used_at, source, tags, supersedes_id, is_deleted, visibility, status, pin, created_at, updated_at, text_hash, use_count, valid_at, invalid_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      mem.updatedAt,
      // Derived here, at the one INSERT every write path shares (insert, insertMany,
      // supersede): a hash computed anywhere else is a hash that can drift from its
      // row and silence the wrong insert (ADR-0018 amendment).
      textHash(mem.text),
      mem.useCount,
      mem.validAt,
      mem.invalidAt
    );
  }

  async getById(id: string): Promise<Memory | null> {
    this.ensure();
    const stmt = this.db.prepare(`SELECT * FROM memories WHERE id = ?`);
    const row = stmt.get(id) as Row | undefined;
    return row ? this.attachVectors([memoryFromRow(row)])[0] : null;
  }

  /**
   * The write history of one row (P6, ADR-0045), oldest first. Reads `memory_events`
   * and nothing else, so a purged id still answers with the events that survived it.
   */
  async history(id: string): Promise<MemoryEvent[]> {
    this.ensure();
    const rows = this.db
      .prepare(`SELECT id, memory_id, event, old_value, new_value, reason, model, at FROM memory_events WHERE memory_id = ? ORDER BY id ASC`)
      .all(id) as { id: number; memory_id: string; event: MemoryEventKind; old_value: string | null; new_value: string | null; reason: string | null; model: string | null; at: number }[];
    return rows.map((r) => ({
      id: r.id,
      memoryId: r.memory_id,
      event: r.event,
      oldValue: r.old_value,
      newValue: r.new_value,
      reason: r.reason,
      model: r.model,
      at: r.at
    }));
  }

/**
   * Append one refused write to the drop ledger (ADR-0040 observability). Awaiting
   * signature over a synchronous statement, so the service can call it without a
   * transaction to join: a drop is a diagnostic, not a memory, and never travels with
   * one. Bounded by DROP_LEDGER_CAP — a loop that re-sends the same junk line keeps
   * its trace without growing a table nobody reads. The oldest rows go; a drop carries
   * no fact and no chain, so losing the tail is safe, and `count`/`firstAt` then
   * describe the window still kept rather than all time.
   */
  async recordCurationDrop(drop: CurationDropInput): Promise<void> {
    this.ensure();
    if (!this._dropStmt) {
      this._dropStmt = this.db.prepare(
        `INSERT INTO curation_drops (hash, preview, junk, advice, origin, path, namespace, project, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
    }
    this._dropStmt.run(
      drop.hash, drop.preview, drop.junk, drop.advice, drop.origin, drop.path,
      drop.namespace, drop.project, drop.at
    );
    this.db
      .prepare(`DELETE FROM curation_drops WHERE id <= (SELECT MAX(id) - ? FROM curation_drops)`)
      .run(DROP_LEDGER_CAP);
  }

  /**
   * The drop ledger: ONE row per distinct refused note (folded on its text hash),
   * newest first, each carrying how many times it has been refused and when the first
   * refusal fell. Folding happens in SQL rather than in the service so both stores
   * answer the question the same way, and so a repeat-heavy loop reads as one line —
   * "conversational x4, first dropped Tuesday" — instead of four identical ones.
   */
  async curationDrops(opts: { hash?: string; namespace?: string; junk?: string; since?: number; limit?: number }): Promise<CurationDrop[]> {
    this.ensure();
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.hash) { where.push("hash = ?"); args.push(opts.hash); }
    if (opts.namespace) { where.push("namespace = ?"); args.push(opts.namespace); }
    if (opts.junk) { where.push("junk = ?"); args.push(opts.junk); }
    if (opts.since !== undefined) { where.push("at >= ?"); args.push(opts.since); }
    const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
    const rows = this.db
      .prepare(`
        SELECT * FROM (
          SELECT c.*, COUNT(*) OVER w AS dup_count, MIN(at) OVER w AS first_at,
                 ROW_NUMBER() OVER (PARTITION BY hash ORDER BY id DESC) AS rn
          FROM curation_drops c
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          WINDOW w AS (PARTITION BY hash)
        ) WHERE rn = 1 ORDER BY id DESC LIMIT ?
      `)
      .all(...args, limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      hash: r.hash,
      preview: r.preview,
      junk: r.junk,
      advice: r.advice,
      origin: r.origin,
      path: r.path,
      namespace: r.namespace,
      project: r.project ?? null,
      at: r.at,
      count: r.dup_count,
      firstAt: r.first_at
    }));
  }


  /**
   * Rows whose `supersedes_id` names this id — the forward half of the chain. The
   * partial index `idx_memories_supersedes` makes it a seek. Tombstones included on
   * purpose (see interface.ts): a chain that stops at the first retired row is not
   * the chain.
   */
  async successorsOf(id: string): Promise<Memory[]> {
    this.ensure();
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE supersedes_id = ? ORDER BY created_at ASC, id ASC`)
      .all(id) as Row[];
    return rows.map(memoryFromRow);
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
    facet?: string;
    withVectors?: boolean;
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
    // P5 (ADR-0047): the facet slice, over the postings — the identical EXISTS the
    // candidate reads use through `candidateWhere`, so a filtered page and a filtered
    // search can never disagree about what carries a facet.
    if (opts.facet) {
      where.push(
        `EXISTS (SELECT 1 FROM memory_facets f WHERE f.memory_id = memories.id AND f.facet = ?)`
      );
      params.push(String(opts.facet).toLowerCase());
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
      .prepare(`SELECT * FROM memories WHERE ${whereSql} ORDER BY pin DESC, created_at DESC, id ASC LIMIT ? OFFSET ?`)
      .all(...(params as any), limit, offset) as Row[];
    const memories = rows.map(memoryFromRow);
    // ADR-0030: the knowledge read path lists a partition to build a page tree and
    // never touches an embedding. Joining memory_vectors for it was most of the
    // call's cost, so it is opt-out and defaults to on for every other caller.
    return {
      memories: opts.withVectors === false ? memories : this.attachVectors(memories),
      total: totalRow.c
    };
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
    this.ensure();
    const { whereSql, params } = candidateWhere(opts, "m");
    const q = opts.queryEmbedding;
    const qf = new Float32Array(q);
    let qn = 0;
    for (let i = 0; i < q.length; i++) qn += q[i] * q[i];
    qn = Math.sqrt(qn);
    // This reads the same population vectorSearch reads, so it shares the decode:
    // hybrid.ts calls both on every query, and paying the blob page loads twice was
    // half of why a single search looked so expensive.
    const partition = this.partitionVectors(whereSql, params, q.length);
    const cosines: number[] = [];
    if (partition) {
      const { flat, dim, norms, rows } = partition;
      // `rows`, not `ids.length`: capacity runs ahead of the live rows so an insert
      // can append in place (ADR-0035).
      for (let row = 0; row < rows; row++) {
        const off = row * dim;
        let dot = 0;
        for (let i = 0; i < dim; i++) dot += qf[i] * flat[off + i];
        const denom = qn * norms[row];
        cosines.push(denom === 0 ? 0 : dot / denom);
      }
      return { median: median(cosines), count: cosines.length };
    }
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

  /**
   * One GROUP BY over the dimension, tombstones excluded (ADR-0042). The fold into
   * per-project summaries happens here rather than in SQL so `byKind` stays a plain
   * object and no caller re-walks the rows. Cross-partition by nature: a project
   * spans every namespace that wrote into it, which no `list()` can say.
   */
  async listProjects(): Promise<ProjectSummary[]> {
    this.ensure();
    const rows = this.db
      .prepare(
        `SELECT project, kind, COUNT(*) AS n, MAX(created_at) AS last
           FROM memories
          WHERE is_deleted = 0 AND status = 'active'
          GROUP BY project, kind`
      )
      .all() as { project: string | null; kind: string; n: number; last: number }[];
    const bySlug = new Map<string, ProjectSummary>();
    for (const r of rows) {
      // "\0" cannot appear in a slug, so it cannot collide with a real project.
      const key = r.project ?? "\0unscoped";
      let summary = bySlug.get(key);
      if (!summary) {
        summary = { project: r.project, rows: 0, byKind: {}, lastActivityAt: 0 };
        bySlug.set(key, summary);
      }
      summary.rows += r.n;
      summary.byKind[r.kind] = (summary.byKind[r.kind] ?? 0) + r.n;
      if (r.last > summary.lastActivityAt) summary.lastActivityAt = r.last;
    }
    return [...bySlug.values()].sort(
      (a, b) => b.rows - a.rows || (a.project ?? "").localeCompare(b.project ?? "")
    );
  }

  async renameProject(from: string, to: string): Promise<number> {
    this.ensure();
    const res = await this.retryWrite(() =>
      this.db.prepare(`UPDATE memories SET project = ? WHERE project = ?`).run(to, from)
    );
    // Identity moved, vectors did not: snapshots keyed by the old project (or the
    // new one) answer the wrong membership. Rare sweep, so the prune precedent
    // applies — one clear instead of reading ids back to mark precisely.
    if (res.changes > 0) {
      this.vectors.clear();
      // P8 (ADR-0048): the move also changed which bucket every row belongs to, and
      // it did not pass noteChange (renames deliberately leave updated_at alone).
      // Both slugs' summaries go: a missing summary is the safe state — the next
      // search scans those buckets in full, and the next refresh rebuilds.
      this.dropBucketsWhere("project IN (?, ?)", from, to);
    }
    return res.changes;
  }

  async forgetProject(slug: string, opts: { mode: "detach" | "delete" }): Promise<{ detached: number; deleted: number }> {
    this.ensure();
    if (opts.mode === "detach") {
    const res = await this.retryWrite(() =>
      this.db.prepare(`UPDATE memories SET project = NULL WHERE project = ?`).run(slug)
    );
    if (res.changes > 0) {
      this.vectors.clear();
      // P8 (ADR-0048): detach moves every row into the unscoped bucket without
      // noteChange — same rare-sweep clear as the rename above.
      this.dropBucketsWhere("project = ?", slug);
      this.dropBucketsWhere("project = ?", "");
    }
    return { detached: res.changes, deleted: 0 };
  }
    // Soft delete, like `deleteSoft` per row: the audit trail stays restorable.
    // Tombstones are left as they are — they already left every candidate pool.
    const res = await this.retryWrite(() =>
      this.db
        .prepare(`UPDATE memories SET is_deleted = 1, updated_at = ? WHERE project = ? AND is_deleted = 0`)
        .run(Date.now(), slug)
    );
    if (res.changes > 0) {
      this.vectors.clear();
      // P8 (ADR-0048): the project's rows just left every candidate pool; its summary
      // would rank a phantom bucket until the next refresh. Same sweep clear.
      this.dropBucketsWhere("project = ?", slug);
    }
    return { detached: 0, deleted: res.changes };
  }

  async deleteSoft(id: string): Promise<void> {
    this.ensure();
    // No history row here on purpose (P6, ADR-0045): a plain forget is a tombstone,
    // not one of the four write points, and it deliberately leaves `invalid_at` NULL
    // — "removed" and "stopped being true" are different facts, and only supersede
    // claims the latter.
    const stmt = this.db.prepare(`UPDATE memories SET is_deleted = 1, updated_at = ? WHERE id = ?`);
    await this.retryWrite(() => stmt.run(Date.now(), id));
    // `is_deleted` is part of the candidate WHERE, so the row leaves every partition
    // that held it: those entries are marked stale and decoded again on the next
    // read. Partitions that never held it keep their vectors, which is the ADR-0034
    // point — a write expires what it changed, not what it did not.
    this.noteChange(id);
  }

  async updateEmbedding(id: string, embedding: number[], text: string): Promise<void> {
    this.ensure();
    const stmt = this.db.prepare(
      `UPDATE memories SET embedding = '', text = ?, text_hash = ?, tags = ?, valid_at = ?, updated_at = ? WHERE id = ?`
    );
    // `reembed` can arrive with different text; the posting list has to follow or
    // lexical search keeps matching the words the row used to have. The vector row
    // is rewritten in the same transaction for the same reason — and so are the
    // duplicate hash and the event-time clock, which both describe this row's text
    // now, not the one it had (valid_at recomputes from the new text; no match
    // leaves it NULL — a date the text no longer states is a date it no longer has).
    //
    // P4 (ADR-0046): the facets follow the text too. They were derived from the
    // sentence the row used to be, so a rewritten row re-derives them — the caller's
    // plain tags survive (`rederiveTags`), the `entity:`/`topic:`/`path:` values move
    // to what the new text states — and the tags column and the facet postings are
    // rewritten together, which is what keeps the invariant (facet postings == the
    // row's facet tags) true on this path instead of only at insert time.
    await this.retryWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.db.prepare(`SELECT namespace, tags FROM memories WHERE id = ?`).get(id) as
          | { namespace: string; tags: string | null }
          | undefined;
        if (!row) {
          this.db.exec("COMMIT");
          return; // nothing to update — same contract as the old UPDATE matching zero rows
        }
        const tags = rederiveTags(row.tags ? (JSON.parse(row.tags) as string[]) : undefined, text);
        stmt.run(text, textHash(text), JSON.stringify(tags), extractValidAt(text), Date.now(), id);
        this.indexTermsSync(id, text);
        this.indexFacetsSync(id, row.namespace, tags);
        this.writeVectorSync(id, embedding);
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
        throw err;
      }
    });
    // A rewrite, not a change (ADR-0036): the row keeps its membership and only its
    // numbers move, and this frame holds the new vector. Patching it into the decoded
    // partitions in place is an O(dim) copy; marking them stale instead would make
    // `reembed` — which rewrites every row of a partition in turn — cost a full
    // decode per row, measured at 109.8 ms per rewrite-plus-search at 20,000 rows.
    this.noteRewrite(id, embedding);
  }

  async updateMeta(
    id: string,
    patch: { status?: string; pin?: number; visibility?: string; isDeleted?: number; importance?: number; tags?: string[]; knowledgeId?: string | null; knowledgeSection?: string | null },
    meta?: WriteEventMeta
  ): Promise<Memory | null> {
    this.ensure();
    const fields: string[] = [];
    const vals: (string | number)[] = [];
    if (patch.status !== undefined) { fields.push("status = ?"); vals.push(patch.status); }
    if (patch.pin !== undefined) { fields.push("pin = ?"); vals.push(patch.pin); }
    if (patch.visibility !== undefined) { fields.push("visibility = ?"); vals.push(patch.visibility); }
    // Restore support: `forget` is a soft delete, so un-forgetting is a flag flip.
    if (patch.isDeleted !== undefined) { fields.push("is_deleted = ?"); vals.push(patch.isDeleted); }
    // Retroactive curation (ADR-0040 amendment 2026-11-08): triage sinks a stock
    // row's rank through the same patch method, not a second write path.
    if (patch.importance !== undefined) { fields.push("importance = ?"); vals.push(patch.importance); }
    // ADR-0023: a sync relabels an adopted pre-v0.7 row without re-embedding, so
    // tags and the two knowledge columns have to be patchable here.
    if (patch.tags !== undefined) { fields.push("tags = ?"); vals.push(JSON.stringify(patch.tags)); }
    if (patch.knowledgeId !== undefined) { fields.push("knowledge_id = ?"); vals.push(patch.knowledgeId); }
    if (patch.knowledgeSection !== undefined) { fields.push("knowledge_section = ?"); vals.push(patch.knowledgeSection); }
    if (fields.length === 0) return this.getById(id);
    fields.push("updated_at = ?"); vals.push(Date.now());
    const stmt = this.db.prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`);
    // A tags patch rewrites the row's join keys (P4, ADR-0046): the knowledge sync's
    // relabel and P5's conflict marker both arrive here, so the facet postings are
    // replaced in the same transaction as the tags column — a relabel that committed
    // while the postings still named the old facets would hand the facet arm (and
    // P5's same-entity lookups) rows the tags no longer describe. Every branch below
    // that can carry a tags field therefore reindexes; a patch without one keeps the
    // bare single-statement shape it had.
    if (patch.status === "archived") {
      // The archive write point (P6, ADR-0045): the flip and its history row commit
      // together. The prior status has to be read inside the same transaction — an
      // event recording `active` for a row that was already archived would be a
      // second lie of the same kind as an event without its write. A re-archive is
      // a no-op and writes nothing; a restore (`status` moving anywhere else) is
      // not one of the four write points and records no event.
      const now = Date.now();
      await this.retryWrite(() => {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const row = this.db.prepare(`SELECT status, namespace FROM memories WHERE id = ?`).get(id) as
            | { status: string | null; namespace: string }
            | undefined;
          stmt.run(...vals, id);
          if (row && row.status !== null && row.status !== "archived") {
            this.insertEventSync(id, "archive", now, {
              oldValue: row.status,
              newValue: "archived",
              reason: meta?.reason ?? null
            });
          }
          if (row && patch.tags !== undefined) this.indexFacetsSync(id, row.namespace, patch.tags);
          this.db.exec("COMMIT");
        } catch (err) {
          try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
          throw err;
        }
      });
    } else if (patch.tags !== undefined) {
      await this.retryWrite(() => {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const row = this.db.prepare(`SELECT namespace FROM memories WHERE id = ?`).get(id) as
            | { namespace: string }
            | undefined;
          stmt.run(...vals, id);
          if (row) this.indexFacetsSync(id, row.namespace, patch.tags);
          this.db.exec("COMMIT");
        } catch (err) {
          try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
          throw err;
        }
      });
    } else {
      await this.retryWrite(() => stmt.run(...vals, id));
    }
    // Every patchable field here is either part of the candidate WHERE (status,
    // is_deleted, knowledge_id) or content a caller may read back, so a partition
    // holding the row is no longer a correct snapshot of it. This used to touch no
    // cache state at all, which was a second way to serve a stale answer: archiving
    // a row left it in every decoded partition that had it.
    this.noteChange(id);
    return this.getById(id);
  }

  /**
   * The supersede write point (P6, ADR-0045), all in one transaction: the successor's
   * insert (row, postings, vector, its own insert event), the old row's invalidation
   * — `is_deleted = 1` **and `invalid_at = now` in the same UPDATE** — and the
   * supersede event naming the decision (`reason`) and the judge that made it
   * (`model`). Both halves of the chain move atomically; the previous two-call shape
   * (insert, then `deleteSoft`) left a window where the successor existed but the
   * old row was still live with no history of why.
   */
  async supersede(oldId: string, newInput: MemoryInput, newEmbedding: number[], meta?: WriteEventMeta): Promise<Memory> {
    this.ensure();
    const old = await this.getById(oldId);
    if (!old) throw new Error(`old memory ${oldId} not found`);
    const created = this.buildRow({ ...newInput, supersedesId: oldId }, newEmbedding);
    const stmt = this.insertStmt();
    const now = Date.now();
    await this.retryWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.runInsert(stmt, created);
        this.indexTermsSync(created.id, created.text);
        // The successor's facet postings commit with it (P4, ADR-0046): its tags
        // carry the facets inherited from the row it replaced, and the version
        // chain reads as one entity only while every link in it is indexed.
        this.indexFacetsSync(created.id, created.namespace, created.tags);
        this.writeVectorSync(created.id, newEmbedding);
        this.insertEventSync(created.id, "insert", now, { newValue: created.text, reason: newInput.source ?? null });
        this.db.prepare(`UPDATE memories SET is_deleted = 1, invalid_at = ?, updated_at = ? WHERE id = ?`).run(now, now, oldId);
        this.insertEventSync(oldId, "supersede", now, {
          oldValue: old.text,
          newValue: created.text,
          reason: meta?.reason ?? null,
          model: meta?.model ?? null
        });
        this.db.exec("COMMIT");
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
        throw err;
      }
    });
    // After the commit, never inside — both rows changed membership in every decoded
    // partition (one joined, one left): skipping either is how the cache serves a
    // dead row, the exact regression ADR-0034/0035 were measured on.
    this.noteChange(created.id);
    this.noteChange(oldId);
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
    facet?: string;
  }): Promise<{ memory: Memory; vectorScore: number }[]> {
    this.ensure();
    const { whereSql, params } = candidateWhere(opts, "m");
    const q = opts.queryEmbedding;
    // P8 (ADR-0048): the bucket prefilter, before the exact scan. It answers with the
    // same rows the full scan would (each bucket scan applies the full candidate WHERE
    // plus its own project predicate; the union's top-`limit` over per-bucket top-`limit`
    // lists is the global top-`limit`), so this is a cost path, not a semantics one.
    // Any incapability — feature off, no summaries, undiscriminating summaries, a scan
    // set that covers everything — falls through to the exact path unchanged.
    if (bucketPrefilterEnabled()) {
      const hit = this.vectorSearchBucketed(opts, whereSql, params, q, opts.limit);
      if (hit !== null) return hit;
    }
    const qf = new Float32Array(q);
    let qn = 0;
    for (let i = 0; i < q.length; i++) qn += q[i] * q[i];
    qn = Math.sqrt(qn);

    const { top, vecs } = this.scanCandidates(whereSql, params, qf, qn, opts.limit);
    const byId = this.fetchByIds(top.map((s) => s.id));
    return top.flatMap((s, i) => {
      const row = byId.get(s.id);
      if (!row) return [];
      const memory = memoryFromRow(row);
      // The scan already had this vector in hand; reading it back would be a second
      // trip for data the caller (MMR) genuinely needs.
      memory.embedding = Array.from(vecs[i]);
      return [{ memory, vectorScore: s.vectorScore }];
    });
  }

  /**
   * One exact scan over a resolved candidate WHERE — the body `vectorSearch` has run
   * since ADR-0017, factored out so the bucket prefilter can run it per bucket (P8,
   * ADR-0048). Same two-phase shape, same partition cache (keyed by the bucket-scoped
   * WHERE, so each bucket's decode warms separately), same int8 shortlist when
   * MEMORY_Q8 asks for it: the prefilter narrows *which* rows are scanned, never how
   * a row is scored.
   */
  private scanCandidates(
    whereSql: string,
    params: (string | number)[],
    qf: Float32Array,
    qn: number,
    limit: number
  ): { top: { id: string; vectorScore: number }[]; vecs: Float32Array[] } {
    if (this.q8Enabled()) {
      const hit = this.vectorSearchQ8(whereSql, params, Array.from(qf), limit);
      if (hit) {
        // Same shape as the float path's return; the vectors came back attached to
        // the memories, so they are lifted out of the hit rather than re-read.
        return {
          top: hit.map((h) => ({ id: h.memory.id, vectorScore: h.vectorScore })),
          vecs: hit.map((h) => new Float32Array(h.memory.embedding)),
        };
      }
    }
    const partition = this.partitionVectors(whereSql, params, qf.length);
    return partition ? topFromPartition(partition, qf, qn, limit) : this.scanPartition(whereSql, params, qf, qn, limit);
  }

  /**
   * The bucket prefilter itself (P8, ADR-0048). Per bucket, an UPPER bound on the
   * cosine any of its rows can reach with the query — `bucketScanBound` over the
   * bucket's centroid and its covering radius. Walk the buckets best-bound first,
   * merging each one's top-`limit` into the result; stop at the first bucket whose
   * bound cannot reach the current floor. A skipped bucket provably holds no row
   * that could enter the top-`limit`, so the returned list is the exact scan's list
   * (up to the BUCKET_BOUND_EPS slack, which is float-noise sized, and to the order
   * of exact ties — see the ADR). Returns `null` for the plain exact scan whenever
   * there is nothing to save: one bucket, no summaries yet.
   *
   * The universe comes from the DATA (`bucketUniverseProjects`), never from the
   * summary table — a bucket with no summary is stale and scanned in full, never
   * skipped. Per-bucket scans reuse `scanCandidates`, so a warm bucket costs the
   * partition-cache hit ADR-0029 measured, not a re-decode.
   */
  private vectorSearchBucketed(
    opts: {
      namespace: string;
      queryEmbedding: number[];
      includeDeleted?: boolean;
      status?: string;
      includeArchived?: boolean;
      includeDraft?: boolean;
    },
    whereSql: string,
    params: (string | number)[],
    q: number[],
    limit: number
  ): { memory: Memory; vectorScore: number }[] | null {
    // P8 exactness guard (independent review, 2026-11-08): the summaries describe
    // the DEFAULT population — `is_deleted = 0 AND status = 'active'`, which is what
    // refreshBucketSummaries' universe, abstract and geometry queries all read. A
    // search over a wider one (tombstones via includeDeleted, archived or draft rows
    // via the include flags, any explicit status slice) ranks buckets by caps that do
    // not cover those rows' directions, and a skip there drops true top hits — found
    // by review probe: an archived row was the exact scan's top-1 and ABSENT from the
    // prefiltered result. The contract is "cost time, never rows", so a wider
    // population falls back to the plain exact scan. Narrower filters (type, kind,
    // project, knowledge, facet) need no guard: a cap over a superset still bounds
    // every subset of it.
    if (opts.status !== undefined || opts.includeDeleted || opts.includeArchived || opts.includeDraft) {
      return null;
    }
    const summaries = this.db
      .prepare(`SELECT project, dim, embedding, norm, cos_theta, total, pending FROM memory_buckets WHERE namespace = ?`)
      .all(opts.namespace) as {
      project: string;
      dim: number;
      embedding: Buffer | null;
      norm: number;
      cos_theta: number;
      total: number;
      pending: number;
    }[];
    if (summaries.length === 0) return null; // never warmed — one tiny read, then the exact path

    const qf = new Float32Array(q);
    let qn = 0;
    for (let i = 0; i < q.length; i++) qn += q[i] * q[i];
    qn = Math.sqrt(qn);

    const byKey = new Map(summaries.map((s) => [SqliteVectorStore.bucketKeyOf(s.project), s]));
    const universe = this.bucketUniverseProjects(whereSql, params);
    if (universe.length < 2) return null; // one bucket is the exact scan already

    // Stale = no summary, no embedding yet (a write's placeholder), a summary at
    // another width, a degenerate (zero-norm) centroid, or a bucket with writes
    // since its refresh. All of these scan in full; none of them is ever skipped.
    const fresh: { key: string; bound: number }[] = [];
    const stale: string[] = [];
    for (const project of universe) {
      const key = SqliteVectorStore.bucketKeyOf(project);
      const s = byKey.get(key);
      if (!s || s.embedding === null || s.dim !== q.length || s.norm <= 0 || s.pending > 0) {
        stale.push(key);
        continue;
      }
      const a = queryToCentroid(q, unpackVector(s.embedding), s.norm);
      fresh.push({ key, bound: bucketScanBound(a, s.cos_theta) });
    }
    const order = bucketScanOrder(fresh, stale);

    // Walk. The merged list is re-sorted per bucket so the floor is always the
    // limit-th best score seen; `limit` is ≤ overFetch (20), so this is cheap next
    // to any scan.
    const merged: { id: string; vectorScore: number; vec: Float32Array }[] = [];
    let floor = Number.NEGATIVE_INFINITY;
    for (const step of order) {
      if (merged.length >= limit && !boundCanReachFloor(step.bound, floor)) break;
      const project = SqliteVectorStore.projectOfKey(step.key);
      const bucketWhere = `${whereSql} AND ${SqliteVectorStore.bucketWhere(project)}`;
      const bucketParams = project === null ? params : [...params, project];
      const { top, vecs } = this.scanCandidates(bucketWhere, bucketParams, qf, qn, limit);
      for (let i = 0; i < top.length; i++) merged.push({ ...top[i], vec: vecs[i] });
      if (merged.length > 0) {
        merged.sort((a, z) => z.vectorScore - a.vectorScore || (a.id < z.id ? -1 : a.id > z.id ? 1 : 0));
        if (merged.length > limit) merged.length = limit;
        floor = merged[merged.length - 1]!.vectorScore;
      }
    }
    const top = merged.slice(0, limit);
    if (top.length === 0) return [];
    const byId = this.fetchByIds(top.map((s) => s.id));
    return top.flatMap((s) => {
      const row = byId.get(s.id);
      if (!row) return [];
      const memory = memoryFromRow(row);
      memory.embedding = Array.from(s.vec);
      return [{ memory, vectorScore: s.vectorScore }];
    });
  }

  /**
   * The decoded vectors for one candidate set, or undefined when they are not
   * available and the caller must scan. Warm hits skip SQLite entirely: the
   * measured 18.6 ms of a 4,000-row search was 11.7 ms of blob page loads plus
   * decode, and none of that changes between two searches of an unchanged
   * partition. A miss pays the old cost once and pays 0.8 ms thereafter.
   *
   * A hit is not simply returned: the store's change log may hold rows that arrived
   * after the decode, and an entry that ignores them answers a question about an
   * older store. `catchUp` appends those rows in place, which is a memcpy per row
   * instead of a decode of the whole partition (ADR-0035).
   */
  private partitionVectors(whereSql: string, params: unknown[], dim: number): PartitionVectors | undefined {
    if (!this.vectors.enabled) return undefined;
    const key = `${dim}|${whereSql}|${JSON.stringify(params)}`;
    const cached = this.vectors.get(key);
    if (cached) {
      // A row this snapshot holds was rewritten, deleted or re-labelled: the flat
      // array has a hole in it and no amount of appending repairs that, so the next
      // read decodes. This counts as a miss — `get` already counted a hit, and the
      // stats must not show a healthy hit rate for a partition rebuilt on every
      // search (that was ADR-0034's blind spot).
      if (cached.stale) {
        this.vectors.markStaleMiss();
        return undefined;
      }
      return this.catchUp(key, cached, whereSql, params, dim);
    }
    const seq = this.changeSeq;
    const rows = this.db
      .prepare(
        `SELECT m.id AS id, v.vec AS vec, v.dim AS dim, v.norm AS norm
           FROM memories m JOIN memory_vectors v ON v.memory_id = m.id
          WHERE ${whereSql} ORDER BY m.rowid`
      )
      .all(...(params as any)) as { id: string; vec: Buffer; dim: number; norm: number }[];
    // A row left at the old width by an interrupted "ai-memory reembed" is skipped,
    // not fatal. Without this a single stale row would break every search in its
    // partition; re-embedding is how a store gets back in shape, and searching must
    // not be the thing that crashes while that happens.
    const usable = rows.filter((r) => r.dim === dim);
    const flat = new Float32Array(usable.length * dim);
    const ids: string[] = new Array(usable.length);
    const norms = new Float64Array(usable.length);
    for (let k = 0; k < usable.length; k++) {
      flat.set(unpackVector(usable[k].vec), k * dim);
      ids[k] = usable[k].id;
      norms[k] = usable[k].norm;
    }
    // Rows that changed while this decode was running would be scored from the
    // snapshot; drop the entry instead of serving it. `set` is skipped, so the
    // next call rebuilds.
    if (seq !== this.changeSeq) return undefined;
    // id -> slot, not just a member set: a rewrite patches the vector at the slot it
    // finds here (ADR-0036), and `absorb` needs the same lookup to tell "new row"
    // from "row whose numbers moved".
    const entry: PartitionVectors = {
      key,
      flat,
      dim,
      ids,
      norms,
      rows: usable.length,
      index: new Map(ids.map((id, slot) => [id, slot] as const)),
      stale: false,
      seq,
    };
    this.vectors.set(entry);
    return entry;
  }

  /**
   * Bring a decoded partition up to date with rows that arrived after it was built.
   *
   * The log holds ids only, so the membership question — does this new row belong to
   * *this* partition? — is answered by the database, with the same WHERE clause that
   * built the entry. One query for the whole batch, and it costs the same whether the
   * partition has 40 rows or 40,000, because it seeks by primary key.
   *
   * Returns undefined when the entry cannot be repaired and must be decoded: too far
   * behind the log, or too many rows to append cheaply.
   */
  private catchUp(
    key: string,
    entry: PartitionVectors,
    whereSql: string,
    params: unknown[],
    dim: number
  ): PartitionVectors | undefined {
    if (entry.seq === this.changeSeq) return entry;
    // Pinned before anything is read. `append` records how far the entry has been
    // brought up to date, and the log can grow while the SELECT below is running;
    // using the later value would claim to have absorbed a write this pass never
    // saw, and the row would stay missing until the entry was rebuilt for some
    // other reason. Same rule as the decode path, which samples the counter first.
    const upto = this.changeSeq;
    // The log keeps the last CHANGE_LOG ids. An entry older than its head cannot be
    // replayed, and replaying a partial log would leave rows silently missing.
    const oldest = this.changes[0]?.seq ?? this.changeSeq + 1;
    if (entry.seq < oldest - 1) {
      this.vectors.markStaleMiss();
      return undefined;
    }
    const fresh = new Set<string>();
    for (const change of this.changes) {
      if (change.seq <= entry.seq) continue;
      // A row the entry already holds would be a duplicate in the top-k. The store
      // marks those entries stale, so reaching here means the log outlived a
      // rebuild; treat it as unrecoverable rather than guess.
      if (entry.index.has(change.id)) {
        this.vectors.markStaleMiss();
        return undefined;
      }
      fresh.add(change.id);
    }
    if (fresh.size === 0) return this.vectors.markSynced(key, upto);
    // Absorbing is only worth it while it is cheaper than decoding. Past this many
    // rows the parameters alone rival the read, and a decode also repairs any drift.
    if (fresh.size > MAX_CATCHUP_ROWS) {
      this.vectors.markStaleMiss();
      return undefined;
    }
    const marks = [...fresh].map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT m.id AS id, v.vec AS vec, v.dim AS dim, v.norm AS norm
           FROM memories m JOIN memory_vectors v ON v.memory_id = m.id
          WHERE ${whereSql} AND m.id IN (${marks})`
      )
      .all(...(params as any), ...([...fresh] as any)) as { id: string; vec: Buffer; dim: number; norm: number }[];
    // Rows of another width are not part of this population — the decode skips them
    // too — so they are filtered out rather than treated as an error.
    const absorb: PartitionRow[] = rows
      .filter((r) => r.dim === dim)
      .map((r) => ({ id: r.id, vec: unpackVector(r.vec), norm: r.norm }));
    return this.vectors.absorb(key, absorb, upto);
  }

  /** The exact scan, unchanged: read every vector, score, keep the top-k. */
  private scanPartition(
    whereSql: string,
    params: unknown[],
    qf: Float32Array,
    qn: number,
    limit: number
  ): { top: { id: string; vectorScore: number }[]; vecs: Float32Array[] } {
    const rows = this.db
      .prepare(
        `SELECT m.id AS id, v.vec AS vec, v.dim AS dim, v.norm AS norm
           FROM memories m JOIN memory_vectors v ON v.memory_id = m.id
          WHERE ${whereSql}`
      )
      .all(...(params as any)) as { id: string; vec: Buffer; dim: number; norm: number }[];
    const scored: { id: string; vectorScore: number; vec: Float32Array }[] = [];
    for (const r of rows) {
      if (r.dim !== qf.length) continue;
      const vec = unpackVector(r.vec);
      scored.push({ id: r.id, vectorScore: cosineFast(qf, qn, vec, r.norm), vec });
    }
    scored.sort((a, b) => b.vectorScore - a.vectorScore);
    const top = scored.slice(0, limit);
    return { top, vecs: top.map((s) => s.vec) };
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
    facet?: string;
  }): Promise<{ memory: Memory; lexicalScore: number }[]> {
    this.ensure();
    const tokens = [...new Set(queryTerms(opts.query))].slice(0, LEXICAL_TOKEN_LIMIT);
    if (tokens.length === 0) return [];
    // Rarity first. On a 10^5-row store a query's common words ("the", "did") have
    // postings longer than the result list; summing all sixty-four of them was
    // measured at 118 ms per search at 10k rows — 1.2 s at 10^5. The eight rarest
    // words are what actually identify the row, and this is also the shape the
    // recall probe asked for. The score is only ever used to order the union; the
    // retriever re-scores every candidate with real BM25 and idf.
    //
    // `term_df` is maintained in the write transaction, so this is a primary-key
    // lookup per distinct word (batched into one statement) instead of a GROUP BY
    // over the postings of every query word.
    const dfRows = this.postingsDocumentFrequencies(tokens);
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
    const { whereSql, params } = candidateWhere(opts, "m");
    // ADR-0033: read the postings, not the partition.
    //
    // The obvious query — join the postings to `memories`, filter there, `SUM(tf/df)`,
    // `ORDER BY ... LIMIT` — was measured at 8.46 ms on a 10k-row partition for a
    // query whose rarest word appears in exactly one row. `EXPLAIN QUERY PLAN` says
    // why: SQLite drove it from `idx_memories_ns_deleted` and probed
    // `memory_terms` by (token, memory_id) once per row in the partition, so finding
    // one posting cost ten thousand lookups. Handing the df values in as a
    // `UNION ALL` subquery made it worse, not better — the derived table became the
    // driver.
    //
    // Asking for the postings by token *first* flips the plan to
    // `SEARCH t USING sqlite_autoindex_memory_terms_1 (token=?)` followed by a
    // primary-key lookup per hit: 0.013 ms for the same query. So the df weighting
    // moves into JS, and the filters are applied to the handful of rows the postings
    // actually point at. Same arithmetic in the same order, so the ranking is
    // identical to the old shape — `tests/lexical-shape.test.ts` pins that.
    const picked = this.postingsByToken(chosen, whereSql, params);
    if (picked.length === 0) return [];
    const df = new Map(chosen.map((r) => [r.token, r.n]));
    const totals = new Map<string, number>();
    for (const p of picked) {
      const n = df.get(p.token) ?? 0;
      if (n <= 0) continue;
      totals.set(p.id, (totals.get(p.id) ?? 0) + p.tf / n);
    }
    const rows = [...totals]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, opts.limit);
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
   * Facet candidates (P4, ADR-0046): rows whose stored tags share at least one of the
   * given facets, most shared facets first. Read from the postings, not the partition —
   * the same ADR-0033 shape `lexicalCandidates` uses: seek `memory_facets` by facet
   * value, join `memories` once per hit for the visibility filters, group and cap. The
   * facet values arrive already derived (`deriveFacets` on the query, or a caller's
   * own list for P5), lowercased here because that is how `indexFacetsSync` stores them.
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
    this.ensure();
    const facets = [...new Set(opts.facets.map((f) => String(f ?? "").toLowerCase()).filter((f) => f.length > 0))];
    if (facets.length === 0 || opts.limit <= 0) return [];
    const { whereSql, params } = candidateWhere(opts, "m");
    const marks = facets.map(() => "?").join(", ");
    // GROUP BY over the posting lists: a facet held by a popular entity can have
    // thousands of postings, but the ranked head is what the LIMIT keeps, and the
    // count is one integer per candidate row. Ties break by id, like every other
    // ranked read here — the same query must answer the same way twice.
    const rows = this.db
      .prepare(
        `SELECT f.memory_id AS id, COUNT(*) AS shared
           FROM memory_facets f
           JOIN memories m ON m.id = f.memory_id AND ${whereSql}
          WHERE f.facet IN (${marks})
          GROUP BY f.memory_id
          ORDER BY shared DESC, id ASC
          LIMIT ?`
      )
      .all(...(params as any), ...(facets as any), opts.limit) as { id: string; shared: number }[];
    if (rows.length === 0) return [];
    const byId = this.fetchByIds(rows.map((r) => r.id));
    const wanted = new Set(facets);
    const out: { memory: Memory; sharedFacets: string[] }[] = [];
    for (const r of rows) {
      const row = byId.get(r.id);
      if (!row) continue;
      const memory = memoryFromRow(row);
      // The intersection comes from the row's own tags, not from the postings: the
      // tags column is the source the invariant pins the table to, and reporting
      // what the postings counted would report the index rather than the row.
      const sharedFacets = facetTagsOf(memory.tags)
        .map((t) => t.toLowerCase())
        .filter((t) => wanted.has(t));
      out.push({ memory, sharedFacets: [...new Set(sharedFacets)] });
    }
    this.attachVectors(out.map((o) => o.memory));
    return out;
  }

  /** df of each query token, from `term_df`. */
  private postingsDocumentFrequencies(tokens: string[]): { token: string; n: number }[] {
    return this.db
      .prepare(`SELECT token, n FROM term_df WHERE token IN (${tokens.map(() => "?").join(", ")}) AND n > 0`)
      .all(...(tokens as any)) as { token: string; n: number }[];
  }

  /**
   * The df table's own answer for these tokens (ADR-0028). One batched
   * primary-key read, the same shape `lexicalCandidates` already pays; absent
   * tokens are simply not in the map.
   */
  async termDf(tokens: string[]): Promise<Map<string, number>> {
    this.ensure();
    const wanted = [...new Set(tokens)];
    if (wanted.length === 0) return new Map();
    return new Map(this.postingsDocumentFrequencies(wanted).map((r) => [r.token, r.n]));
  }

  /**
   * Raw (memory_id, token, tf) postings for the given tokens, filtered to rows the
   * caller may see.
   *
   * Two shapes, chosen by how wide the chosen tokens are (ADR-0033):
   *
   * - `CROSS JOIN` pins the join order, so SQLite always seeks the token index and
   *   then looks the row up by primary key. This is what makes a marker-word query
   *   flat instead of linear in the partition: measured at 20k rows, a word held by
   *   one row went from 8.8 ms to 0.005 ms.
   * - A plain `JOIN` lets the planner pick. The pinned order pays one `memories`
   *   probe per posting, so once the chosen words are held by thousands of rows the
   *   planner's own choice — walk the partition index once — can win instead.
   *   Measured at 10k rows / df 2,500: 9.7 ms planner vs 13.2 ms pinned.
   *
   * Both read the same rows and apply the same `whereSql`, so the ranking is
   * identical either way; only the access path changes. The switch is decided from
   * the df read a moment earlier, which `lexicalCandidates` already has in hand.
   */
  private postingsByToken(
    tokens: { token: string; n: number }[],
    whereSql: string,
    params: (string | number)[]
  ): { id: string; token: string; tf: number }[] {
    const marks = tokens.map(() => "?").join(", ");
    const total = tokens.reduce((sum, r) => sum + r.n, 0);
    const sql =
      total <= PINNED_ORDER_DF
        ? `SELECT t.memory_id AS id, t.token AS token, t.tf AS tf
             FROM memory_terms t
            CROSS JOIN memories m
            WHERE t.token IN (${marks}) AND m.id = t.memory_id AND ${whereSql}`
        : `SELECT t.memory_id AS id, t.token AS token, t.tf AS tf
             FROM memory_terms t
             JOIN memories m ON m.id = t.memory_id
            WHERE t.token IN (${marks}) AND ${whereSql}`;
    return this.db
      .prepare(sql)
      .all(...(tokens.map((r) => r.token) as any), ...(params as any)) as { id: string; token: string; tf: number }[];
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
    const res = await this.retryWrite(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // The ids that actually move. The UPDATE's WHERE excludes tombstones, and an
        // event naming a row the write skipped would be a history that lies — one
        // indexed SELECT inside the transaction is what buys the accurate log without
        // opening a read-modify-write race on the numbers (the arithmetic above is
        // still SQLite's, not ours).
        const live = this.db
          .prepare(`SELECT id FROM memories WHERE id IN (${unique.map(() => "?").join(", ")}) AND is_deleted = 0`)
          .all(...(unique as any)) as { id: string }[];
        const out = this.db
          .prepare(
            // P2 (ADR-0016 amendment): `use_count` is the third number a retrieval moves,
            // next to strength and the use clock. COALESCE because a NULL can only come
            // from a foreign writer — the migration backfilled every row it saw — and a
            // NULL must count as "used once from zero", not as a poisoned NULL forever.
            `UPDATE memories SET strength = MIN(0.95, strength + 0.02), use_count = COALESCE(use_count, 0) + 1, last_used_at = ?, updated_at = ?
            WHERE id IN (${unique.map(() => "?").join(", ")}) AND is_deleted = 0`
          )
          .run(now, now, ...(unique as any));
        for (const row of live) {
          // The text did not change, so old/new stay NULL — the event itself is the
          // record of the retrieval (semantics per MemoryEvent in types.ts).
          this.insertEventSync(row.id, "reinforce", now);
        }
        this.db.exec("COMMIT");
        return out;
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
        throw err;
      }
    });
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
    const pruned = (res as unknown as { changes: number }).changes ?? 0;
    // `is_deleted` is part of the candidate WHERE, so a scan stops seeing these rows
    // the moment they are flipped. A decoded partition holds them and was never told:
    // measured with 40 rows all pruned, the cached search still returned the same five
    // memories while the exact scan returned none. This is the bulk form of the same
    // bug ADR-0035 fixed for single writes, and it cannot be fixed the same way —
    // prune returns a count, not the ids, and it is a rare sweep (decay, the daemon),
    // so dropping every decoded partition once is cheaper than reading the ids back.
    if (pruned > 0) {
      this.vectors.clear();
      // P8 (ADR-0048): the sweep also shrank buckets without noteChange. Summaries go
      // wholesale, per the same precedent — a full scan until the next refresh is the
      // correct answer, and the next refresh rebuilds only what it finds.
      await this.retryWrite(() => this.db.exec(`DELETE FROM memory_buckets`));
      this.bucketUniverse = null;
    }
    return pruned;
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
          // The facet postings are derived state like the terms above — a purged row
          // must not keep joining anything (P4, ADR-0046).
          this.db.prepare(`DELETE FROM memory_facets WHERE memory_id IN (${marks})`).run(...(ids as any));
          this.db.prepare(`DELETE FROM memory_vectors WHERE memory_id IN (${marks})`).run(...(ids as any));
          this.db.prepare(`DELETE FROM memories WHERE id IN (${marks})`).run(...(ids as any));
          // `memory_events` is deliberately not in this list (P6, ADR-0045): the
          // purge exists to reclaim a row, and the story of what happened to it —
          // inserts, reinforcements, the supersede that retired it — is the audit
          // half the row cannot take with it. Nothing in this file ever deletes
          // from that table.
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
    if (purged > 0) {
      this.rebuildTermDf();
      // Rows vanished from under every decoded partition; a full clear is cheaper
      // than marking ids that no longer have a row to mark.
      this.vectors.clear();
      this.changes.length = 0;
      this.changeSeq++;
      // P8 (ADR-0048): same sweep shape — the summaries go with the rows that fed
      // them, and the next refresh rebuilds from what is left.
      await this.retryWrite(() => this.db.exec(`DELETE FROM memory_buckets`));
      this.bucketUniverse = null;
    }
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
    // VACUUM rewrites every page, so any decoded partition is at best redundant.
    this.vectors.clear();
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

  /**
   * ADR-0030: the page tree's own query. Two indexed reads replace `list` of the
   * whole partition — every knowledge row of these namespaces, vectors not attached
   * because a page tree only needs ids, section keys and the heading inside the
   * text.
   */
  async listKnowledge(namespaces: string[]): Promise<Memory[]> {
    this.ensure();
    if (namespaces.length === 0) return [];
    const marks = namespaces.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
          WHERE namespace IN (${marks}) AND knowledge_id IS NOT NULL AND is_deleted = 0
            AND status != 'archived' AND status != 'draft'
          ORDER BY knowledge_id, knowledge_section`
      )
      .all(...namespaces) as Row[];
    return rows.map(memoryFromRow);
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
  use_count: number | null;
  source: string | null;
  tags: string | null;
  supersedes_id: string | null;
  is_deleted: number;
  visibility: string | null;
  status: string | null;
  pin: number | null;
  valid_at: number | null;
  invalid_at: number | null;
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
    // P2: like `strength` and `last_used_at`, a column a pre-migration or foreign
    // row can answer NULL for; 0 is the honest "no recorded use".
    useCount: r.use_count ?? 0,
    source: r.source ?? undefined,
    tags: r.tags ? JSON.parse(r.tags) : undefined,
    supersedesId: r.supersedes_id,
    isDeleted: r.is_deleted,
    visibility: (r.visibility as Memory["visibility"]) ?? "private",
    status: (r.status as Memory["status"]) ?? "active",
    pin: r.pin ?? 0,
    // P6 (ADR-0045): columns a pre-migration or foreign row can answer NULL for,
    // like `strength` above — NULL here is the honest "unknown", never a guess.
    validAt: r.valid_at ?? null,
    invalidAt: r.invalid_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}
