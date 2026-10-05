import os from "node:os";
import { namespaceKey, parseNamespaceKey, type MemoryScope } from "./types.js";

export type { MemoryScope };

/**
 * Cross-agent scope model (ADR-0007).
 *
 * A partition key is still `agentId:userId`. What changes is the meaning of
 * `agentId`:
 *   - `shared`  → the shared layer every agent may read/write
 *   - anything else → that agent's private layer
 *
 * Search therefore fans out over `[<agent>:<user>, shared:<user>]`, which is what
 * makes "Codex recalls what Claude learned" work without either agent knowing
 * about the other. An explicit `namespace` always wins, so every pre-existing
 * caller keeps its exact old behaviour.
 */

export const SCOPES = ["private", "shared"] as const;

/** Known agent ids. Unknown ids are allowed: this list is for detection + display. */
export const AGENT_IDS = ["claude", "codex", "dsh", "pi"] as const;
export type AgentId = (typeof AGENT_IDS)[number] | string;

/** Agent id used by the shared layer. */
export const SHARED_AGENT = "shared";

/** Default legacy partition, unchanged from v0.2.0. */
export const LEGACY_NAMESPACE = "default:default";

export function isScope(v: unknown): v is MemoryScope {
  return v === "private" || v === "shared";
}

/** Partition keys must survive `parseNamespaceKey`'s `split(":")`, so no colons. */
export function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/[\s:]+/g, "-")
    .replace(/[^A-Za-z0-9._@-]/g, "")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : fallback;
}

let cachedUser: string | null = null;
/** The env override the cache was computed under, so a later change is respected. */
let cachedUserEnv: string | undefined;

/**
 * `AI_MEMORY_USER` → `MEMORY_USER` → OS username.
 *
 * An explicit env override is re-read every call: a process that changes who it
 * is acting as (a test, a wrapper script, a hook that runs for another user) must
 * not keep writing into the first user's layer. Only the OS lookup is memoized,
 * and it is invalidated if the override appears or changes.
 */
export function resolveUser(explicit?: string): string {
  if (explicit && explicit.trim()) return sanitizeSegment(explicit, "default");
  const fromEnv = process.env.AI_MEMORY_USER ?? process.env.MEMORY_USER;
  if (fromEnv && fromEnv.trim()) {
    // Env overrides are never cached: they are the caller's live intent.
    cachedUser = null;
    cachedUserEnv = fromEnv;
    return sanitizeSegment(fromEnv, "default");
  }
  if (cachedUser && cachedUserEnv === undefined) return cachedUser;
  let name = "default";
  try {
    name = os.userInfo().username || "default";
  } catch {
    name = process.env.USERNAME ?? process.env.USER ?? "default";
  }
  cachedUser = sanitizeSegment(name, "default");
  cachedUserEnv = undefined;
  return cachedUser;
}

/** Test seam: clears the memoized user. */
export function resetScopeCache(): void {
  cachedUser = null;
  cachedUserEnv = undefined;
}

/**
 * Which agent is asking. Explicit argument always wins, then env, then sniffing.
 * A wrong guess only affects which private layer is read — it can never grant
 * access to another user's layers — so sniffing is safe as a fallback.
 */
export function resolveAgent(explicit?: string): string {
  if (explicit && explicit.trim()) return sanitizeSegment(explicit, "default");
  const fromEnv = process.env.AI_MEMORY_AGENT ?? process.env.MEMORY_AGENT;
  if (fromEnv && fromEnv.trim()) return sanitizeSegment(fromEnv, "default");
  const detected = detectAgent();
  return detected ?? "default";
}

export function detectAgent(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.ANTHROPIC_AGENT_ID) return "claude";
  if (env.CODEX_SANDBOX || env.CODEX_HOME || env.CODEX_THREAD_ID) return "codex";
  if (env.DSH_HOME || env.DSH_SESSION_ID || env.DSH_AGENT) return "dsh";
  if (env.PI_HOME || env.PI_SESSION_ID || env.PI_AGENT) return "pi";
  return null;
}

export interface ScopeKeysInput {
  agent?: string;
  user?: string;
  scope?: MemoryScope;
  /** Explicit partition from a legacy caller; wins over everything else. */
  namespace?: string;
  /** Merge the private layer with the shared layer. Defaults to true for bare callers. */
  includeShared?: boolean;
}

/**
 * Resolve the partitions a call should touch.
 *
 * `namespace` (when supplied) short-circuits to exactly that partition — this is
 * the compatibility guarantee. Otherwise:
 *   - write (`includeShared: false`): one partition, the scope's own.
 *   - read (`includeShared: true`): private then shared, in that priority order.
 */
export function resolveScopeKeys(input: ScopeKeysInput = {}): string[] {
  const explicit = input.namespace?.trim();
  if (explicit) return [explicit];

  const user = resolveUser(input.user);
  const agent = resolveAgent(input.agent);
  const scope = input.scope ?? "private";

  if (scope === "shared") return [namespaceKey({ agentId: SHARED_AGENT, userId: user })];

  const own = namespaceKey({ agentId: agent, userId: user });
  const shared = namespaceKey({ agentId: SHARED_AGENT, userId: user });
  if (input.includeShared === false) return [own];
  // A caller with no agent identity is a legacy caller: it gets exactly the one
  // partition it always got, never a surprise two-layer fan-out. Layering is
  // opt-in by naming the agent (flag, `AI_MEMORY_AGENT`, or a detection marker).
  if (agent === "default" || agent === SHARED_AGENT) return [own];
  return [own, shared];
}

/** The single partition a write lands in. */
export function resolveWriteKey(input: Omit<ScopeKeysInput, "includeShared"> = {}): string {
  return resolveScopeKeys({ ...input, includeShared: false })[0]!;
}

/** Which layer a stored partition belongs to. */
export function scopeOfNamespace(key: string): MemoryScope {
  return parseNamespaceKey(key).agentId === SHARED_AGENT ? "shared" : "private";
}

/** Which agent owns a stored partition (may be `shared`). */
export function agentOfNamespace(key: string): string {
  return parseNamespaceKey(key).agentId;
}

/**
 * Query params / CLI flags / MCP args → resolved partitions.
 * Accepts the legacy `namespace` field and the new `agent` + `scope` fields.
 * `agent` alone (no namespace) means "this agent's layer AND the shared layer".
 *
 * Read-path only: writes must go through `resolveWriteKey` so an omitted scope
 * can never land a private note in the shared layer.
 */
export function resolveRequestScope(q: {
  namespace?: string | null;
  agent?: string | null;
  scope?: string | null;
  all?: boolean;
}): { namespaces: string[]; agent: string; scopes: MemoryScope[] } {
  const agent = resolveAgent(q.agent ?? undefined);
  const explicit = q.namespace?.trim();

  let namespaces: string[];
  if (explicit) {
    namespaces = [explicit];
  } else if (q.all) {
    const user = resolveUser();
    namespaces = [
      namespaceKey({ agentId: agent, userId: user }),
      namespaceKey({ agentId: SHARED_AGENT, userId: user })
    ];
  } else if (isScope(q.scope)) {
    namespaces = resolveScopeKeys({ agent, scope: q.scope });
  } else {
    namespaces = resolveScopeKeys({ agent, scope: "private" });
  }

  const scopes = [...new Set(namespaces.map(scopeOfNamespace))];
  return { namespaces, agent, scopes };
}
