/**
 * Bucket summaries and the vector-arm prefilter (P8 large half, ADR-0048).
 *
 * One bucket = one (namespace, project) pair — the dimension ADR-0020 made load-
 * bearing, and the only split inside a partition that both stores already carry as
 * a column. A bucket's summary row holds a model-free abstract (a deterministic
 * sample of the bucket's own rows), the bucket's *centroid* (the unit mean of its
 * row directions) with the tightest radius that still covers every row, and the
 * drift counters. The vector arm, behind `MEMORY_BUCKET_PREFILTER=on`, ranks
 * buckets by a bound derived from that pair and scans only the buckets that can
 * still matter — reading fewer *rows*, the lever ADR-0026 named as the only one
 * that changes the order of magnitude, after reading fewer *bytes* per row had been
 * measured at 1.45x.
 *
 * Why a bound and not the sketched "rank summaries, take top-b": the first cut
 * ranked abstract embeddings and took the best quarter of the buckets. Measured on
 * a clustered corpus it agreed with the exact scan everywhere a real embedder was
 * used — and on the hash embedder it fell apart: the exact top-20 there spans six
 * of twelve buckets while the summary ranking puts the query's own bucket third
 * (probe in ADR-0048), so a quarter-breadth scan lost most of the true top-20. A
 * summary cosine is a scent, not a bound. What follows is the smallest change that
 * makes the filter exact: per bucket, an UPPER bound on the cosine any of its rows
 * can have with the query. A bucket is skipped only when its bound cannot reach
 * the current top-`limit` floor — the prefilter can cost time, never rows. That is
 * the ADR-0029 lesson held structurally instead of by measurement: an approximate
 * index that silently stops returning the right row is worse than a slow one, so
 * this one is not approximate.
 */

/** `MEMORY_BUCKET_PREFILTER=on` enables the prefilter (strict "on", like MEMORY_LINKS). */
export function bucketPrefilterEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.MEMORY_BUCKET_PREFILTER ?? "").trim().toLowerCase() === "on";
}

/**
 * A bucket refreshes when this share of it changed since its summary was built.
 * OpenViking's freshness policy (`bench/OpenViking/openviking/storage/queuefs/
 * semantic_ops/freshness_policy.py:16` — `refresh_ratio=0.10` default, compared as
 * `pending/total >= ratio` at :48-52); the number was measured there for exactly
 * this question, so it is borrowed rather than re-tuned.
 */
export const BUCKET_REFRESH_RATIO = 0.1;

/**
 * Buckets at or under this many live rows refresh regardless of the ratio. Same
 * source as the ratio: OpenViking refreshes small directories immediately
 * (`freshness_policy.py:37-41`, `total_entries <= overview_sample_limit`, limit 32)
 * because a summary over 32 rows costs one cheap rebuild and the drift ratio of a
 * small population is dominated by noise.
 */
export const BUCKET_SMALL_TOTAL = 32;

/** Rows sampled into one abstract, newest first. A summary is a scent, not a copy. */
export const BUCKET_ABSTRACT_ROWS = 16;
/** Characters of a sampled row kept in the abstract. */
export const BUCKET_ABSTRACT_CHARS = 200;

/**
 * A bucket is skipped only when its bound is short of the floor by more than this:
 * the bound and the row cosines are both float64 dot products, and a boundary tie
 * decided by 1e-16 of rounding must land on the safe side — the bucket gets scanned.
 * The exact top-`limit` SET is the contract; a tie at the boundary is scanned, not
 * adjudicated.
 */
export const BUCKET_BOUND_EPS = 1e-9;

/** The drift counters a summary row carries, and what a refresh rewrites. */
export interface BucketSummaryRecord {
  /** '' encodes the unscoped backlog (the `project IS NULL` rows) inside the primary key. */
  project: string;
  abstract: string;
  dim: number;
  total: number;
  pending: number;
  updatedAt: number;
}

export interface BucketRefreshReport {
  refreshed: number;
  skipped: number;
  dropped: number;
  /** Buckets the live store actually holds (the denominator of every ratio here). */
  total: number;
}

/**
 * The model-free abstract: the newest `BUCKET_ABSTRACT_ROWS` live rows, each clipped,
 * newline-joined. Newest first because the abstract should smell like what the bucket
 * is becoming, not what it was; the clipping keeps one long session chunk from being
 * the whole summary. Deterministic in its inputs — the same rows build the same
 * abstract, so a refresh that changes nothing writes the same text. It is carried
 * for diagnostics (what the bucket is about, readable in SQL) — the scan ranks on
 * the centroid, never on this.
 */
export function buildAbstract(samples: string[]): string {
  return samples
    .slice(0, BUCKET_ABSTRACT_ROWS)
    .map((t) => t.replace(/\s+/g, " ").trim().slice(0, BUCKET_ABSTRACT_CHARS))
    .filter((t) => t.length > 0)
    .join("\n");
}

