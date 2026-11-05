/**
 * Partition vector cache: what a repeated exact scan costs when the vectors are
 * already decoded.
 *
 * Measured on 4,000 rows x 384d, one partition, this machine — a single
 * `vectorSearch` spent 11.7 ms in `SELECT ... JOIN memory_vectors` and 18.6 ms
 * end to end. Splitting that query apart showed the cost is *touching the blob
 * column at all*, not its width: `SELECT id` alone is 1.3 ms, adding a 4-byte
 * literal blob keeps it at 2.5 ms, but `substr(vec,1,4)` jumps to 8.1 ms and the
 * full 1,536-byte vec to 9.6 ms. SQLite pays a per-row page load for that column
 * no matter how few of its bytes are wanted, so ADR-0025's int8 copy (392 bytes
 * instead of 1,536) saved almost nothing and ADR-0026 was right to shelve it.
 *
 * The fix is not a smaller blob, it is not reading the blob every time. Once a
 * partition is decoded into one flat Float32Array, scoring the same 4,000 rows
 * costs 0.80 ms — most of the old 18.6 ms was re-reading and re-decoding pages
 * that had not changed. Cold still pays the page load (13.0 ms + 0.8 ms score,
 * which is no worse than before), warm is 23x faster, and the arithmetic is
 * identical: same vectors, same cosine, same top-k. No recall is traded away,
 * which is the whole reason this replaced the ANN attempts (ADR-0028 withdrawn).
 *
 * An entry is a snapshot of *which rows matched*, so it goes stale as the store
 * changes, and the interesting question is what to do about that. ADR-0034
 * answered "rewrite or delete" — mark the entry unusable, rebuild once — and then
 * made plain inserts exempt, on the grounds that they touch no row the snapshot
 * holds. That was true and useless: an insert adds a row the snapshot does not
 * contain, so the entry kept answering without it. A row whose vector equalled the
 * query scored 1.0 through the scan and was invisible through the cache.
 *
 * Two things fix that (ADR-0035). An entry now carries a `seq` — how far into the
 * store's change log it has been brought up to date — and `append` adds rows that
 * the log says arrived after the decode, so an insert costs a memcpy instead of a
 * decode. The other half is in the store: a change to a row *already in* a
 * snapshot still marks it stale, because an entry cannot remove a row without
 * compacting the flat array, and a partition that has to be rebuilt anyway can
 * afford to read the blob once.
 *
 * Memory is the price, so it is bounded. Each entry is dim x 4 bytes per row plus
 * ids and norms; the cache evicts least-recently-used partitions until it fits
 * `MEMORY_VECTOR_CACHE_MB` (default 64). A corpus wide enough to blow that budget
 * simply behaves like the old code — slower, never wrong.
 */

/** One decoded partition, laid out so scoring is a flat walk. */
export interface PartitionVectors {
  /** Cache key: the WHERE clause plus its params, i.e. exactly which rows these are. */
  key: string;
  /**
   * Row k occupies flat[k*dim .. k*dim+dim). Allocated in capacity-sized steps so
   * an insert appends instead of reallocating the whole partition, which means the
   * arrays are usually longer than `rows`.
   */
  flat: Float32Array;
  dim: number;
  ids: string[];
  norms: Float64Array;
  /** How many leading slots are live. Iterate this, not `ids.length`. */
  rows: number;
  /**
   * id -> slot. Membership is the common question (`dropRow` on every write,
   * `append` on every insert) and a linear scan of 20,000 ids cost more than the
   * scoring it guards; the slot is what makes a rewrite an O(dim) copy instead of
   * an O(partition) decode (ADR-0036).
   */
  index: Map<string, number>;
  /**
   * A row this snapshot held was rewritten, deleted, or re-labelled, so the
   * snapshot is wrong where it stands and the next read must decode again.
   */
  stale: boolean;
  /** Store change counter this snapshot is caught up to (ADR-0035). */
  seq: number;
}

/** A row that belongs to an already-decoded partition and is missing from it. */
export interface PartitionRow {
  id: string;
  vec: Float32Array;
  norm: number;
}

interface Entry extends PartitionVectors {
  bytes: number;
}

export const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;

export function cacheBudgetBytes(): number {
  const raw = (process.env.MEMORY_VECTOR_CACHE_MB ?? "").trim();
  if (raw === "off" || raw === "0" || raw === "false") return 0;
  const mb = Number(raw);
  if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * 1024 * 1024);
  return DEFAULT_CACHE_BYTES;
}

