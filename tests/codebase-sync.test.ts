import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { SqliteVectorStore } from "../src/core/store/sqlite.js";
import { syncCodebase } from "../src/core/codebase/sync.js";
import type { CodeSymbolRow } from "../src/core/codebase/types.js";

/**
 * The sync contract (ADR-0050): the files are the truth, the tables are derived.
 *   1. a sync is idempotent — unchanged hashes write nothing;
 *   2. it is incremental — one changed file rewrites its own symbols and edges only;
 *   3. removals clean up — a deleted file's symbols and every edge touching them go;
 *   4. malformed files do not abort the sync.
 */

let dir: string;
let store: InMemoryVectorStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-memory-codebase-"));
  store = new InMemoryVectorStore();
  writeFileSync(join(dir, "helper.ts"), `export function helper(s: string): string { return s + "!"; }\n`);
  writeFileSync(join(dir, "index.ts"), `import { helper } from "./helper";\nexport const main = (): string => {\n  return helper("x");\n};\n`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sync = (opts: { project?: string; dryRun?: boolean } = {}) =>
  syncCodebase({ store }, { root: dir, project: "cbproj", ...opts });

const symbols = async (): Promise<CodeSymbolRow[]> => (await store.codebase!.codeSymbols("cbproj", { includeModules: true }));

const ALIAS_TSCONFIG = `{
  // compiler options
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@app/*": ["src/*"] }
  }
}
`;

describe("codebase sync", () => {
  it("indexes files, symbols, import edges and call edges", async () => {
    const report = await sync();
    expect(report.files).toBe(2);
    expect(report.indexed).toBe(2);
    expect(report.skipped).toBe(0);
    expect(report.parseErrors).toBe(0);
    expect(report.symbols).toBe(4); // 2 modules + helper + main
    expect(report.edges).toBe(2); // module(index)→helper, main→helper

    const rows = await symbols();
    const helper = rows.find((r) => r.qualifiedName === "helper");
    const main = rows.find((r) => r.qualifiedName === "main");
    expect(helper?.exported).toBe(true);
    expect(helper?.kind).toBe("function");
    const edges = await store.codebase!.codeEdges("cbproj", main!.id, "out");
    const call = edges.find((e) => e.kind === "calls" && e.toId === helper!.id);
    expect(call?.evidence).toBe("import");
    const importers = await store.codebase!.codeEdges("cbproj", helper!.id, "in");
    expect(importers.some((e) => e.kind === "imports")).toBe(true);
    expect(helper!.fanIn).toBe(1);
  });

  it("is idempotent — unchanged hashes write nothing", async () => {
    await sync();
    const again = await sync();
    expect(again.indexed).toBe(0);
    expect(again.skipped).toBe(2);
    expect(again.symbols).toBe(0);
  });

  it("dry run changes nothing", async () => {
    const report = await sync({ dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.symbols).toBe(4);
    expect(await symbols()).toHaveLength(0);
  });

  it("re-indexes only the changed file", async () => {
    await sync();
    writeFileSync(join(dir, "index.ts"), `import { helper } from "./helper";\nexport const main = (): string => helper("x");\nexport function extra(): number { return helper("y").length; }\n`);
    const report = await sync();
    expect(report.indexed).toBe(1);
    expect(report.skipped).toBe(1);
    const rows = await symbols();
    expect(rows.some((r) => r.qualifiedName === "extra")).toBe(true);
    expect(report.symbols).toBe(3); // 1 module + main + extra, written by this run
  });

  it("deletes a removed file's symbols and every edge touching them", async () => {
    await sync();
    unlinkSync(join(dir, "helper.ts"));
    expect(existsSync(join(dir, "helper.ts"))).toBe(false);
    const report = await sync();
    expect(report.removed).toBe(1);
    const rows = await symbols();
    expect(rows.some((r) => r.qualifiedName === "helper")).toBe(false);
    const main = rows.find((r) => r.qualifiedName === "main");
    const edges = await store.codebase!.codeEdges("cbproj", main!.id, "out");
    expect(edges).toHaveLength(0); // the call edge died with its target
    expect(main!.fanIn).toBe(0);
  });

  it("does not abort on a malformed file and records it", async () => {
    writeFileSync(join(dir, "broken.ts"), "function (((((( {\n");
    const report = await sync();
    expect(report.parseErrors).toBe(0);
    expect(report.indexed).toBe(3);
    const stats = await store.codebase!.codeStats("cbproj");
    expect(stats.files).toBe(3);
  });

  it("resolves member calls through annotated and constructed receivers", async () => {
    writeFileSync(join(dir, "alpha.ts"), `export class MemorySvc {\n  syncThing(): void {}\n  prepare(): void {}\n  static create(): MemorySvc { return new MemorySvc(); }\n}\n`);
    writeFileSync(join(dir, "beta.ts"), `import { MemorySvc } from "./alpha";\nexport function run(svc: MemorySvc): void {\n  svc.syncThing();\n}\nexport function make(): MemorySvc {\n  const svc = new MemorySvc();\n  svc.prepare();\n  return svc;\n}\nexport function boot(): MemorySvc {\n  return MemorySvc.create();\n}\n`);
    await sync();
    const rows = await symbols();
    const syncThing = rows.find((r) => r.qualifiedName === "MemorySvc.syncThing")!;
    const prepare = rows.find((r) => r.qualifiedName === "MemorySvc.prepare")!;
    const create = rows.find((r) => r.qualifiedName === "MemorySvc.create")!;
    const callsOf = async (qualifiedName: string) => {
      const sym = rows.find((r) => r.qualifiedName === qualifiedName)!;
      return (await store.codebase!.codeEdges("cbproj", sym.id, "out")).filter((e) => e.kind === "calls");
    };
    const runCalls = await callsOf("run");
    expect(runCalls.find((e) => e.toId === syncThing.id)?.evidence).toBe("import");
    const makeCalls = await callsOf("make");
    expect(makeCalls.find((e) => e.toId === prepare.id)?.evidence).toBe("import");
    const bootCalls = await callsOf("boot");
    expect(bootCalls.find((e) => e.toId === create.id)?.evidence).toBe("import");
    expect(syncThing.fanIn).toBe(1);
    expect(prepare.fanIn).toBe(1);
    expect(create.fanIn).toBe(1);
  });

  it("resolves this.method() to the enclosing class with local evidence", async () => {
    writeFileSync(join(dir, "solo.ts"), `export class SoloSvc {\n  run(): void {\n    this.step();\n  }\n  step(): void {}\n}\n`);
    await sync();
    const rows = await symbols();
    const step = rows.find((r) => r.qualifiedName === "SoloSvc.step")!;
    const runSym = rows.find((r) => r.qualifiedName === "SoloSvc.run")!;
    const out = (await store.codebase!.codeEdges("cbproj", runSym.id, "out")).filter((e) => e.kind === "calls");
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toBe("local");
    expect(out[0]!.toId).toBe(step.id);
    expect(step.fanIn).toBe(1);
  });

  it("resolves a same-file annotated receiver with local evidence", async () => {
    writeFileSync(join(dir, "gamma.ts"), `class LocalSvc {\n  go(): void {}\n}\nexport function drive(svc: LocalSvc): void {\n  svc.go();\n}\n`);
    await sync();
    const rows = await symbols();
    const go = rows.find((r) => r.qualifiedName === "LocalSvc.go")!;
    const drive = rows.find((r) => r.qualifiedName === "drive")!;
    const out = (await store.codebase!.codeEdges("cbproj", drive.id, "out")).filter((e) => e.kind === "calls");
    expect(out.find((e) => e.toId === go.id)?.evidence).toBe("local");
    expect(go.fanIn).toBe(1);
  });

  it("builds no edge for a member call whose receiver has no binding", async () => {
    writeFileSync(join(dir, "alpha.ts"), `export class MemorySvc {\n  syncThing(): void {}\n}\n`);
    writeFileSync(join(dir, "delta.ts"), `export function loose(svc): void {\n  svc.syncThing();\n}\n`);
    await sync();
    const rows = await symbols();
    const syncThing = rows.find((r) => r.qualifiedName === "MemorySvc.syncThing")!;
    const loose = rows.find((r) => r.qualifiedName === "loose")!;
    const out = await store.codebase!.codeEdges("cbproj", loose.id, "out");
    expect(out).toHaveLength(0);
    expect(syncThing.fanIn).toBe(0);
  });

  it("collects harness-callback bodies onto the module node", async () => {
    writeFileSync(join(dir, "alpha.ts"), `export class MemorySvc {\n  syncThing(): void {}\n  prepare(): void {}\n}\n`);
    writeFileSync(join(dir, "remote.ts"), `export function remoteFn(): void {}\n`);
    writeFileSync(join(dir, "suite.test.ts"), [
      `import { MemorySvc } from "./alpha";`,
      `describe("suite", () => {`,
      `  beforeEach(() => {`,
      `    const svc = new MemorySvc();`,
      `    svc.prepare();`,
      `  });`,
      `  it("works", () => {`,
      `    svc.syncThing();`,
      `    remoteFn();`,
      `  });`,
      `});`
    ].join("\n") + "\n");
    await sync();
    const rows = await symbols();
    const moduleNode = rows.find((row) => row.path === "suite.test.ts" && row.kind === "module")!;
    const syncThing = rows.find((row) => row.qualifiedName === "MemorySvc.syncThing")!;
    const prepare = rows.find((row) => row.qualifiedName === "MemorySvc.prepare")!;
    const remoteFn = rows.find((row) => row.qualifiedName === "remoteFn")!;
    const out = (await store.codebase!.codeEdges("cbproj", moduleNode.id, "out")).filter((edge) => edge.kind === "calls");
    expect(out.find((edge) => edge.toId === syncThing.id)?.evidence).toBe("import");
    expect(out.find((edge) => edge.toId === prepare.id)?.evidence).toBe("import");
    expect(out.find((edge) => edge.toId === remoteFn.id)?.evidence).toBe("name-match");
    expect(syncThing.fanIn).toBe(1);
  });

  it("resolves two-level field chains through imported types", async () => {
    writeFileSync(join(dir, "alpha.ts"), `export class MemorySvc {\n  syncThing(): void {}\n}\n`);
    writeFileSync(join(dir, "ctx.ts"), `import { MemorySvc } from "./alpha";\nexport interface ToolCtx {\n  service: MemorySvc;\n}\n`);
    writeFileSync(join(dir, "runner.ts"), `import { ToolCtx } from "./ctx";\nexport function run(ctx: ToolCtx): void {\n  ctx.service.syncThing();\n}\n`);
    await sync();
    const rows = await symbols();
    const syncThing = rows.find((row) => row.qualifiedName === "MemorySvc.syncThing")!;
    const runSym = rows.find((row) => row.qualifiedName === "run")!;
    const out = (await store.codebase!.codeEdges("cbproj", runSym.id, "out")).filter((edge) => edge.kind === "calls");
    // run's refs also carry the annotated ToolCtx itself; the chain edge is the one to syncThing.
    expect(out.find((edge) => edge.toId === syncThing.id)?.evidence).toBe("import");
    expect(syncThing.fanIn).toBe(1);
  });

  it("resolves this.field.method() through the enclosing class's fields", async () => {
    writeFileSync(join(dir, "alpha.ts"), `export class MemorySvc {\n  syncThing(): void {}\n}\n`);
    writeFileSync(join(dir, "solo.ts"), `import { MemorySvc } from "./alpha";\nexport class SoloSvc {\n  private svc: MemorySvc;\n  run(): void {\n    this.svc.syncThing();\n  }\n}\n`);
    await sync();
    const rows = await symbols();
    const syncThing = rows.find((row) => row.qualifiedName === "MemorySvc.syncThing")!;
    const runSym = rows.find((row) => row.qualifiedName === "SoloSvc.run")!;
    const out = (await store.codebase!.codeEdges("cbproj", runSym.id, "out")).filter((edge) => edge.kind === "calls");
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toBe("local");
    expect(out[0]!.toId).toBe(syncThing.id);
    expect(syncThing.fanIn).toBe(1);
  });

  it("builds no edge when a two-level chain's target is ambiguous", async () => {
    writeFileSync(join(dir, "one.ts"), `export class MemorySvc {\n  syncThing(): void {}\n}\n`);
    writeFileSync(join(dir, "two.ts"), `export class MemorySvc {\n  syncThing(): void {}\n}\n`);
    writeFileSync(join(dir, "ctx.ts"), `import { MemorySvc } from "./one";\nexport interface ToolCtx {\n  service: MemorySvc;\n}\n`);
    writeFileSync(join(dir, "runner.ts"), `import { ToolCtx } from "./ctx";\nexport function run(ctx: ToolCtx): void {\n  ctx.service.syncThing();\n}\n`);
    await sync();
    const rows = await symbols();
    const runSym = rows.find((row) => row.qualifiedName === "run")!;
    const out = (await store.codebase!.codeEdges("cbproj", runSym.id, "out")).filter((edge) => edge.kind === "calls");
    const syncThings = rows.filter((row) => row.qualifiedName === "MemorySvc.syncThing");
    expect(out.find((edge) => syncThings.some((target) => target.id === edge.toId))).toBeUndefined();
    for (const sym of syncThings) {
      expect(sym.fanIn).toBe(0);
    }
  });

  it("resolves tsconfig paths aliases with alias evidence", async () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "tsconfig.json"), ALIAS_TSCONFIG);
    writeFileSync(join(dir, "src", "util.ts"), `export function usedHelper(s: string): string { return s; }\n`);
    writeFileSync(join(dir, "src", "caller.ts"), `import { usedHelper } from "@app/util";\nexport const run = (): string => usedHelper("x");\n`);
    const report = await sync();
    expect(report.parseErrors).toBe(0);
    const rows = await symbols();
    const usedHelper = rows.find((row) => row.qualifiedName === "usedHelper");
    expect(usedHelper?.path).toBe("src/util.ts");
    const callerModule = rows.find((row) => row.path === "src/caller.ts" && row.kind === "module")!;
    const out = await store.codebase!.codeEdges("cbproj", callerModule.id, "out");
    const edge = out.find((candidate) => candidate.kind === "imports" && candidate.toId === usedHelper!.id);
    expect(edge?.evidence).toBe("alias");
  });

  it("indexes dynamic import() and require() onto module-node edges", async () => {
    writeFileSync(join(dir, "dyn.ts"), `export async function load(): Promise<void> {\n  const mod = await import("./helper");\n  mod.helper("x");\n}\n`);
    writeFileSync(join(dir, "legacy.cjs"), `const { helper } = require("./helper");\nmodule.exports = helper;\n`);
    const report = await sync();
    expect(report.parseErrors).toBe(0);
    const rows = await symbols();
    const helperModule = rows.find((row) => row.path === "helper.ts" && row.kind === "module")!;
    const dynModule = rows.find((row) => row.path === "dyn.ts" && row.kind === "module")!;
    const cjsModule = rows.find((row) => row.path === "legacy.cjs" && row.kind === "module")!;
    const dynOut = await store.codebase!.codeEdges("cbproj", dynModule.id, "out");
    expect(dynOut.find((candidate) => candidate.kind === "imports" && candidate.toId === helperModule.id)?.evidence).toBe("import");
    const cjsOut = await store.codebase!.codeEdges("cbproj", cjsModule.id, "out");
    expect(cjsOut.find((candidate) => candidate.kind === "imports" && candidate.toId === helperModule.id)?.evidence).toBe("import");
  });

  it("builds no edge for an alias miss", async () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "tsconfig.json"), ALIAS_TSCONFIG);
    writeFileSync(join(dir, "src", "util.ts"), `export function usedHelper(s: string): string { return s; }\n`);
    writeFileSync(join(dir, "src", "caller.ts"), `import { ghost } from "@app/missing";\nexport const run = (): void => undefined;\n`);
    const report = await sync();
    expect(report.parseErrors).toBe(0);
    const rows = await symbols();
    const callerModule = rows.find((row) => row.path === "src/caller.ts" && row.kind === "module")!;
    const out = await store.codebase!.codeEdges("cbproj", callerModule.id, "out");
    expect(out.filter((candidate) => candidate.kind === "imports")).toHaveLength(0);
  });

  it("follows a re-export chain four hops to the exporting file", async () => {
    writeFileSync(join(dir, "target.ts"), `export function goal(): number { return 42; }\n`);
    writeFileSync(join(dir, "d.ts"), `export { goal } from "./target";\n`);
    writeFileSync(join(dir, "c.ts"), `export { goal } from "./d";\n`);
    writeFileSync(join(dir, "b.ts"), `export { goal } from "./c";\n`);
    writeFileSync(join(dir, "a.ts"), `export { goal } from "./b";\n`);
    writeFileSync(join(dir, "caller.ts"), `import { goal } from "./a";\nexport const use = (): number => goal();\n`);
    await sync();
    const rows = await symbols();
    const goal = rows.find((row) => row.qualifiedName === "goal");
    expect(goal?.path).toBe("target.ts");
    const callerModule = rows.find((row) => row.path === "caller.ts" && row.kind === "module")!;
    const out = await store.codebase!.codeEdges("cbproj", callerModule.id, "out");
    const edge = out.find((candidate) => candidate.kind === "imports" && candidate.toId === goal!.id);
    expect(edge?.evidence).toBe("re-export");
  });

  it("terminates on a re-export cycle with an honest miss", async () => {
    writeFileSync(join(dir, "loop-a.ts"), `export { ghost } from "./loop-b";\n`);
    writeFileSync(join(dir, "loop-b.ts"), `export { ghost } from "./loop-a";\n`);
    writeFileSync(join(dir, "user.ts"), `import { ghost } from "./loop-a";\nexport const run = (): void => undefined;\n`);
    const report = await sync();
    expect(report.parseErrors).toBe(0);
    const rows = await symbols();
    const userModule = rows.find((row) => row.path === "user.ts" && row.kind === "module")!;
    const out = await store.codebase!.codeEdges("cbproj", userModule.id, "out");
    expect(out.filter((candidate) => candidate.kind === "calls")).toHaveLength(0);
    // The import statement itself is real, so the module-node fallback to the
    // file the specifier landed on stands; the cycle never invents a symbol.
    const moduleA = rows.find((row) => row.path === "loop-a.ts" && row.kind === "module")!;
    const moduleB = rows.find((row) => row.path === "loop-b.ts" && row.kind === "module")!;
    expect(out.find((candidate) => candidate.kind === "imports" && candidate.toId === moduleA.id)?.evidence).toBe("import");
    expect(out.some((candidate) => candidate.kind === "imports" && candidate.toId === moduleB.id)).toBe(false);
  });

  it("resolves a barrel re-export whose specifier is a tsconfig alias", async () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "tsconfig.json"), ALIAS_TSCONFIG);
    writeFileSync(join(dir, "src", "deep.ts"), `export function deepHelper(): number { return 1; }\n`);
    writeFileSync(join(dir, "barrel.ts"), `export { deepHelper } from "@app/deep";\n`);
    writeFileSync(join(dir, "caller.ts"), `import { deepHelper } from "./barrel";\nexport const run = (): number => deepHelper();\n`);
    await sync();
    const rows = await symbols();
    const deepHelper = rows.find((row) => row.qualifiedName === "deepHelper");
    expect(deepHelper?.path).toBe("src/deep.ts");
    const callerModule = rows.find((row) => row.path === "caller.ts" && row.kind === "module")!;
    const out = await store.codebase!.codeEdges("cbproj", callerModule.id, "out");
    expect(out.find((candidate) => candidate.kind === "imports" && candidate.toId === deepHelper!.id)?.evidence).toBe("re-export");
  });

  it("prefers the longest alias prefix when patterns overlap", async () => {
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    writeFileSync(join(dir, "tsconfig.json"), `{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@app/*": ["src/*"], "@app/util/*": ["src/lib/*"] }
  }
}
`);
    writeFileSync(join(dir, "src", "lib", "specific.ts"), `export function specificHelper(): number { return 2; }\n`);
    writeFileSync(join(dir, "src", "loose.ts"), `export function looseHelper(): number { return 3; }\n`);
    writeFileSync(join(dir, "caller.ts"), `import { specificHelper } from "@app/util/specific";\nimport { looseHelper } from "@app/loose";\nexport const run = (): number => specificHelper() + looseHelper();\n`);
    await sync();
    const rows = await symbols();
    expect(rows.find((row) => row.qualifiedName === "specificHelper")?.path).toBe("src/lib/specific.ts");
    expect(rows.find((row) => row.qualifiedName === "looseHelper")?.path).toBe("src/loose.ts");
  });

  it("supports the bare * alias key as a catch-all mapping", async () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "tsconfig.json"), `{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "*": ["src/*"] }
  }
}
`);
    writeFileSync(join(dir, "src", "starred.ts"), `export function starredHelper(): number { return 4; }\n`);
    writeFileSync(join(dir, "caller.ts"), `import { starredHelper } from "starred";\nexport const run = (): number => starredHelper();\n`);
    await sync();
    const rows = await symbols();
    const starredHelper = rows.find((row) => row.qualifiedName === "starredHelper");
    expect(starredHelper?.path).toBe("src/starred.ts");
    const callerModule = rows.find((row) => row.path === "caller.ts" && row.kind === "module")!;
    const out = await store.codebase!.codeEdges("cbproj", callerModule.id, "out");
    expect(out.find((candidate) => candidate.kind === "imports" && candidate.toId === starredHelper!.id)?.evidence).toBe("alias");
  });

  it("rebuilds a two-level call when only the caller changed (persisted field maps)", async () => {
    writeFileSync(join(dir, "alpha.ts"), `export class MemorySvc {\n  syncThing(): void {}\n}\n`);
    writeFileSync(join(dir, "ctx.ts"), `import { MemorySvc } from "./alpha";\nexport interface ToolCtx {\n  service: MemorySvc;\n}\n`);
    writeFileSync(join(dir, "runner.ts"), `import { ToolCtx } from "./ctx";\nexport function run(ctx: ToolCtx): void {}\n`);
    await sync();
    // Only the caller changes: the interface file stays untouched, so the
    // second sync must read ToolCtx's field map from its persisted row.
    writeFileSync(join(dir, "runner.ts"), `import { ToolCtx } from "./ctx";\nexport function run(ctx: ToolCtx): void {\n  ctx.service.syncThing();\n}\n`);
    const report = await sync();
    expect(report.indexed).toBe(1);
    const rows = await symbols();
    const syncThing = rows.find((row) => row.qualifiedName === "MemorySvc.syncThing")!;
    const runSym = rows.find((row) => row.qualifiedName === "run")!;
    const out = (await store.codebase!.codeEdges("cbproj", runSym.id, "out")).filter((edge) => edge.kind === "calls");
    expect(out.find((edge) => edge.toId === syncThing.id)?.evidence).toBe("import");
    expect(syncThing.fanIn).toBe(1);
  });

  it("never routes a relative import through the bare * alias", async () => {
    mkdirSync(join(dir, "src", "a"), { recursive: true });
    writeFileSync(join(dir, "tsconfig.json"), `{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "*": ["src/*"] }
  }
}
`);
    writeFileSync(join(dir, "src", "deep.ts"), `export function shadowed(): number { return 1; }\n`);
    writeFileSync(join(dir, "src", "a", "deep.ts"), `export function nearby(): number { return 2; }\n`);
    writeFileSync(join(dir, "src", "a", "caller.ts"), `import { nearby } from "./deep";\nexport const run = (): number => nearby();\n`);
    await sync();
    const rows = await symbols();
    const nearby = rows.find((row) => row.qualifiedName === "nearby");
    expect(nearby?.path).toBe("src/a/deep.ts");
    const callerModule = rows.find((row) => row.path === "src/a/caller.ts" && row.kind === "module")!;
    const out = await store.codebase!.codeEdges("cbproj", callerModule.id, "out");
    const edge = out.find((candidate) => candidate.kind === "imports" && candidate.toId === nearby!.id);
    expect(edge?.evidence).toBe("import");
  });

  it("lands NodeNext .js specifiers on their TypeScript files", async () => {
    writeFileSync(join(dir, "alpha.ts"), `export class MemorySvc {\n  syncThing(): void {}\n}\n`);
    writeFileSync(join(dir, "util.ts"), `export function utilHelper(s: string): string { return s; }\n`);
    writeFileSync(join(dir, "caller.ts"), `import { utilHelper } from "./util.js";\nimport { MemorySvc } from "./alpha.js";\nexport function run(svc: MemorySvc): void {\n  utilHelper("x");\n  svc.syncThing();\n}\n`);
    await sync();
    const rows = await symbols();
    const utilHelper = rows.find((row) => row.qualifiedName === "utilHelper")!;
    const syncThing = rows.find((row) => row.qualifiedName === "MemorySvc.syncThing")!;
    const callerModule = rows.find((row) => row.path === "caller.ts" && row.kind === "module")!;
    const moduleOut = await store.codebase!.codeEdges("cbproj", callerModule.id, "out");
    expect(moduleOut.find((candidate) => candidate.kind === "imports" && candidate.toId === utilHelper.id)?.evidence).toBe("import");
    const runSym = rows.find((row) => row.qualifiedName === "run")!;
    const calls = (await store.codebase!.codeEdges("cbproj", runSym.id, "out")).filter((edge) => edge.kind === "calls");
    expect(calls.find((edge) => edge.toId === utilHelper.id)?.evidence).toBe("import");
    expect(calls.find((edge) => edge.toId === syncThing.id)?.evidence).toBe("import");
    expect(syncThing.fanIn).toBe(1);
  });

  it("resolves let-annotated and bare-assigned receivers in harness bodies", async () => {
    writeFileSync(join(dir, "alpha.ts"), `export class MemorySvc {\n  syncThing(): void {}\n}\n`);
    writeFileSync(join(dir, "suite.test.ts"), [
      `import { MemorySvc } from "./alpha";`,
      `let svc: MemorySvc;`,
      `describe("suite", () => {`,
      `  beforeEach(() => {`,
      `    svc = new MemorySvc();`,
      `  });`,
      `  it("works", () => {`,
      `    svc.syncThing();`,
      `  });`,
      `});`
    ].join("\n") + "\n");
    await sync();
    const rows = await symbols();
    const syncThing = rows.find((row) => row.qualifiedName === "MemorySvc.syncThing")!;
    const moduleNode = rows.find((row) => row.path === "suite.test.ts" && row.kind === "module")!;
    const out = await store.codebase!.codeEdges("cbproj", moduleNode.id, "out");
    expect(out.find((candidate) => candidate.kind === "calls" && candidate.toId === syncThing.id)?.evidence).toBe("import");
    expect(syncThing.fanIn).toBe(1);
  });

  const exerciseCallerEdgeSurvival = async (target: InMemoryVectorStore | SqliteVectorStore): Promise<void> => {
    await syncCodebase({ store: target }, { root: dir, project: "cbproj" });
    let rows = await target.codebase!.codeSymbols("cbproj", { includeModules: true });
    const helper = rows.find((row) => row.qualifiedName === "helper")!;
    expect(helper.fanIn).toBe(1);
    // Rewrite ONLY helper.ts: index.ts's edges point inbound at it, and symbol
    // ids are deterministic, so those edges must survive the rewrite intact.
    writeFileSync(join(dir, "helper.ts"), `// touched\nexport function helper(s: string): string { return s + "!"; }\nexport function helper2(s: string): string { return s + "?"; }\n`);
    const report = await syncCodebase({ store: target }, { root: dir, project: "cbproj" });
    expect(report.indexed).toBe(1);
    rows = await target.codebase!.codeSymbols("cbproj", { includeModules: true });
    const helperAfter = rows.find((row) => row.qualifiedName === "helper")!;
    expect(helperAfter.id).toBe(helper.id);
    const mainSym = rows.find((row) => row.qualifiedName === "main")!;
    const calls = (await target.codebase!.codeEdges("cbproj", mainSym.id, "out")).filter((edge) => edge.kind === "calls");
    expect(calls.find((edge) => edge.toId === helperAfter.id)?.evidence).toBe("import");
    expect(helperAfter.fanIn).toBe(1);
    const indexModule = rows.find((row) => row.path === "index.ts" && row.kind === "module")!;
    const moduleOut = await target.codebase!.codeEdges("cbproj", indexModule.id, "out");
    expect(moduleOut.some((edge) => edge.kind === "imports" && edge.toId === helperAfter.id)).toBe(true);
  };

  const exerciseCallerRemoval = async (target: InMemoryVectorStore | SqliteVectorStore): Promise<void> => {
    await syncCodebase({ store: target }, { root: dir, project: "cbproj" });
    let rows = await target.codebase!.codeSymbols("cbproj", { includeModules: true });
    const helper = rows.find((row) => row.qualifiedName === "helper")!;
    expect(helper.fanIn).toBe(1);
    // A removed caller takes its outbound edges with it: helper's inbound
    // edges go, the both-sides deletion the removal path keeps.
    unlinkSync(join(dir, "index.ts"));
    const report = await syncCodebase({ store: target }, { root: dir, project: "cbproj" });
    expect(report.removed).toBe(1);
    rows = await target.codebase!.codeSymbols("cbproj", { includeModules: true });
    const helperAfter = rows.find((row) => row.qualifiedName === "helper")!;
    const inbound = await target.codebase!.codeEdges("cbproj", helperAfter.id, "in");
    expect(inbound.filter((edge) => edge.kind === "calls")).toHaveLength(0);
    expect(inbound.filter((edge) => edge.kind === "imports")).toHaveLength(0);
    expect(helperAfter.fanIn).toBe(0);
  };

  it("keeps inbound edges when an imported file changes (memory store)", async () => {
    await exerciseCallerEdgeSurvival(new InMemoryVectorStore());
  });

  it("keeps inbound edges when an imported file changes (sqlite store)", async () => {
    const sqlite = new SqliteVectorStore(join(dir, "kept.db"));
    await sqlite.init();
    try {
      await exerciseCallerEdgeSurvival(sqlite);
    } finally {
      try { sqlite.close(); } catch {}
    }
  });

  it("removes every edge of a removed caller (memory store)", async () => {
    await exerciseCallerRemoval(new InMemoryVectorStore());
  });

  it("removes every edge of a removed caller (sqlite store)", async () => {
    const sqlite = new SqliteVectorStore(join(dir, "gone.db"));
    await sqlite.init();
    try {
      await exerciseCallerRemoval(sqlite);
    } finally {
      try { sqlite.close(); } catch {}
    }
  });

  // Roadmap Phase 2: one index, several grammars. The language column is what
  // makes a mixed index auditable — each row says which scanner wrote it — and
  // the SQL store is where that has to survive a reopen, because that is the
  // store agents actually read through the daemon.
  it("stamps the grammar id per file and per symbol, and reloads it from SQLite", async () => {
    mkdirSync(join(dir, "pkg"));
    writeFileSync(join(dir, "go.mod"), "module example.com/proj\n");
    writeFileSync(join(dir, "pkg", "util.go"), "package pkg\n\nfunc Helper(s string) string {\n\treturn s\n}\n");
    writeFileSync(join(dir, "main.go"), "package main\n\nimport \"example.com/proj/pkg\"\n\nfunc main() {\n\tpkg.Helper(\"x\")\n}\n");
    const sqlite = new SqliteVectorStore(join(dir, "poly.db"));
    await sqlite.init();
    try {
      await syncCodebase({ store: sqlite }, { root: dir, project: "cbproj" });
      const files = await sqlite.codebase!.codeFiles("cbproj");
      const langs = new Map(files.map((f) => [f.path, f.language]));
      expect(langs.get("main.go")).toBe("go");
      expect(langs.get("pkg/util.go")).toBe("go");
      expect(langs.get("helper.ts")).toBe("typescript"); // the pre-existing fixture file
      const rows = await sqlite.codebase!.codeSymbols("cbproj", { includeModules: true });
      const helperGo = rows.find((r) => r.path === "pkg/util.go" && r.name === "Helper");
      expect(helperGo?.language).toBe("go");
      expect(rows.find((r) => r.path === "helper.ts")?.language).toBe("typescript");
      // Reopen the same file: the ids come back from SQLite, not from a re-parse.
      sqlite.close();
      const again = new SqliteVectorStore(join(dir, "poly.db"));
      await again.init();
      const reloaded = await again.codebase!.codeFiles("cbproj");
      expect(new Map(reloaded.map((f) => [f.path, f.language])).get("main.go")).toBe("go");
      const reloadedRows = await again.codebase!.codeSymbols("cbproj");
      expect(reloadedRows.find((r) => r.path === "pkg/util.go" && r.name === "Helper")?.language).toBe("go");
      again.close();
    } finally {
      try { sqlite.close(); } catch {}
    }
  });

  // The grammar's `resolveImport` hook has to reach past the parser: a Go import
  // is a MODULE path (`example.com/proj/pkg`), not a relative specifier, so only
  // the language knows which file it lands on. This is the sync-level proof that
  // the hook ran — a directory-prefix candidate resolving to the package's file.
  it("lands a language module import through the grammar hook", async () => {
    mkdirSync(join(dir, "pkg"));
    writeFileSync(join(dir, "go.mod"), "module example.com/proj\n");
    writeFileSync(join(dir, "pkg", "util.go"), "package pkg\n\nfunc Helper(s string) string {\n\treturn s\n}\n");
    writeFileSync(join(dir, "main.go"), "package main\n\nimport \"example.com/proj/pkg\"\n\nfunc main() {\n\tpkg.Helper(\"x\")\n}\n");
    await syncCodebase({ store }, { root: dir, project: "cbproj" });
    const rows = await store.codebase!.codeSymbols("cbproj", { includeModules: true });
    const mainModule = rows.find((r) => r.path === "main.go" && r.kind === "module")!;
    const utilModule = rows.find((r) => r.path === "pkg/util.go" && r.kind === "module")!;
    const helper = rows.find((r) => r.path === "pkg/util.go" && r.name === "Helper")!;
    const out = await store.codebase!.codeEdges("cbproj", mainModule.id, "out");
    const importEdge = out.find((e) => e.kind === "imports" && e.toId === utilModule.id);
    expect(importEdge?.evidence).toBe("import");
    // The call site is a selector tail (`pkg.Helper`) inside `main`, so the call
    // edge belongs to the calling symbol — not the module node, which carries the
    // import itself. The name is unique in the project, so the shared cascade
    // resolves it and says so honestly through its evidence.
    const mainFn = rows.find((r) => r.path === "main.go" && r.name === "main")!;
    const mainOut = await store.codebase!.codeEdges("cbproj", mainFn.id, "out");
    expect(mainOut.some((e) => e.kind === "calls" && e.toId === helper.id)).toBe(true);
    expect((await store.codebase!.codeSymbols("cbproj")).find((r) => r.id === helper.id)!.fanIn).toBe(1);
  });
});
