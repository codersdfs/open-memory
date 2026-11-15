import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { parseNamespaceKey } from "./types.js";
import { resolveHome } from "./dbPath.js";
import { resolveUser } from "./scope.js";

/** The legacy partition — the one namespace that is nobody's segment and everybody's. */
const LEGACY = "default:default";

/**
 * The principal (ADR-0049) — the one local identity a daemon serves.
 *
 * gap2 (the memory-systems research, §1.3) was: identity was whatever the caller
 * reported — `AI_MEMORY_USER`, or any namespace string at all — and any local process
 * could read another partition by saying so. P7 replaces that with a secret the caller
 * cannot report: a random token in the memory home, generated at the daemon's first
 * start and required on every read/write request. The token's threat model is narrow on
 * purpose and the ADR says so plainly: it stops a process under *another* OS account
 * (which can reach the loopback port but cannot read this account's key file); it does
 * not stop a same-account process (which can read the key and open the SQLite file
 * directly) and it is not at-rest encryption.
 *
 * The file also holds `user` — the namespace user segment this principal owns. Over the
 * daemon the caller never decides that segment: scope the caller leaves unpinned is
 * resolved with it, and a namespace that pins a foreign segment is refused with 403.
 * The segment is frozen in the file at creation so a later env change cannot move it;
 * `ai-memory principal recover --from-db` re-derives it from the store's own partitions
 * when the file is lost or the store moved machines.
 *
 * The token reaches exactly two kinds of reader: wire clients that read this file from
 * disk under the owning OS account (CLI, MCP, hooks via `--server`), and the browser
 * console — where the operator pastes it once into a 401 gate and the page keeps it in
 * localStorage. The daemon itself never serves the token to an unauthenticated reader:
 * the file is the only place it lives on disk, and the key file is the only thing a
 * cross-account process cannot read.
 */

/** The wire header. Chosen once; named here and in ADR-0049 so clients cannot drift. */
export const PRINCIPAL_HEADER = "x-ai-memory-principal";

/** A loaded or created principal. `path` is where its key file lives. */
export interface Principal {
  /** The bearer secret clients send in `PRINCIPAL_HEADER`. */
  token: string;
  /** The namespace user segment this principal owns (see `isPrincipalNamespace`). */
  user: string;
  /** Absolute path of the key file — error messages point callers at it. */
  path: string;
  /** ISO timestamp of the file's creation. */
  createdAt: string;
}

/** What a server instance binds: the fields of `Principal` without file plumbing. */
export interface PrincipalBinding {
  token: string;
  user: string;
  path?: string;
}

const FILE_NAME = "principal.key";
/** File format version, so a future shape can be detected instead of misparsed. */
const FORMAT = 1;

export function principalKeyPath(home?: string): string {
  return join(resolveHome(home), FILE_NAME);
}

interface PrincipalFile {
  version: number;
  token: string;
  user: string;
  createdAt: string;
}

/**
 * Read the key file without creating anything — the client-side half (CLI, MCP, the
 * hook's daemon path, the benches). `null` means "no principal here": the caller sends
 * no header and the daemon's 401 explains itself. A file this code cannot parse is
 * reported as null rather than thrown — a corrupt key must degrade to a clear 401 on
 * the wire, never to a crash inside a hook.
 */
export async function readPrincipal(home?: string): Promise<Principal | null> {
  const path = principalKeyPath(home);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as PrincipalFile;
    if (parsed.version !== FORMAT || typeof parsed.token !== "string" || !parsed.token) return null;
    return {
      token: parsed.token,
      user: typeof parsed.user === "string" && parsed.user ? parsed.user : "default",
      path,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  } catch {
    return null;
  }
}

/**
 * Load the key file or create it — the daemon's start-up half. Creation writes a fresh
 * 256-bit token and the user segment resolved the way writes would resolve it anyway
 * (`resolveUser`: explicit → env → OS username), so a fresh install's partitions keep
 * landing where they always did. The token is never derived from anything: it is
 * `randomBytes`, and losing the file loses it forever (recover issues a new one).
 */
export async function loadOrCreatePrincipal(home?: string): Promise<Principal> {
  const existing = await readPrincipal(home);
  if (existing) return existing;

  // The segment comes from the same resolution writes use, not from a new rule —
  // a brand-new install must not start filing under a segment its own CLI would
  // never resolve to. (resolveUser is env-sensitive, which is why the file freezes
  // it: after creation the file, not the ambient env, is the identity.)
  const user = resolveUser();
  const principal: Principal = {
    token: randomBytes(32).toString("base64url"),
    user,
    path: principalKeyPath(home),
    createdAt: new Date().toISOString(),
  };
  await writePrincipalFile(principal, home);
  return principal;
}