/**
 * Entries are mutated in place, never copied. The previous version stored a spread
 * copy in `set` while handing the original to `get`, so a caller that wrote through
 * the returned object (ADR-0034 marking an entry stale) wrote to a detached object
 * and the store silently kept serving a snapshot it believed had been dropped.
 */
export class PartitionCache {
  // Insertion order is recency order: get() re-inserts, so the first key is the
  // least recently used one and eviction is "shift the head" (Map preserves it).
  private entries = new Map<string, Entry>();
  private bytes = 0;
  private hit = 0;
  private miss = 0;
  private evictions = 0;
  private readonly budget: number;

  constructor(budget = cacheBudgetBytes()) {
    this.budget = budget;
  }

  get enabled(): boolean {
    return this.budget > 0;
  }

  get(key: string): PartitionVectors | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.miss++;
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hit++;
    return entry;
  }

  /**
   * Charge a rebuild to the miss counter when a `get` hit an entry that turned out
   * to be stale. Without this the stats count a hit for a decode the caller then
   * throws away, which is exactly the signal ADR-0034 needed and did not have: the
   * cache looked warm while every save was rebuilding the partition.
   */
  markStaleMiss(): void {
    this.hit = Math.max(0, this.hit - 1);
    this.miss++;
  }

  set(entry: PartitionVectors): void {
    if (!this.enabled) return;
    const bytes = footprint(entry);
    // A partition larger than the whole budget can never be cached; refuse it
    // rather than evicting everything else and then finding no room.
    if (bytes > this.budget) {
      this.evictions++;
      return;
    }
    const existing = this.entries.get(entry.key);
    if (existing) {
      this.bytes -= existing.bytes;
      this.entries.delete(entry.key);
    }
    const stored = entry as Entry;
    stored.bytes = bytes;
    this.entries.set(stored.key, stored);
    this.bytes += bytes;
    this.evict();
  }

  /**
   * Merge changed rows into a decoded partition instead of re-reading it (ADR-0035).
   *
   * The caller resolves which rows changed by replaying the store's change log
   * against this entry's `seq`, and filters them by the partition's WHERE clause, so
   * these belong here. A row the snapshot does not have is appended; a row it does
   * have is overwritten in place. Both are O(dim) copies, and the second one is what
   * makes a rewrite cheap: re-embedding a partition row by row used to invalidate the
   * whole snapshot per row, so a run of rewrites cost a decode each (measured: 110 ms
   * per rewrite-plus-search at 20,000 rows).
   *
   * Capacity grows by at least 25% so a run of single inserts costs one copy per
   * doubling rather than one copy per row — reallocating to exactly the needed size
   * would make an insert O(partition), which is the cost the cache exists to avoid.
   *
   * Returns the entry, or undefined when it cannot be updated — gone (evicted while
   * the caller was querying), written at a different width, or grown past the budget
   * — in which case the caller decodes instead.
   */
  absorb(key: string, rows: PartitionRow[], seq: number): PartitionVectors | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (rows.length === 0) return this.markSynced(key, seq);
    let wanted = entry.rows;
    for (const r of rows) {
      // A row written at a different width belongs to a different embedding run;
      // the partition has to be decoded again rather than mixed.
      if (r.vec.length !== entry.dim) return undefined;
      if (!entry.index.has(r.id)) wanted++;
    }
    const capacity = wanted > entry.ids.length ? Math.max(wanted, Math.ceil(entry.rows * 1.25), 8) : entry.ids.length;
    // The budget is checked before anything is touched: a refusal has to leave the
    // entry exactly as it was, or the byte accounting and the arrays disagree and
    // the cache slowly believes it holds less than it does.
    const prospective = capacity * (entry.dim * 4 + 8 + 48);
    if (prospective > this.budget) return undefined;
    if (capacity !== entry.ids.length) {
      const wider = new Float32Array(capacity * entry.dim);
      wider.set(entry.flat.subarray(0, entry.rows * entry.dim));
      const longer = entry.ids.slice(0, entry.rows);
      longer.length = capacity;
      const taller = new Float64Array(capacity);
      taller.set(entry.norms.subarray(0, entry.rows));
      entry.flat = wider;
      entry.ids = longer;
      entry.norms = taller;
    }
    for (const r of rows) {
      const at = entry.index.get(r.id);
      if (at === undefined) {
        const slot = entry.rows++;
        entry.flat.set(r.vec, slot * entry.dim);
        entry.ids[slot] = r.id;
        entry.norms[slot] = r.norm;
        entry.index.set(r.id, slot);
      } else {
        // Same slot, new vector: the row never left the candidate set, so the
        // snapshot was not wrong about membership — only about the numbers.
        entry.flat.set(r.vec, at * entry.dim);
        entry.norms[at] = r.norm;
      }
    }
    entry.seq = seq;
    this.bytes += prospective - entry.bytes;
    entry.bytes = prospective;
    this.evict();
    return entry;
  }

  /** Record that an entry is caught up with the store without changing its rows. */
  markSynced(key: string, seq: number): PartitionVectors | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    entry.seq = seq;
    return entry;
  }

  /**
   * Mark every entry that holds this row unusable, without throwing the rest of the
   * partition away.
   *
   * This is the fallback for a change the caller cannot describe row by row: a
   * delete (the row must leave the candidate set, and an entry cannot remove a row
   * without compacting the flat array) or a re-label that moves a row in or out of
   * a partition. A rewrite does *not* come here — the writer holds the new vector
   * and `absorb` patches it in place (ADR-0036).
   *
   * A blanket invalidate-on-write would make the cache useless under the write
   * burst that realtime-bench produces (a save every few milliseconds, a search
   * every few more), and would leave it rebuilding forever. Precise marking keeps
   * the surviving rows' float data: the changed row is a hole the `stale` flag
   * covers by sending the next read down the exact path.
   *
   * Returns whether any entry held the row.
   */
  dropRow(id: string): boolean {
    let hit = false;
    for (const entry of this.entries.values()) {
      if (!entry.index.has(id)) continue;
      // The hole is the point: rather than compact a 6 MB array on every write,
      // mark the entry unusable and let the next read rebuild it once.
      entry.stale = true;
      hit = true;
    }
    return hit;
  }

  /**
   * Overwrite a row's vector inside every entry that holds it, in place (ADR-0036).
   *
   * A rewrite is the one change the writer can describe completely: the row keeps its
   * id and its membership, only the numbers move. So the snapshot does not have to be
   * invalidated — the caller hands over the new vector and the entry stays correct
   * *and* warm. Without this, `reembed` (which rewrites every row of a partition in
   * turn) invalidated the partition on each row, so a rewrite-plus-search cost a full
   * decode: measured 109.8 ms p50 at 20,000 rows, 40 rewrites produced 41 misses.
   *
   * Returns whether any entry held the row.
   */
  patchRow(id: string, vec: Float32Array, norm: number): boolean {
    let hit = false;
    for (const entry of this.entries.values()) {
      if (entry.stale) continue;
      const at = entry.index.get(id);
      if (at === undefined) continue;
      if (vec.length !== entry.dim) {
        // The entry decoded this row at another width, so it predates a reembed and
        // cannot be patched in place; send the next read down the exact path.
        entry.stale = true;
        continue;
      }
      entry.flat.set(vec, at * entry.dim);
      entry.norms[at] = norm;
      hit = true;
    }
    return hit;
  }

  /** Does this entry's snapshot hold the row? */
  holds(key: string, id: string): boolean {
    return this.entries.get(key)?.index.has(id) ?? false;
  }

  /** Where this entry keeps the row, or undefined when it does not hold it. */
  slotOf(key: string, id: string): number | undefined {
    return this.entries.get(key)?.index.get(id);
  }

  /** Invalidate every partition (compaction, purge). */
  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  stats(): { entries: number; bytes: number; hits: number; misses: number; evictions: number; budget: number } {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      hits: this.hit,
      misses: this.miss,
      evictions: this.evictions,
      budget: this.budget,
    };
  }

  resetStats(): void {
    this.hit = 0;
    this.miss = 0;
    this.evictions = 0;
  }

  private evict(): void {
    while (this.bytes > this.budget && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value as string;
      const gone = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      this.bytes -= gone.bytes;
      this.evictions++;
    }
  }
}

/** The true footprint: capacity, not live rows, because the arrays run ahead. */
function footprint(entry: PartitionVectors): number {
  return entry.flat.byteLength + entry.norms.byteLength + entry.ids.length * 48;
}
