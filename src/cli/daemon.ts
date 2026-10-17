/**
 * `ai-memory daemon restart` — the last step of every "restart required".
 *
 * The daemon is one process serving one vector space (ADR-0009), so a settings change
 * that touches the embedder or a credential only lands after the process is replaced.
 * That is what this file does: probe, stop, start — in that order, because spawning
 * before the old listener is gone is a port clash.
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
  /** Starts a detached replacement. Throws when no replacement could be started. */
  spawn?: () => void;
  stdout?: (s: string) => void;
}

/** A liveness probe has to be short: the answer decides whether anything happens at all. */
const PROBE_TIMEOUT_MS = 500;
const SHUTDOWN_TIMEOUT_MS = 1500;
const STOP_WAIT_MS = 5000;
const STOP_POLL_MS = 100;

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
function startReplacement(): void {
  const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..", "api");
  const builtEntry = join(apiDir, "server.js");
  const sourceEntry = join(apiDir, "server.ts");
  if (existsSync(builtEntry)) {
    const child = spawnProcess(process.execPath, [builtEntry], {
      detached: true,
      stdio: "ignore",
      env: process.env
    });
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
 * Probe → stop → start. A restart that could not start a replacement answers
 * `restarted: false` with the reason; it never reports success it did not achieve.
 */
export async function restartDaemon(deps: DaemonDeps = {}): Promise<RestartResult> {
  const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s + "\n"));
  const probe = deps.probe ?? probeDaemon;
  const shutdown = deps.shutdown ?? shutdownDaemon;
  const spawn = deps.spawn ?? startReplacement;

  if (!(await probe())) {
    stdout(NO_DAEMON_RUNNING);
    return { restarted: false, reason: NO_DAEMON_RUNNING };
  }
  try {
    await shutdown();
  } catch (err) {
    return { restarted: false, reason: `could not stop the daemon: ${(err as Error).message}` };
  }
  try {
    spawn();
  } catch (err) {
    return { restarted: false, reason: (err as Error).message };
  }
  stdout("daemon restarted");
  return { restarted: true };
}

/**
 * The `daemon` subcommand, shaped like the repo's other command modules: positionals in,
 * exit code out. "No daemon was running" is a success — the daemon the caller asked for
 * is exactly what they have — while a stop or a start that failed is not.
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
