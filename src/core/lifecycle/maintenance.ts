import type { VectorStore } from "../store/interface.js";
import { runScheduledDecay, type DecayReport } from "./decay.js";

/**
 * The forgetting trigger gap1 said was missing (P2, ADR-0016 amendment 2026-11-07).
 *
 * Until this file, decay was reachable only by a human: `POST /decay`, or the CLI.
 * The ADR-0040 audit that started this — 459 of 515 rows (89%) never retrieved —
 * was a statement about a store nothing ever swept. The scheduler sweeps it.
 *
 * Two rules make this safe to hang on a daemon nobody is watching:
 *
 * 1. The pass is the reversible half only. `runScheduledDecay` takes no options
 *    bag, so the destructive pass is unreachable from this code path by signature,
 *    not by a convention someone can forget (decay.ts, ADR-0016).
 * 2. Nothing here blocks anything: the startup catch-up and every timer tick run
 *    detached, and a failed pass costs one stderr line — the next start's
 *    catch-up retries, because the clock it compares against lives in `store_meta`.
 */

const HOUR_MS = 3_600_000;

/** `MEMORY_MAINTAIN_HOURS` default. `0` switches maintenance off entirely. */
export const MAINTAIN_HOURS_DEFAULT = 24;

/** `store_meta` keys. `stats.ts` reads them through the `/stats` route, not here. */
export const LAST_MAINTENANCE_AT_KEY = "last_maintenance_at";
export const LAST_MAINTENANCE_RESULT_KEY = "last_maintenance_result";

/**
 * Resolve the interval from the environment: default 24h, `0` off. An unparsable
 * or negative value falls back to the default rather than silently disabling the
 * sweep — a typo in an env var should not turn the forgetting trigger off, and it
 * must not start one either when the operator plainly said `0`.
 */
export function maintenanceIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.MEMORY_MAINTAIN_HOURS ?? "").trim();
  if (raw === "") return MAINTAIN_HOURS_DEFAULT * HOUR_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) return MAINTAIN_HOURS_DEFAULT * HOUR_MS;
  return hours * HOUR_MS;
}

/**
 * One maintenance pass: the reversible decay, then the bookkeeping.
 *
 * Results go to the log (the daemon's stderr — the console and `/stats` read the
 * `store_meta` entries back out of the file). Writing the timestamp even when the
 * store has no meta capability is skipped rather than faked: there is nowhere to
 * put it, and "it remembered" would be a lie the next start would act on.
 */
export async function runMaintenancePass(
  store: VectorStore,
  deps: { now?: () => number; log?: (line: string) => void } = {}
): Promise<DecayReport> {
  const now = deps.now?.() ?? Date.now();
  const log = deps.log ?? ((line: string) => console.error(line));
  const report = await runScheduledDecay(store);
  await store.setMeta?.(LAST_MAINTENANCE_AT_KEY, String(now));
  await store.setMeta?.(LAST_MAINTENANCE_RESULT_KEY, `${report.archived} archived, ${report.pruned} pruned`);
  log(`ai-memory maintenance: archived ${report.archived} cold row${report.archived === 1 ? "" : "s"}`);
  return report;
}

export interface MaintenanceHandle {
  /** Stop the timer. An in-flight pass finishes on its own; the store is never half-swept. */
  stop(): void;
  /** Resolves when no pass is in flight. For tests and for a quiet shutdown. */
  untilIdle(): Promise<void>;
}

export interface StartMaintenanceOptions {
  env?: Record<string, string | undefined>;
  /** Test seam below the env: a tick interval in ms (fractions of an hour are valid here). */
  intervalMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Wire the scheduler to an opened store; returns synchronously, and nothing awaits
 * a decay pass.
 *
 * `MEMORY_MAINTAIN_HOURS=0` (or any resolved interval ≤ 0) is fully off: no timer,
 * no startup catch-up — a disabled trigger must not fire on store open either.
 *
 * The startup catch-up is why the timestamp lives in `store_meta` rather than in
 * the process: a daemon that was down for a week owes the store one pass at the
 * next open, and only the file knows how long it was dark. A store without the
 * KV capability (`getMeta` absent) cannot answer "overdue?", so it gets the timer
 * alone — same shape as every other optional capability in `interface.ts`.
 */
export function startMaintenance(store: VectorStore, opts: StartMaintenanceOptions = {}): MaintenanceHandle {
  const intervalMs = opts.intervalMs ?? maintenanceIntervalMs(opts.env ?? process.env);
  const log = opts.log ?? ((line: string) => console.error(line));
  const now = opts.now ?? (() => Date.now());

  let stopped = false;
  // Passes serialise on this chain: a slow sweep and a timer tick that lands inside
  // it must not run archiveStale twice over the same rows.
  let inFlight: Promise<void> = Promise.resolve();

  if (!(intervalMs > 0)) {
    return { stop(): void { stopped = true; }, untilIdle: () => inFlight };
  }

  const runOnce = (): Promise<void> => {
    inFlight = inFlight
      .then(async () => {
        if (stopped) return;
        await runMaintenancePass(store, { now, log });
      })
      .catch((err) => {
        // One line, and the chain survives: a rejected link is how a scheduled
        // job silently stops existing, which is the bug this file replaces.
        log(`ai-memory maintenance failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    return inFlight;
  };

  const getMeta = store.getMeta?.bind(store);
  if (getMeta) {
    void (async () => {
      const raw = await getMeta(LAST_MAINTENANCE_AT_KEY);
      const last = raw === null ? Number.NaN : Number(raw);
      // Missing entry = never maintained = overdue. Anything older than one
      // interval is overdue too; a future timestamp is not.
      if (!Number.isFinite(last) || now() - last >= intervalMs) runOnce();
    })().catch((err) => log(`ai-memory maintenance check failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  const timer = setInterval(runOnce, intervalMs);
  // A daemon that outlives its listener must not be held open by the sweeper
  // alone, and a test that forgot `stop()` must still be able to exit.
  timer.unref?.();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
    untilIdle: () => inFlight
  };
}
