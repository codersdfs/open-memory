import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { codebaseSearch, codebaseSymbolDetail, renderCodeSymbol } from "../src/core/codebase/view.js";
import type { AddressInfo } from "node:net";
import { buildServer } from "../src/api/server.js";

/**
 * The read layer over the code index (ADR-0050): deterministic scoring, the hard
 * token budget, symbol detail with evidence-labelled edges, forget, and the four
 * HTTP routes the daemon exposes.
 */

let dir: string;
let svc: MemoryService;
const PROJECT = "cbapi";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ai-memory-codebase-api-"));
  svc = new MemoryService({ store: new InMemoryVectorStore() });
  await svc.init();
  writeFileSync(join(dir, "alpha.ts"), `export function alphaTarget(s: string): string { return s; }\nexport function alphaUser(): string { return alphaTarget("x"); }\n`);
  writeFileSync(join(dir, "beta.ts"), `import { alphaTarget } from "./alpha";\nexport const betaCall = (): string => alphaTarget("y");\n`);
  await svc.codebaseSync({ root: dir, project: PROJECT });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("codebaseSearch", () => {
  it("ranks exact above prefix above substring, then exported, fan-in, path", async () => {
    const exact = await codebaseSearch(svc.store, { project: PROJECT, query: "alphaTarget", k: 10 });
    expect(exact.symbols[0]!.qualifiedName).toBe("alphaTarget");
    expect(exact.symbols[0]!.score).toBe(1);
    const result = await codebaseSearch(svc.store, { project: PROJECT, query: "alpha", k: 10 });
    const names = result.symbols.map((s) => s.qualifiedName);
    expect(names[0]).toBe("alphaTarget");
    expect(names).toContain("alphaUser");
    expect(result.symbols[0]!.score).toBe(0.8); // "alpha" prefixes both — the tie breaks on fan-in
  });

  it("honours the hard token budget and reports truncation", async () => {
    const result = await codebaseSearch(svc.store, { project: PROJECT, query: "alpha", k: 10, budgetTokens: 1 });
    expect(result.truncated).toBe(true);
    expect(result.symbols.length).toBe(1);
    expect(result.tokensUsed).toBeGreaterThan(0);
  });

  it("answers empty with a stable shape", async () => {
    const result = await codebaseSearch(svc.store, { project: PROJECT, query: "zzz-nonexistent" });
    expect(result.symbols).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });
});

describe("codebaseSymbolDetail", () => {
  it("shows importers, callers and callees", async () => {
    const result = await codebaseSearch(svc.store, { project: PROJECT, query: "alphaTarget", k: 1 });
    const detail = await codebaseSymbolDetail(svc.store, { project: PROJECT, idOrName: result.symbols[0]!.id });
    expect(detail).not.toBeNull();
    // beta.ts imports alphaTarget; alphaUser calls it locally; betaCall's call edge
    // resolves through the import statement.
    expect(detail!.importers.some((m) => m.path === "beta.ts")).toBe(true);
    expect(detail!.callers.some((m) => m.qualifiedName === "alphaUser")).toBe(true);
    expect(detail!.callees).toHaveLength(0);
    expect(detail!.symbol.fanIn).toBeGreaterThanOrEqual(2);
  });

  it("resolves a unique bare name and refuses an ambiguous one", async () => {
    const byName = await codebaseSymbolDetail(svc.store, { project: PROJECT, idOrName: "alphaTarget" });
    expect(byName?.symbol.kind).toBe("function");
    writeFileSync(join(dir, "gamma.ts"), `function alphaTarget(): number { return 0; }\n`);
    await svc.codebaseSync({ root: dir, project: PROJECT });
    await expect(codebaseSymbolDetail(svc.store, { project: PROJECT, idOrName: "alphaTarget" })).rejects.toThrow(/ambiguous/);
  });

  it("returns null for an unknown symbol", async () => {
    expect(await codebaseSymbolDetail(svc.store, { project: PROJECT, idOrName: "no-such-symbol" })).toBeNull();
  });
});

describe("MemoryService codebase wrappers", () => {
  it("forgets a project's derived rows without touching the files", async () => {
    const out = await svc.codebaseForget({ project: PROJECT });
    expect(out.project).toBe(PROJECT);
    expect(out.symbols).toBeGreaterThan(0);
    const stats = await svc.store.codebase!.codeStats(PROJECT);
    expect(stats.symbols).toBe(0);
    expect(stats.edges).toBe(0);
  });

  it("falls back to the repository project when none is passed", async () => {
    await expect(svc.codebaseSearch({ query: "x", project: "nosuch" })).resolves.toBeTruthy();
    expect(await svc.codebaseSymbol({ idOrName: "x", project: null })).toBeNull();
  });
});

describe("codebase HTTP routes", () => {
  it("exposes index, search, symbol and forget through the daemon", async () => {
    const { app } = await buildServer({ service: svc });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    try {
      const index = await fetch(`${url}/codebase/index`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dir, project: PROJECT, dryRun: true }) });
      expect(index.status).toBe(200);
      expect(((await index.json()) as { dryRun: boolean }).dryRun).toBe(true);

      const search = await fetch(`${url}/codebase/search?q=alphaTarget&project=${PROJECT}`);
      expect(search.status).toBe(200);
      const searchBody = (await search.json()) as { symbols: { qualifiedName: string }[] };
      expect(searchBody.symbols[0]!.qualifiedName).toBe("alphaTarget");

      const detail = await fetch(`${url}/codebase/symbol/${encodeURIComponent("alphaTarget")}?project=${PROJECT}`);
      expect(detail.status).toBe(200);
      const detailBody = (await detail.json()) as { symbol: { qualifiedName: string } };
      expect(detailBody.symbol.qualifiedName).toBe("alphaTarget");

      const forget = await fetch(`${url}/codebase?project=${PROJECT}`, { method: "DELETE" });
      expect(forget.status).toBe(200);
      expect(((await forget.json()) as { project: string }).project).toBe(PROJECT);
    } finally {
      await new Promise<void>((resolveClose) => app.close(() => resolveClose()));
    }
  });
});
