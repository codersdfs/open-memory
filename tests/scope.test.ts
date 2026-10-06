import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  allPartitions,
  resolveAgent,
  resolveUser,
  resolveScopeKeys,
  resolveWriteKey,
  resolveRequestScope,
  scopeOfNamespace,
  agentOfNamespace,
  sanitizeSegment,
  resetScopeCache,
  detectAgent,
  SHARED_AGENT,
  LEGACY_NAMESPACE
} from "../src/core/scope.js";
import { parseNamespaceKey, namespaceKey } from "../src/core/types.js";

const ENV_KEYS = [
  "AI_MEMORY_AGENT",
  "MEMORY_AGENT",
  "AI_MEMORY_USER",
  "MEMORY_USER",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "ANTHROPIC_AGENT_ID",
  "CODEX_SANDBOX",
  "CODEX_HOME",
  "CODEX_THREAD_ID",
  "DSH_HOME",
  "DSH_SESSION_ID",
  "DSH_AGENT",
  "PI_HOME",
  "PI_SESSION_ID",
  "PI_AGENT"
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetScopeCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetScopeCache();
});

describe("scope resolution", () => {
  it("explicit namespace wins over everything (backward compatibility)", () => {
    const keys = resolveScopeKeys({
      namespace: "legacy:1",
      agent: "claude",
      user: "alice",
      scope: "shared"
    });
    expect(keys).toEqual(["legacy:1"]);
  });

  it("private search reads own layer, the shared layer, then the legacy partition", () => {
    const keys = resolveScopeKeys({ agent: "codex", user: "alice" });
    // The legacy partition rides along on every read so that memories written
    // before layering existed stay reachable. See withLegacy in scope.ts.
    expect(keys).toEqual(["codex:alice", "shared:alice", LEGACY_NAMESPACE]);
  });

  it("explicit shared scope reads only the shared layer", () => {
    expect(resolveScopeKeys({ agent: "codex", user: "alice", scope: "shared" })).toEqual(["shared:alice"]);
  });

  it("--all sweeps every partition this user owns, and nobody else's", async () => {
    const store = {
      distinctNamespaces: async () => [
        "pi:alice",
        "coding-agent:alice",
        "shared:alice",
        "claude:bob",
        "default:default"
      ]
    };
    const keys = await allPartitions(store, "alice");
    expect(keys).toEqual(["coding-agent:alice", "default:default", "pi:alice", "shared:alice"]);
    expect(keys, "another person's partition is never in a sweep").not.toContain("claude:bob");
  });

  it("writes never merge layers", () => {
    expect(resolveWriteKey({ agent: "claude", user: "alice" })).toBe("claude:alice");
    expect(resolveWriteKey({ agent: "claude", user: "alice", scope: "shared" })).toBe("shared:alice");
  });

  it("includeShared:false gives the private layer alone", () => {
    expect(resolveScopeKeys({ agent: "pi", user: "bob", includeShared: false })).toEqual(["pi:bob"]);
  });

  it("the shared agent does not double-read", () => {
    expect(resolveScopeKeys({ agent: SHARED_AGENT, user: "alice" })).toEqual(["shared:alice", LEGACY_NAMESPACE]);
  });

  it("agent comes from env before detection, explicit before env", () => {
    process.env.CLAUDECODE = "1";
    expect(resolveAgent()).toBe("claude");
    process.env.AI_MEMORY_AGENT = "codex";
    expect(resolveAgent()).toBe("codex");
    expect(resolveAgent("pi")).toBe("pi");
  });

  it("detects each agent from its own env markers", () => {
    expect(detectAgent({ CODEX_THREAD_ID: "t" } as NodeJS.ProcessEnv)).toBe("codex");
    expect(detectAgent({ DSH_HOME: "d" } as NodeJS.ProcessEnv)).toBe("dsh");
    expect(detectAgent({ PI_SESSION_ID: "p" } as NodeJS.ProcessEnv)).toBe("pi");
    expect(detectAgent({ CLAUDE_CODE_ENTRYPOINT: "cli" } as NodeJS.ProcessEnv)).toBe("claude");
    expect(detectAgent({} as NodeJS.ProcessEnv)).toBe(null);
  });

  it("unknown but named agent ids still layer with shared", () => {
    expect(resolveScopeKeys({ agent: "cursor", user: "alice" })).toEqual(["cursor:alice", "shared:alice", LEGACY_NAMESPACE]);
  });

  it("no agent identity means no surprise layer fan-out", () => {
    // Still one layer — but it never loses the partition its own pre-layering
    // memories went to (LEGACY_NAMESPACE is what resolveWriteKey wrote before
    // ADR-0007 existed for a caller that had no user segment).
    expect(resolveScopeKeys({ user: "alice" })).toEqual(["default:alice", LEGACY_NAMESPACE]);
  });
});

describe("partition key hygiene", () => {
  it("strips colons so parseNamespaceKey round-trips", () => {
    expect(sanitizeSegment("a:b c", "default")).toBe("a-b-c");
    const key = resolveWriteKey({ agent: "claude", user: "alice:work" });
    expect(key).toBe("claude:alice-work");
    const parsed = parseNamespaceKey(key);
    expect(parsed.agentId).toBe("claude");
    expect(parsed.userId).toBe("alice-work");
    expect(namespaceKey(parsed)).toBe(key);
  });

  it("falls back when a segment is fully stripped", () => {
    expect(sanitizeSegment("://", "default")).toBe("default");
  });

  it("classifies stored partitions", () => {
    expect(scopeOfNamespace("shared:alice")).toBe("shared");
    expect(scopeOfNamespace("claude:alice")).toBe("private");
    expect(agentOfNamespace("shared:alice")).toBe("shared");
    expect(agentOfNamespace(LEGACY_NAMESPACE)).toBe("default");
  });
});

describe("request scope (query params / CLI flags / MCP args)", () => {
  it("reports which layers a search actually covered", () => {
    const r = resolveRequestScope({ agent: "claude", namespace: null, scope: null });
    expect(r.agent).toBe("claude");
    expect(r.scopes).toEqual(["private", "shared"]);
    expect(r.namespaces[0]).toMatch(/^claude:/);
  });

  it("explicit namespace reports a single layer", () => {
    const r = resolveRequestScope({ namespace: "shared:alice", agent: "codex" });
    expect(r.namespaces).toEqual(["shared:alice"]);
    expect(r.scopes).toEqual(["shared"]);
  });

  it("all:true sweeps both layers for the current user", () => {
    const r = resolveRequestScope({ agent: "dsh", all: true });
    expect(r.namespaces).toHaveLength(2);
    expect(r.scopes).toEqual(["private", "shared"]);
  });

  it("a bare request without an agent stays in the legacy family, no layer fan-out", () => {
    const r = resolveRequestScope({});
    expect(r.namespaces).toHaveLength(2);
    expect(r.namespaces[0]).toMatch(/^default:/);
  });
});

describe("user resolution", () => {
  it("honours AI_MEMORY_USER and sanitizes it", () => {
    process.env.AI_MEMORY_USER = "Frank Q:dev";
    resetScopeCache();
    expect(resolveUser()).toBe("Frank-Q-dev");
  });

  it("falls back to a real username, never empty", () => {
    delete process.env.AI_MEMORY_USER;
    resetScopeCache();
    expect(resolveUser().length).toBeGreaterThan(0);
    expect(resolveUser()).not.toContain(":");
  });
});
