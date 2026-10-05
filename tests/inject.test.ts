import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildInjection, parseHookPayload, deriveQuery, renderBlock } from "../src/adapters/inject.js";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";

/**
 * Hook-side tests.
 *
 * The contract that matters: a hook may only ever add text that is worth its tokens,
 * and it may never fail the user's turn. Every case below checks one half of that.
 */

const ENV_KEYS = ["AI_MEMORY_USER", "AI_MEMORY_AGENT", "AI_MEMORY_INJECT_BUDGET", "AI_MEMORY_INJECT_THRESHOLD", "MEMORY_USER", "MEMORY_AGENT", "DSH_HOME", "DSH_SESSION_ID", "CLAUDECODE", "CODEX_SANDBOX", "PI_HOME"];
let svc: MemoryService;

beforeEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.AI_MEMORY_USER = "hookuser";
  process.env.AI_MEMORY_AGENT = "claude";
  svc = new MemoryService({ store: new InMemoryVectorStore(), dedupThreshold: 0.99 });
  await svc.init();
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("hook payload parsing", () => {
  it("reads a Claude Code UserPromptSubmit payload", () => {
    const p = parseHookPayload(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "why is the build red?", session_id: "s1", cwd: "C:/code" })
    );
    expect(p.mode).toBe("prompt-submit");
    expect(p.prompt).toBe("why is the build red?");
    expect(p.sessionId).toBe("s1");
    expect(p.cwd).toBe("C:/code");
  });

  it("treats Stop and SessionEnd events as stop", () => {
    expect(parseHookPayload(JSON.stringify({ hook_event_name: "Stop" })).mode).toBe("stop");
    expect(parseHookPayload(JSON.stringify({ event: "SessionEnd" })).mode).toBe("stop");
  });

  it("accepts a bare text payload", () => {
    const p = parseHookPayload("plain text prompt");
    expect(p.prompt).toBe("plain text prompt");
    expect(p.mode).toBe("prompt-submit");
  });

  it("survives malformed JSON without throwing", () => {
    const p = parseHookPayload("{ broken json");
    expect(p.prompt).toBe("{ broken json");
  });

  it("an explicit --mode wins over the event name", () => {
    expect(parseHookPayload(JSON.stringify({ hook_event_name: "UserPromptSubmit" }), "session-start").mode).toBe("session-start");
  });
});

describe("query derivation", () => {
  it("uses the first line as the query and pulls keywords from the whole prompt", () => {
    const { query, keywords } = deriveQuery(parseHookPayload("How do I deploy the billing worker?\nAlso mention kubernetes."));
    expect(query).toBe("How do I deploy the billing worker?");
    expect(keywords).toContain("deploy");
    expect(keywords).toContain("kubernetes");
  });

  it("returns nothing for an empty prompt", () => {
    expect(deriveQuery(parseHookPayload("   "))).toEqual({ query: "", keywords: [] });
  });
});

describe("injection", () => {
  it("prints a context block when a memory matches", async () => {
    await svc.save({
      namespace: "shared:hookuser",
      type: "procedural",
      text: "Deploy the billing worker with: pnpm run deploy:billing.",
      importance: 0.9
    });
    const block = await buildInjection({ service: svc, agent: "claude", stdin: "how do I deploy the billing worker" });
    expect(block).toContain("<memory-context>");
    expect(block).toContain("pnpm run deploy:billing");
    expect(block).toContain("shared/procedural");
    expect(block).toContain("</memory-context>");
  });

  it("prints nothing when there is no match (no empty headers, no pollution)", async () => {
    const block = await buildInjection({ service: svc, agent: "claude", stdin: "quantum entanglement in photosynthesis" });
    expect(block).toBe("");
  });

  it("prints nothing on Stop", async () => {
    await svc.save({ namespace: "claude:hookuser", type: "semantic", text: "A memorable fact about the deploy script." });
    const block = await buildInjection({ service: svc, agent: "claude", stdin: JSON.stringify({ hook_event_name: "Stop", prompt: "deploy script" }) });
    expect(block).toBe("");
  });

  it("does not leak another agent's private layer", async () => {
    await svc.save({ namespace: "codex:hookuser", type: "semantic", text: "Codex private note about the deploy script." });
    const block = await buildInjection({ service: svc, agent: "claude", stdin: "deploy script" });
    expect(block).toBe("");
  });

  it("honours the token budget", async () => {
    for (let i = 0; i < 8; i++) {
      await svc.save({
        namespace: "claude:hookuser",
        type: "semantic",
        text: `Budget filler ${i}: the deploy script ${i} has a long description that consumes tokens ${"padding ".repeat(30)}`
      });
    }
    const block = await buildInjection({ service: svc, agent: "claude", stdin: "deploy script budget filler", budgetTokens: 40 });
    // 40 tokens is ~160 chars; the block must stay in that ballpark, header included.
    expect(block.length).toBeLessThan(1200);
    expect(block.split("\n").filter((l) => l.startsWith("- (")).length).toBeLessThanOrEqual(2);
  });

  it("finds nothing when the agent is unknown rather than failing", async () => {
    const block = await buildInjection({ service: svc, agent: "some-new-agent", stdin: "deploy script" });
    expect(block).toBe("");
  });
});

describe("block rendering", () => {
  it("labels layers and warns about staleness", () => {
    const block = renderBlock(
      [
        { id: "1", text: "shared fact", type: "semantic", namespace: "shared:u" },
        { id: "2", text: "private fact", type: "procedural", namespace: "claude:u" }
      ],
      { agent: "claude", cwd: "C:/code" }
    );
    expect(block).toContain("(shared/semantic) shared fact");
    expect(block).toContain("(private/procedural) private fact");
    expect(block).toMatch(/may be stale/);
    expect(block).toContain("C:/code");
  });
});
