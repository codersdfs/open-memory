/**
 * `ai-memory daemon restart` — the last step of every "restart required".
 *
 * The daemon is one process serving one vector space (ADR-0009), so a settings change
 * that touches the embedder or a credential only lands after the process is replaced.
 * That is what this file does: probe, stop, start, probe again — start before stop is a
 * port clash, and stop after start without the second probe is a success claim nobody
 * checked.
 *
 * Every step is injectable. A restart is the one CLI command that acts on a live
 * process, and the tests for it must not touch one.
 */

import { spawn as spawnProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryClient, defaultServerUrl } from "./http.js";

/** The one `restarted: false` that is not a failure: there was nothing to restart. */
export const NO_DAEMON_RUNNING = "no daemon is running";

export interface RestartResult {
  restarted: boolean;
  reason?: string;
}

export interface DaemonDeps {
  /** Answers whether a daemon is serving the resolved base URL. Never throws. */
  probe?: () => Promise<boolean>;
  /** Stops the daemon, resolving only once it stopped answering. Throws when it does not. */
  shutdown?: () => Promise<void>;
  /**
   * Starts a detached replacement. Throws when no replacement could be started at all;
   * reports a launcher that failed after the call returned (ENOENT, EACCES) to `onError`.
   */
  spawn?: (onError: (err: Error) => void) => void;
  /** The pause between polls while waiting for the replacement. Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  stdout?: (s: string) => void;
}

/** A liveness probe has to be short: the answer decides whether anything happens at all. */
const PROBE_TIMEOUT_MS = 500;
const SHUTDOWN_TIMEOUT_MS = 1500;
const STOP_WAIT_MS = 5000;
const STOP_POLL_MS = 100;
/** How long the replacement gets to start answering before the restart is a failure. */
const START_WAIT_MS = 5000;
const START_POLL_MS = 100;
/**
 * The window closes on either bound. Attempts keep a test honest and fast: it fakes the
 * sleep, so only the cap can end the loop in one tick. The clock is what keeps the real
 * command to "a few seconds" — a probe that hangs on its own timeout never eats the cap.
 */
const START_ATTEMPTS = Math.ceil(START_WAIT_MS / START_POLL_MS);

async function probeDaemon(): Promise<boolean> {
  const health = await new MemoryClient(defaultServerUrl(), PROBE_TIMEOUT_MS).health();
  return health?.ok === true;
}

/**
 * `POST /admin/shutdown`, then wait for the process to actually let go of the port.
 *
 * The 204 leaves before the listener closes, so the reply alone is not the signal: a
 * replacement started on that reply races the old socket. Polling `/health` until it
 * stops answering is what makes "stopped" a fact, and giving up after 5s is what keeps
 * a wedged daemon from hanging the command forever.
 */
async function shutdownDaemon(): Promise<void> {
  const client = new MemoryClient(defaultServerUrl(), SHUTDOWN_TIMEOUT_MS);
  const res = await client.post<unknown>("/admin/shutdown", {});
  if (!res.ok) {
    if (res.status === 403) {
      // The gate refused this client's key. Two known shapes: the daemon predates a
      // `principal recover` in a way the file cannot explain (home mismatch), or the
      // key file is simply not this daemon's. Either way the exit has to be named —
      // before the repair lever existed this is where the break-glass flow died with
      // the daemon unkillable by the commands that documented it.
      throw new Error(
        "the daemon refused to shut down (HTTP 403) — it did not accept this client's key; " +
        "check that the CLI and the daemon read the same memory home (ai-memory principal status), " +
        "or stop the daemon process manually and start a fresh one"
      );
    }
    throw new Error(
      res.status > 0 ? `the daemon refused to shut down (HTTP ${res.status})` : res.error
    );
  }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    if (!(await probeDaemon())) return;
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
  }
  throw new Error(`the daemon was still answering ${STOP_WAIT_MS / 1000}s after the shutdown request`);
}

