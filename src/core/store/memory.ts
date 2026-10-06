import { randomUUID } from "crypto";
import type { Memory, MemoryInput } from "../types.js";
import type { VectorStore } from "./interface.js";
import { cosineSimilarity } from "../embedding/provider.js";

export class InMemoryVectorStore implements VectorStore {
  private map = new Map<string, Memory>();

  async init(): Promise<void> {}
  close(): void {}

  async insert(input: MemoryInput, embedding: number[]): Promise<Memory> {
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
    this.map.set(mem.id, mem);
    return mem;
  }

  async getById(id: string): Promise<Memory | null> {
    return this.map.get(id) ?? null;
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
    let arr = [...this.map.values()].filter((m) => m.namespace === opts.namespace);
    if (!opts.includeDeleted) arr = arr.filter((m) => m.isDeleted === 0);
    if (opts.type) arr = arr.filter((m) => m.type === opts.type);
    if (opts.status) arr = arr.filter((m) => m.status === opts.status);
    else {
      if (!opts.includeArchived) arr = arr.filter((m) => m.status !== "archived");
      if (!opts.includeDraft) arr = arr.filter((m) => m.status !== "draft");
    }
    if (opts.query) arr = arr.filter((m) => m.text.toLowerCase().includes(opts.query!.toLowerCase()));
    const total = arr.length;
    arr.sort((a, b) => (b.pin - a.pin) || (b.createdAt - a.createdAt));
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

  async updateMeta(id: string, patch: { status?: string; pin?: number; visibility?: string; isDeleted?: number }): Promise<Memory | null> {
    const m = this.map.get(id);
    if (!m) return null;
    if (patch.status !== undefined) m.status = patch.status as Memory["status"];
    if (patch.pin !== undefined) m.pin = patch.pin;
    if (patch.visibility !== undefined) m.visibility = patch.visibility as Memory["visibility"];
    if (patch.isDeleted !== undefined) m.isDeleted = patch.isDeleted;
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
  }): Promise<{ memory: Memory; vectorScore: number }[]> {
    let arr = [...this.map.values()].filter((m) => m.namespace === opts.namespace);
    if (!opts.includeDeleted) arr = arr.filter((m) => m.isDeleted === 0);
    if (opts.type) arr = arr.filter((m) => m.type === opts.type);
    if (opts.status) arr = arr.filter((m) => m.status === opts.status);
    else {
      if (!opts.includeArchived) arr = arr.filter((m) => m.status !== "archived");
      if (!opts.includeDraft) arr = arr.filter((m) => m.status !== "draft");
    }
    const scored = arr.map((memory) => ({ memory, vectorScore: cosineSimilarity(opts.queryEmbedding, memory.embedding) }));
    scored.sort((a, b) => b.vectorScore - a.vectorScore);
    return scored.slice(0, opts.limit);
  }

  /** R2. Mirror of the SQL: +0.02, capped, and the use clock reset. */
  async reinforce(ids: string[]): Promise<number> {
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

  async prune(opts: { olderThanMs: number; maxImportance: number; type?: string }): Promise<number> {
    const cutoff = Date.now() - opts.olderThanMs;
    let n = 0;
    for (const m of this.map.values()) {
      // Same rule as the SQL store: clock resets on use, and strength (not the
      // judge's importance) decides.
      if ((m.lastUsedAt ?? m.createdAt) < cutoff && m.strength <= opts.maxImportance && m.isDeleted === 0) {
        if (opts.type && m.type !== opts.type) continue;
        m.isDeleted = 1;
        m.updatedAt = Date.now();
        n++;
      }
    }
    return n;
  }
}