/**
 * Which buckets a refresh pass rewrites, drops, or leaves alone. Shared by both
 * stores so the threshold decision has exactly one implementation:
 *
 * - missing summary, or a summary whose dim does not match the store's vectors:
 *   refresh (no baseline — OpenViking's `has_freshness_baseline=false` → REFRESH_NOW);
 * - `total <= BUCKET_SMALL_TOTAL`: refresh regardless of drift;
 * - `pending / total >= BUCKET_REFRESH_RATIO`: refresh;
 * - otherwise skip — the pending count keeps accumulating, nothing is lost;
 * - a summary whose bucket no longer holds a live row is dropped (a phantom summary
 *   would spend scan time ranking rows no scan can return).
 */
export function planBucketRefresh(
  universe: { key: string; total: number }[],
  existing: Map<string, { dim: number; total: number; pending: number }>,
  currentDim: number | null
): { targets: string[]; dropped: string[]; skipped: number } {
  const targets: string[] = [];
  const dropped: string[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const bucket of universe) {
    seen.add(bucket.key);
    const row = existing.get(bucket.key);
    if (!row || (currentDim !== null && row.dim !== currentDim)) {
      targets.push(bucket.key);
      continue;
    }
    if (bucket.total <= BUCKET_SMALL_TOTAL || row.pending / Math.max(bucket.total, 1) >= BUCKET_REFRESH_RATIO) {
      targets.push(bucket.key);
      continue;
    }
    skipped++;
  }
  for (const key of existing.keys()) {
    if (!seen.has(key)) dropped.push(key);
  }
  return { targets, dropped, skipped };
}

/**
 * The centroid geometry a refresh computes and a search consumes. The rows of a
 * bucket are treated as directions: `centroid` is the unit mean of their unit
 * vectors, `cosTheta` the smallest centroid-to-row cosine over them — every row
 * direction lies in the spherical cap of half-angle `theta` around the centroid.
 */
export interface CentroidSummary {
  centroid: number[];
  /** Smallest cosine between the centroid and any covered row's direction; ≤ 1. */
  cosTheta: number;
  /** Euclidean norm of the mean before unit-normalisation; 0 means an empty bucket. */
  norm: number;
}

/** Mean of unit row directions, as the refresh accumulates them. */
export function accumulateCentroid(dims: number): { sum: number[]; count: number } {
  return { sum: new Array(dims).fill(0), count: 0 };
}

export function addToCentroid(acc: { sum: number[]; count: number }, vec: ArrayLike<number>): void {
  let n = 0;
  for (let i = 0; i < acc.sum.length; i++) n += vec[i] * vec[i];
  const inv = n > 0 ? 1 / Math.sqrt(n) : 0;
  for (let i = 0; i < acc.sum.length; i++) acc.sum[i] += vec[i] * inv;
  acc.count++;
}

/**
 * The centroid + the covering radius, from one bucket's accumulated rows. The
 * centroid is the RAW mean of the unit row directions and `norm` is that mean's
 * norm — the pair as stored, so a reader computing `dot(q, blob) / (‖q‖ · norm)`
 * gets the true cosine whatever the blob's scale. (A first cut unit-normalised the
 * returned centroid while keeping the raw norm beside it, and every bound quietly
 * divided by ~100 — found by a probe that printed `centroid norm 99.66` for a
 * "unit" centroid; the norm must describe the blob it is stored with.) A bucket
 * whose rows are all the zero vector has `norm` 0 and is stale by definition at
 * search time (the bound would be undefined) — the honest answer for a degenerate
 * bucket is to scan it.
 */
export function finishCentroid(acc: { sum: number[]; count: number }, cosTheta: number): CentroidSummary {
  let norm = 0;
  for (const v of acc.sum) norm += v * v;
  norm = Math.sqrt(norm);
  return { centroid: acc.sum, cosTheta: Math.min(1, Math.max(-1, cosTheta)), norm };
}

/** Cosine between the unit query direction and the unit centroid, from raw vectors. */
export function queryToCentroid(query: number[], centroid: number[], centroidNorm: number): number {
  if (centroidNorm <= 0) return 0;
  let dot = 0;
  let qn = 0;
  for (let i = 0; i < query.length; i++) {
    dot += query[i] * centroid[i];
    qn += query[i] * query[i];
  }
  const denom = Math.sqrt(qn) * centroidNorm;
  return denom === 0 ? 0 : Math.min(1, Math.max(-1, dot / denom));
}

