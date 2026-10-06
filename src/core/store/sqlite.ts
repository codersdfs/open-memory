// @ts-nocheck
import { randomUUID } from "crypto";
import type { Memory, MemoryInput } from "../types.js";
import type { VectorStore } from "./interface.js";
import { cosineSimilarity } from "../embedding/provider.js";

// Lazy load node:sqlite to avoid vite/vitest static resolve of "node:sqlite"
// (vitest tries to bundle "sqlite" otherwise). We use vite-ignore.
let DatabaseSync: any;
async function getDatabaseSync() {
  if (DatabaseSync) return DatabaseSync;
  const mod = await import(/* @vite-ignore */ "node:sqlite");
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
    // 3. create indexes (after columns guaranteed to exist)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_ns_type ON memories(namespace, type);
      CREATE INDEX IF NOT EXISTS idx_memories_ns_deleted ON memories(namespace, is_deleted);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_supersedes ON memories(supersedes_id);
      CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
    `);
    this.ready = true;
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
    const now = Date.now();
    const mem: Memory = {
      id: randomUUID(),
      namespace: input.namespace,
      type: input.type,
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
    const stmt = this.db.prepare(
      `INSERT INTO memories (id, namespace, type, text, embedding, importance, strength, last_used_at, source, tags, supersedes_id, is_deleted, visibility, status, pin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    await this.retryWrite(() => stmt.run(
      mem.id,
      mem.namespace,
      mem.type,
      mem.text,
      JSON.stringify(mem.embedding),
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
    ));
    return mem;
  }

  async getById(id: string): Promise<Memory | null> {
    this.ensure();
    const stmt = this.db.prepare(`SELECT * FROM memories WHERE id = ?`);
    const row = stmt.get(id) as Row | undefined;
    return row ? memoryFromRow(row) : null;
  }

  async storedDim(): Promise<number | null> {
    this.ensure();
    // ponytail: one row, not a scan. A store written by a single provider has one
    // dim, and this catches exactly the case the guard exists for (a swap). A
    // half-migrated store reports whichever row lands first; add a MIN/MAX sweep
    // here if partial re-embedding is ever implemented.
    const row = this.db.prepare(`SELECT embedding FROM memories WHERE embedding IS NOT NULL LIMIT 1`).get() as
      | { embedding: string }
      | undefined;
    if (!row) return null;
    try {
      const vec = JSON.parse(row.embedding) as number[];
      return Array.isArray(vec) ? vec.length : null;
    } catch {
      return null;
    }
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
  }): Promise<{ memories: Memory[]; total: number }> {
    this.ensure();
    const where: string[] = ["namespace = ?"];
    const params: (string | number)[] = [opts.namespace];
    if (!opts.includeDeleted) where.push("is_deleted = 0");
    if (opts.type) {
      where.push("type = ?");
      params.push(opts.type);
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
    return { memories: rows.map(memoryFromRow), total: totalRow.c };
  }

  async distinctNamespaces(): Promise<string[]> {
    this.ensure();
    const rows = this.db
      .prepare(
        `SELECT DISTINCT namespace FROM memories WHERE is_deleted = 0 ORDER BY namespace`
      )
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
    const stmt = this.db.prepare(`UPDATE memories SET embedding = ?, text = ?, updated_at = ? WHERE id = ?`);
    await this.retryWrite(() => stmt.run(JSON.stringify(embedding), text, Date.now(), id));
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

  async vectorSearch(opts: {
    namespace: string;
    queryEmbedding: number[];
    type?: string;
    limit: number;
    includeDeleted?: boolean;
    status?: string;
    includeArchived?: boolean;
    includeDraft?: boolean;
  }): Promise<{ memory: Memory; vectorScore: number }[]> {
    this.ensure();
    const where: string[] = ["namespace = ?"];
    const params: (string | number)[] = [opts.namespace];
    if (!opts.includeDeleted) where.push("is_deleted = 0");
    if (opts.type) {
      where.push("type = ?");
      params.push(opts.type);
    }
    if (opts.status) {
      where.push("status = ?");
      params.push(opts.status);
    } else {
      if (!opts.includeArchived) where.push("status != 'archived'");
      if (!opts.includeDraft) where.push("status != 'draft'");
    }
    const whereSql = where.join(" AND ");
    const rows = this.db.prepare(`SELECT * FROM memories WHERE ${whereSql}`).all(...(params as any)) as Row[];
    const scored = rows.map((r) => {
      const mem = memoryFromRow(r);
      const vectorScore = cosineSimilarity(opts.queryEmbedding, mem.embedding);
      return { memory: mem, vectorScore };
    });
    scored.sort((a, b) => b.vectorScore - a.vectorScore);
    return scored.slice(0, opts.limit);
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
    const stmt = this.db.prepare(
      `UPDATE memories SET strength = MIN(0.95, strength + 0.02), last_used_at = ?, updated_at = ?
       WHERE id = ? AND is_deleted = 0`
    );
    let n = 0;
    for (const id of unique) {
      const res = await this.retryWrite(() => stmt.run(now, now, id));
      n += (res as unknown as { changes: number }).changes ?? 0;
    }
    return n;
  }

  async prune(opts: { olderThanMs: number; maxImportance: number; type?: string }): Promise<number> {
    this.ensure();
    const cutoff = Date.now() - opts.olderThanMs;
    // Age is time-since-last-use where there has been a use, else since creation:
    // recalling an old memory is evidence it is not stale, and it resets the
    // clock without needing a second decay formula. Strength, not importance, is
    // what reinforcement moves — the judge's write-time number is not the one
    // that should decide eviction.
    const where: string[] = ["COALESCE(last_used_at, created_at) < ?", "strength <= ?", "is_deleted = 0"];
    const params: (string | number)[] = [cutoff, opts.maxImportance];
    if (opts.type) {
      where.push("type = ?");
      params.push(opts.type);
    }
    const stmt = this.db.prepare(`UPDATE memories SET is_deleted = 1, updated_at = ? WHERE ${where.join(" AND ")}`);
    const res = await this.retryWrite(() => stmt.run(Date.now(), ...(params as any)));
    return (res as unknown as { changes: number }).changes ?? 0;
  }
}

type Row = {
  id: string;
  namespace: string;
  type: string;
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
    type: r.type as Memory["type"],
    text: r.text,
    embedding: JSON.parse(r.embedding),
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
