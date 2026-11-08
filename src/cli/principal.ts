/**
 * `ai-memory principal` — the one identity this machine's memory daemon serves
 * (ADR-0049, P7 of the memory-systems research).
 *
 * Two verbs:
 *   - `status` (default): what is bound, and whether the store's own partitions agree
 *     with it — a mismatch is the recover hint printed next to the facts.
 *   - `recover --from-db`: the key is lost or the store moved machines. One-way by
 *     construction: the lost token is never reconstructed (nothing in the store can
 *     produce random bytes it never saw), so recover writes a *new* token and re-derives
 *     the user segment from the partitions the store actually holds. Existing rows stay
 *     readable because the segment they were filed under is exactly what gets re-bound.
 *
 * Reads the store through `MemoryService` like every other whole-store command, so the
 * same precedence (`--db` → `MEMORY_DB_PATH` → home) decides which file is consulted.
 */

import { existsSync } from "node:fs";
import { MemoryService } from "../core/memoryService.js";
import { MemoryClient } from "./http.js";
import { dbExists, resolveDbPath } from "../core/dbPath.js";
import {
  PRINCIPAL_HEADER,
  namespaceUserSegment,
  principalKeyPath,
  readPrincipal,
  recoverPrincipal,
} from "../core/principal.js";

export interface PrincipalIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

interface PrincipalFlags {
  readonly [key: string]: string | boolean | undefined;
}

const flagValue = (flags: PrincipalFlags, key: string): string | undefined => {
  const v = flags[key];
  return typeof v === "string" && v.trim() ? v : undefined;
};

/** The masked token for humans: never the whole secret, even in a status output. */
function mask(token: string): string {
  return token.length <= 8 ? "…" : `…${token.slice(-4)}`;
}

/** Every partition the store holds, tombstones included — the widest view of the data. */
async function storeNamespaces(dbPath: string): Promise<string[]> {
  const svc = new MemoryService({ dbPath });
  await svc.init();
  try {
    return await svc.store.distinctNamespaces({ includeDeleted: true });
  } finally {
    await svc.close();
  }
}

export async function runPrincipalCommand(
  positionals: string[],
  flags: PrincipalFlags,
  io: PrincipalIo
): Promise<number> {
  const sub = positionals[0] ?? "status";

  if (sub === "status") {
    const home = flagValue(flags, "home");
    const path = principalKeyPath(home);
    const principal = await readPrincipal(home);
    io.out(`key:      ${path}${existsSync(path) ? "" : " (absent — the daemon creates it on next start)"}`);
    if (!principal) {
      io.out("bound:    nothing yet");
      return 0;
    }
    io.out(`bound:    user "${principal.user}" (created ${principal.createdAt || "unknown"})`);
    io.out(`token:    ${mask(principal.token)}  (sent as the ${PRINCIPAL_HEADER} header)`);
    const dbPath = resolveDbPath(flagValue(flags, "db"));
    if (!dbExists(dbPath)) {
      io.out(`store:    ${dbPath} (not created yet — nothing to compare against)`);
      return 0;
    }
    const namespaces = await storeNamespaces(dbPath);
    const segments = new Map<string, number>();
    for (const ns of namespaces) {
      // The legacy bucket is every principal's: it says nothing about who owns anything.
      if (ns === "default:default") continue;
      const segment = namespaceUserSegment(ns);
      segments.set(segment, (segments.get(segment) ?? 0) + 1);
    }
    if (segments.size === 0) {
      io.out(`store:    ${dbPath} holds only legacy partitions — consistent`);
    } else {
      const held = [...segments.entries()].sort((a, b) => b[1] - a[1]);
      io.out(`store:    ${dbPath} partitions under: ${held.map(([s, n]) => `${s} (${n})`).join(", ")}`);
      if (!segments.has(principal.user)) {
        io.out(
          `mismatch: no partition carries the segment "${principal.user}" — if this store moved machines or ` +
            `the key file was recreated, re-bind with: ai-memory principal recover --from-db`
        );
      }
    }
    return 0;
  }

  if (sub === "recover") {
    if (!flags["from-db"]) {
      io.err("principal recover: pass --from-db (recover reads the user segment from the store's own partitions)");
      return 2;
    }
    const dbPath = resolveDbPath(flagValue(flags, "db"));
    if (!dbExists(dbPath)) {
      io.err(`principal recover: no store at ${dbPath} — nothing to recover from`);
      return 1;
    }
    const home = flagValue(flags, "home");
    const before = await readPrincipal(home);
    const namespaces = await storeNamespaces(dbPath);
    const principal = await recoverPrincipal(namespaces, home);
    io.out(`recovered: user "${principal.user}" (from ${namespaces.length} partition(s) in ${dbPath})`);
    io.out(`key:       ${principal.path} — new token written (the old one is gone for good)`);
    if (before) {
      io.out(`previous:  user "${before.user}" — clients holding that token answer 403 until they re-read the file`);
    }
    // The running daemon still holds the pre-recover binding in memory: every new-token
    // request 403s against it until it restarts. The one exception is the repair lever
    // the gate keeps for exactly this state — shutdown accepts the file's *current*
    // token — so `daemon restart` stops it even while it holds the old binding.
    const health = await new MemoryClient().health();
    if (health?.ok) {
      io.out(`running:   a daemon is up and still holds the previous binding — restart it now`);
    }
    io.out(`next:      restart the daemon (ai-memory daemon restart) so it binds the new key`);
    return 0;
  }

  if (sub === "reveal") {
    // The honest form of `cat principal.key`: the CLI runs on the owning account, so
    // printing the token to the operator's terminal adds no exposure — but it is the
    // one command the console's unlock gate can name without teaching file paths.
    const principal = await readPrincipal(flagValue(flags, "home"));
    if (!principal) {
      io.err(`principal reveal: no key file at ${principalKeyPath(flagValue(flags, "home"))} — start the daemon once to create it`);
      return 1;
    }
    io.out(principal.token);
    return 0;
  }

  io.err(`principal: unknown subcommand "${sub}" (expected: status | recover --from-db | reveal)`);
  return 2;
}