/**
 * The spherical-cap bound: the largest cosine ANY unit vector inside the cap
 * (directions at least `cosTheta` from the centroid) can have with the query.
 *
 * Let `δ` be the angle between the query direction and the centroid (`a = cos δ`).
 * Two cases, and the first is the one a first cut of this function got wrong —
 * found by the exactness test below, where a self-query scored 1.0 against a bound
 * of 0.9999:
 *
 * - `δ ≤ θ`: the query direction itself lies IN the cap, so some row direction can
 *   equal it and the max is 1 — the bucket can never be skipped.
 * - `δ > θ`: the maximum sits on the cap's boundary in the plane of ĉ and q̂, at
 *   `cos(δ − θ) = a·cosTheta + √(1−a²)·√(1−cosTheta²)`.
 *
 * The bound degrades the way it must: a bucket that covers everything
 * (`cosTheta → 0`) is never skipped while the query is anywhere near it; a tight
 * bucket (`cosTheta → 1`) bounds at its own centroid cosine.
 */
export function bucketScanBound(queryToCentroidCosine: number, cosTheta: number): number {
  const a = Math.min(1, Math.max(-1, queryToCentroidCosine));
  const t = Math.min(1, Math.max(-1, cosTheta));
  if (a >= t) return 1; // the query direction is inside the cap — scan it
  const b = Math.sqrt(Math.max(0, 1 - a * a));
  const s = Math.sqrt(Math.max(0, 1 - t * t));
  return a * t + b * s;
}

/**
 * The radius is stored with this much slack, because the centroid itself is stored
 * as a float32 blob: re-packing a float64 mean costs ~1e-7 of direction error, and
 * `cosTheta` was measured against the float64 mean. Widening the cap widens every
 * bound, so the slack buys safety on the skip rule and costs only a hair of scan
 * time at the boundary.
 */
export const BUCKET_RADIUS_SLACK = 1e-6;

/**
 * The scan order the prefilter walks: stale buckets first (they have no valid bound
 * — their rows moved since the summary was built, so the bound would describe rows
 * that are no longer the rows), then fresh buckets by bound, best first. Walking in
 * bound order is what makes the early stop correct: once the floor is set, every
 * LATER bucket's bound is no higher, so the first bucket whose bound cannot reach
 * the floor ends the walk for all of them. The bound rides along on each step —
 * the walk must not have to look it up twice, and a step without its number would
 * read as "can never reach the floor" and stop the walk after one bucket.
 */
export function bucketScanOrder<K>(
  fresh: { key: K; bound: number }[],
  stale: K[]
): { key: K; bound: number; stale: boolean }[] {
  const order: { key: K; bound: number; stale: boolean }[] = stale.map((key) => ({ key, bound: Number.POSITIVE_INFINITY, stale: true }));
  for (const f of fresh) order.push({ key: f.key, bound: f.bound, stale: false });
  order.sort(
    (a, z) =>
      z.bound - a.bound ||
      (a.stale === z.stale ? (String(a.key) < String(z.key) ? -1 : String(a.key) > String(z.key) ? 1 : 0) : a.stale ? -1 : 1)
  );
  return order;
}

/**
 * Whether the walk can stop here: every bucket after this one has a bound no
 * higher, and a bound short of the floor (by more than float-noise slack) means no
 * row inside can enter the top-`limit`.
 */
export function boundCanReachFloor(bound: number, floor: number): boolean {
  return bound > floor - BUCKET_BOUND_EPS;
}

/**
 * The pending count a refresh leaves behind, given what the refresh planned against
 * and what the summary row holds at write time.
 *
 * The geometry a refresh computes is a snapshot taken at the moment it reads the
 * bucket's rows; any write that commits AFTER that read must leave the bucket stale,
 * because its direction is not inside the cap the summary just stored. Writes mark
 * that by bumping `pending` — so the refresh may reset to zero only the drift that
 * existed BEFORE its snapshot, never what accumulated since. Hence the subtraction:
 * the plan-time pending is the baseline, and `current − plan` keeps every increment
 * that landed between the geometry read and the summary write. That window is real:
 * the write transaction can sit in a BUSY backoff (retryWrite) while a concurrent
 * write commits and marks its bucket — an unconditional `pending = 0` there erased
 * the marker and the bucket then trusted a cap that did not contain the new row
 * (found by review, 2026-11-09).
 *
 * `current` is read INSIDE the write transaction (BEGIN IMMEDIATE), so no writer can
 * slip between the read and the reset. Anything that does not identify as the same
 * summary generation the plan was made against — the row dropped by a sweep and
 * recreated as a placeholder, another refresher's write, the row vanished — is
 * treated as drift and returns 1: one extra refresh is cheap, a trusted stale cap is
 * not. A bucket with no summary at plan time (`plan` null) and none at write time
 * (`current` null) had no writes to lose: 0.
 */
export function pendingAfterRefresh(
  plan: { pending: number; updatedAt: number } | null,
  current: { pending: number; updatedAt: number } | null
): number {
  if (!current) return plan === null ? 0 : 1; // no row now: drift only if the plan saw one
  if (!plan || current.updatedAt !== plan.updatedAt || current.pending < plan.pending) return 1;
  return Math.max(0, current.pending - plan.pending);
}