/**
 * Start the replacement as its own process.
 *
 * A built install has `dist/src/api/server.js` beside this file and gets exec'd with the
 * CLI's own node, detached, inheriting the environment (PORT/HOST are how the daemon
 * picks its address, and this CLI resolved its base URL from the same values). Running
 * from source — `tsx src/cli/index.ts`, which is how the repo runs it — there is no
 * built entry to exec, and pretending otherwise would report a restart over a process
 * that never began. That case throws with the exact command to run instead.
 */
function startReplacement(onError: (err: Error) => void): void {
  const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..", "api");
  const builtEntry = join(apiDir, "server.js");
  const sourceEntry = join(apiDir, "server.ts");
  if (existsSync(builtEntry)) {
    const child = spawnProcess(process.execPath, [builtEntry], {
      detached: true,
      // stdio stays ignored: `/health` answering is what proves the replacement came up,
      // so the child's output has nothing to add and would hold onto the terminal.
      stdio: "ignore",
      env: process.env
    });
    // A launcher that never got as far as a process reports ENOENT/EACCES as an async
    // `error` event. With nobody subscribed that crashes the CLI; routing it into the
    // restart result makes it the failure it is.
    child.on("error", onError);
    child.unref();
    return;
  }
  if (!existsSync(sourceEntry)) {
    throw new Error(
      `could not start a replacement: no server entry at ${builtEntry} — reinstall the package, or run: npm run build`
    );
  }
  throw new Error(`could not start a replacement: this CLI is running from source — run: npx tsx "${sourceEntry}"`);
}

/**
 * Probe → stop → start → probe. A restart that could not start a replacement, or started
 * one that never answered, answers `restarted: false` with the reason; it never reports
 * success it did not achieve.
 */
export async function restartDaemon(deps: DaemonDeps = {}): Promise<RestartResult> {
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s + "\n"));
  const probe = deps.probe ?? probeDaemon;
  const shutdown = deps.shutdown ?? shutdownDaemon;
  const spawn = deps.spawn ?? startReplacement;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  if (!(await probe())) {
    stdout(NO_DAEMON_RUNNING);
    return { restarted: false, reason: NO_DAEMON_RUNNING };
  }
  try {
    await shutdown();
  } catch (err) {
    return { restarted: false, reason: `could not stop the daemon: ${(err as Error).message}` };
  }

  // The spawn returns the moment the process is forked, which is not the moment the
  // daemon listens — and a child that dies on startup (EADDRINUSE is the usual one) says
  // so on a stdio nobody reads. Only the port answering makes "restarted" a fact.
  let launcherError: Error | undefined;
  try {
    spawn((err) => {
      launcherError ??= err;
    });
  } catch (err) {
    return { restarted: false, reason: (err as Error).message };
  }
  const deadline = Date.now() + START_WAIT_MS;
  for (let attempt = 0; attempt < START_ATTEMPTS && Date.now() < deadline; attempt++) {
    if (launcherError) {
      return { restarted: false, reason: `could not start a replacement: ${launcherError.message}` };
    }
    if (await probe()) {
      stdout("daemon restarted");
      return { restarted: true };
    }
    await sleep(START_POLL_MS);
  }
  return {
    restarted: false,
    reason: `the new daemon did not answer at ${defaultServerUrl()} within ${START_WAIT_MS / 1000}s — check that its port is free and that the settings it now runs with are valid`
  };
}

/**
 * The `daemon` subcommand, shaped like the repo's other command modules: positionals in,
 * exit code out. "No daemon was running" is a success — the daemon the caller asked for
 * is exactly what they have — while a stop that failed, a start that failed, or a
 * replacement that never answered is not.
 */
export async function runDaemonCommand(
  positionals: string[],
  io: { out: (s: string) => void; err: (s: string) => void },
  deps: DaemonDeps = {}
): Promise<number> {
  const sub = positionals[0];
  if (sub !== "restart") {
    io.err(`daemon: unknown subcommand "${sub ?? ""}" (expected: restart)`);
    return 2;
  }
  const result = await restartDaemon({ stdout: io.out, ...deps });
  if (result.restarted || result.reason === NO_DAEMON_RUNNING) return 0;
  io.err(`daemon restart: ${result.reason}`);
  return 1;
}