/**
 * Overwrite the key file — the recover path's one-way write, and creation's. The new
 * content is written tmp + chmod + rename (the `.env` writer's discipline,
 * `src/core/envFile.ts`): `writeFile`'s own mode is masked by the umask, so the
 * owner-only mode exists only through the explicit `chmod`.
 *
 * The mode itself is a POSIX fact. On Windows Node's `chmod` has no permission bits to
 * set — the call is a no-op — and the file's protection is the ACL it inherits from the
 * memory home, which by default sits in the user profile directory (`os.homedir()`),
 * the same inheritance `%APPDATA%` relies on. That is the honest statement of the
 * Windows story; there is no 0600 on Windows to point at.
 */
async function writePrincipalFile(principal: Principal, home?: string): Promise<void> {
  const dir = resolveHome(home);
  await mkdir(dir, { recursive: true });
  const body: PrincipalFile = {
    version: FORMAT,
    token: principal.token,
    user: principal.user,
    createdAt: principal.createdAt,
  };
  const tmp = `${principal.path}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    await chmod(tmp, 0o600);
    await rename(tmp, principal.path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Recover (P7, `ai-memory principal recover --from-db`): re-bind this principal to the
 * user segment the store's own partitions declare, and issue a fresh token.
 *
 * One-way by construction and honest about what it does not do: the lost token is never
 * reconstructed — nothing in the store can produce it — so recover writes a NEW secret
 * and every client holding the old one re-reads the file on its next start. The `user`
 * is read *from the data* (the most frequent user segment across the store's
 * partitions, the legacy `default:default` excluded because it says nothing about who
 * owns anything), which is the only fact the store can vouch for.
 */
export async function recoverPrincipal(
  namespaces: string[],
  home?: string
): Promise<Principal> {
  const previous = await readPrincipal(home);
  const principal: Principal = {
    token: randomBytes(32).toString("base64url"),
    user: recoverUserFromNamespaces(namespaces),
    path: principalKeyPath(home),
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  };
  await writePrincipalFile(principal, home);
  return principal;
}

/**
 * The user segment recover re-binds to. Frequency vote over the partitions the store
 * actually holds; a store with nothing but legacy rows recovers as `default`, which
 * keeps exactly those rows readable (they are all `default:default`).
 */
export function recoverUserFromNamespaces(namespaces: string[]): string {
  const votes = new Map<string, number>();
  for (const ns of namespaces) {
    if (ns === LEGACY) continue;
    const segment = parseNamespaceKey(ns).userId;
    votes.set(segment, (votes.get(segment) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [segment, count] of [...votes.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (count > bestCount) {
      best = segment;
      bestCount = count;
    }
  }
  return best ?? "default";
}

/**
 * The segment a namespace claims. Parse matches what `allPartitions` filters with and
 * what the store partitions by — one parser for the boundary, not a second dialect.
 */
export function namespaceUserSegment(ns: string): string {
  return parseNamespaceKey(ns).userId;
}

/**
 * Whether a partition is this principal's to address. Two doors, and only two: the
 * principal's own user segment, and the legacy `default:default` — which every read
 * fan-out already covers and where every pre-scoping row lives, so exempting it is what
 * keeps existing stores and the seed readable without a namespace migration. Anything
 * else (a foreign segment, a `*:default` a caller invented) is out of bounds and the
 * routes refuse it with 403 rather than quietly relabeling it.
 */
export function isPrincipalNamespace(ns: string, user: string): boolean {
  if (ns === LEGACY) return true;
  return namespaceUserSegment(ns) === user;
}

/** The first out-of-bounds entry in a `namespaces` list, or null when all pass. */
export function findForeignNamespace(list: string[], user: string): string | null {
  for (const ns of list) if (!isPrincipalNamespace(ns, user)) return ns;
  return null;
}

/**
 * Token comparison. Constant-time for equal-length inputs; a length mismatch cannot be
 * made constant-time without leaking only the length, which is not a secret worth the
 * plumbing (tokens are fixed-width base64url of 32 bytes).
 */
export function sameToken(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Deliberately absent from this module: any way for the daemon to hand the active token
 * to a browser page it serves. The first cut injected it as a `<meta>` tag into the
 * served HTML, and independent review broke the whole boundary with one request: an
 * unauthenticated `GET /graph.html` returned the live token in the body, so a process
 * under another OS account — the exact threat this module exists for — could mint the
 * header without ever reading the key file. No delivery channel is narrower than the
 * HTTP port itself. The console therefore authenticates like every other client: the
 * operator pastes the token once (401 gate, `ui/src/components/PrincipalGate.tsx`) and
 * the browser keeps it in localStorage. Nothing this daemon serves to an
 * unauthenticated reader contains the token.
 */
