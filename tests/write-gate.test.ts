import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import { CurationRejected } from "../src/core/write/curation.js";

/**
 * The write gate is the one gate wired to the network, so every test here owns its
 * fetch stub: the endpoint answers the systemOne protocol ({answers: {keep, scaffold}}),
 * and the stub counts calls, because "the gate never asked" is as much of a contract
 * as "the gate asked and priced". Fail-open is a test, not a comment.
 */
describe("the write gate (the second, model-judged gate)", () => {
  let savedEnv: NodeJS.ProcessEnv;
  let realFetch: typeof fetch;
  let calls: number;

  const answer = (keep: number, scaffold: number) => {
    calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          model: "stub",
          answers: {
            keep: { type: "noul", noul: keep },
            scaffold: { type: "noul", noul: scaffold },
          },
        }),
      };
    }) as unknown as typeof fetch;
  };

  const makeSvc = () => {
    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider(), dedupThreshold: 0.99 });
    return svc.init().then(() => svc);
  };

  beforeEach(() => {
    savedEnv = { ...process.env };
    realFetch = globalThis.fetch;
    calls = 0;
    process.env.JEV_API_KEY = "test-key";
    delete process.env.MEMORY_WRITE_GATE;
    delete process.env.MEMORY_WRITE_GATE_MIN;
    delete process.env.MEMORY_JEV;
  });

  afterEach(() => {
    process.env = savedEnv;
    globalThis.fetch = realFetch;
  });

  it("prices a derived importance from the verdict and tags the row", async () => {
    answer(0.9, 0.1);
    const svc = await makeSvc();
    const { memory } = await svc.saveDetailed({ namespace: "claude:u", type: "semantic", text: "the index rebuild runs every night at 03:00 without supervision" });
    expect(memory.importance).toBe(0.85); // importanceFor(0.9)
    expect(memory.tags).toContain("judged:write-gate");
    expect(calls).toBe(1);
    svc.close();
  });

  it("refuses an extractor-sourced write the model answered below the floor", async () => {
    answer(0.2, 0.3);
    const svc = await makeSvc();
    await expect(
      svc.save({ namespace: "claude:u", type: "semantic", text: "a long enough sentence the gate will judge as junk", source: "extractor" })
    ).rejects.toBeInstanceOf(CurationRejected);
    expect((await svc.list({ namespace: "claude:u" })).total).toBe(0);
    svc.close();
  });

  it("demotes — never refuses — an explicit write the model answered below the floor", async () => {
    answer(0.2, 0.3);
    const svc = await makeSvc();
    const { memory, curation } = await svc.saveDetailed({ namespace: "claude:u", type: "semantic", text: "a long enough sentence the gate will judge as junk" });
    expect(memory.kind).toBe("note");
    expect(memory.importance).toBe(0.35);
    expect(memory.tags).toContain("curation:low-value");
    expect(curation?.junk).toBe("low-value");
    svc.close();
  });

  it("a scaffold verdict sinks the row even when keep is high", async () => {
    answer(0.95, 0.7);
    const svc = await makeSvc();
    // Lexically clean on purpose — curation has no structural tell for a config dump
    // without pipes, colons or tool tokens. This is exactly the class the model is for.
    const { memory } = await svc.saveDetailed({ namespace: "claude:u", type: "semantic", text: "allowedAgents for planner.md is researcher, scout, designer and the router picks by task shape" });
    expect(memory.kind).toBe("note");
    expect(memory.importance).toBe(0.35);
    svc.close();
  });

  it("a caller who named a kind or an importance is tagged, not demoted", async () => {
    answer(0.2, 0.3);
    const svc = await makeSvc();
    const { memory, curation } = await svc.saveDetailed({ namespace: "claude:u", type: "semantic", text: "a long enough sentence the gate will judge as junk", kind: "task", importance: 0.9 });
    expect(memory.kind).toBe("task");
    expect(memory.importance).toBe(0.9);
    expect(memory.tags).toContain("judged:write-gate");
    expect(curation).toBeUndefined();
    svc.close();
  });

  it("fails open: a judge that cannot be reached stores the write unjudged", async () => {
    calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const svc = await makeSvc();
    const { memory } = await svc.saveDetailed({ namespace: "claude:u", type: "semantic", text: "a long enough sentence for the gate to look at" });
    expect(memory.importance).toBe(0.5); // store default, untouched
    expect(memory.tags ?? []).toEqual([]);
    expect(calls).toBeGreaterThan(0);
    svc.close();
  });

  it("never asks when there is no key", async () => {
    delete process.env.JEV_API_KEY;
    calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("must not be reached");
    }) as unknown as typeof fetch;
    const svc = await makeSvc();
    await svc.saveDetailed({ namespace: "claude:u", type: "semantic", text: "a long enough sentence for the gate to look at" });
    expect(calls).toBe(0);
    svc.close();
  });

  it("never asks twice: a row jev already priced skips the gate", async () => {
    answer(0.1, 0.1);
    const svc = await makeSvc();
    const { memory } = await svc.saveDetailed({ namespace: "claude:u", type: "semantic", text: "the extractor already had its own judgement about this sentence", tags: ["judged:jev"] });
    expect(calls).toBe(0);
    expect(memory.tags).toContain("judged:jev");
    expect(memory.importance).toBe(0.5);
    svc.close();
  });

  it("MEMORY_WRITE_GATE=false turns this gate off alone", async () => {
    process.env.MEMORY_WRITE_GATE = "false";
    calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("must not be reached");
    }) as unknown as typeof fetch;
    const svc = await makeSvc();
    await svc.saveDetailed({ namespace: "claude:u", type: "semantic", text: "a long enough sentence for the gate to look at" });
    expect(calls).toBe(0);
    svc.close();
  });
});
