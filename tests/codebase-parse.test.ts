import { describe, it, expect } from "vitest";
import { blankSource, parseSource } from "../src/core/codebase/parse.js";

/**
 * The structural parser (ADR-0050). These fixtures pin what the zero-dependency
 * scanner extracts from TS/JS: exported symbols, class members, imports and
 * re-exports — and what it must NOT extract: declarations inside comments and
 * strings, globals as call candidates.
 */

const SRC = `// a comment claiming: class Fake { function fake() {}
import { helper, renamed as alias } from "./helper";
import * as fs from "node:fs";
import path from "node:path";
import "./side-effect";
export interface Shape {
  area(): number;
}
export type Alias = string | number;
export class Widget {
  constructor(private x: number) {}
  render() { return helper(this.x); }
  static create(x: number): Widget { return new Widget(x); }
}
export function topFn(a: string): string {
  return helper(a);
}
export const arrow = async (n: number): Promise<number> => {
  const local = topFn(String(n));
  return local.length;
};
function internal(x: number) { return x * 2; }
const unexported = "class NotASymbol { function no() {} }";
`;

describe("blankSource", () => {
  it("blanks comments and strings without moving offsets", () => {
    const src = `const a = "string with // fake";\n// whole line class Foo {}\nconst b = 1;`;
    const blank = blankSource(src);
    expect(blank.length).toBe(src.length);
    expect(blank).not.toContain("fake");
    expect(blank).toContain("const b = 1;");
    expect(blank.split("\n").length).toBe(src.split("\n").length);
  });

  it("keeps template interpolations as code", () => {
    const src = "const s = `a ${b()} c`;";
    const blank = blankSource(src);
    expect(blank).toContain("b()");
  });
});

describe("parseSource", () => {
  const result = parseSource(SRC);
  const byName = new Map(result.symbols.map((s) => [s.qualifiedName, s]));

  it("extracts classes, methods, functions, interfaces and type aliases", () => {
    for (const q of ["Shape", "Alias", "Widget", "Widget.render", "Widget.create", "topFn", "arrow", "internal"]) {
      expect(byName.has(q), q).toBe(true);
    }
    expect(byName.get("Widget")!.exported).toBe(true);
    expect(byName.get("Widget.render")!.kind).toBe("method");
    expect(byName.get("Widget.render")!.parent).toBe("Widget");
    expect(byName.get("internal")!.exported).toBe(false);
    expect(byName.get("arrow")!.kind).toBe("function");
  });

  it("captures signatures from the original text", () => {
    expect(byName.get("topFn")!.signature).toContain("function topFn(a: string): string");
    expect(byName.get("Widget")!.signature).toContain("class Widget");
  });

  it("does not extract declarations inside comments or strings", () => {
    expect(byName.has("Fake")).toBe(false);
    expect(byName.has("NotASymbol")).toBe(false);
    expect(byName.has("no")).toBe(false);
    expect(byName.has("unexported")).toBe(false);
  });

  it("records imports and re-exports with their names", () => {
    const helper = result.imports.find((i) => i.spec === "./helper");
    expect(helper?.names).toContain("helper");
    expect(result.imports.some((i) => i.spec === "node:fs" && i.namespace === "fs")).toBe(true);
    expect(result.imports.some((i) => i.spec === "node:path" && i.defaultName === "path")).toBe(true);
    expect(result.imports.some((i) => i.spec === "./side-effect" && i.sideEffect)).toBe(true);
  });

  it("collects body references, excluding keywords, globals and member access", () => {
    const render = byName.get("Widget.render")!;
    expect(render.refs).toContain("helper");
    const arrow = byName.get("arrow")!;
    expect(arrow.refs).toContain("topFn");
    expect(arrow.refs).not.toContain("String");
    expect(arrow.refs).not.toContain("local.length");
  });

  it("never throws on malformed code — it reports a parse error instead", () => {
    const broken = parseSource("function (((((( {\n}\nconst = ;");
    expect(broken.parseError).toBeUndefined();
    expect(Array.isArray(broken.symbols)).toBe(true);
  });

  it("multi-line signatures do not drift line numbers or body refs", () => {
    const src = [
      "export class Repo {",
      "  /**",
      "   * a jsdoc block spanning lines",
      "   */",
      "  private multiLine(",
      "    a: string,",
      "    b: number",
      "  ): void {",
      "    helperFn(a, b);",
      "  }",
      "  later() { return helperFn(1); }",
      "}",
      "export function helperFn(x: unknown): void {}"
    ].join("\n");
    const r = parseSource(src);
    const lines = src.split("\n");
    for (const s of r.symbols) {
      expect(lines[(s.lineStart ?? 1) - 1]).toContain(s.name);
    }
    const multi = r.symbols.find((s) => s.qualifiedName === "Repo.multiLine")!;
    expect(multi.lineStart).toBe(5);
    expect(multi.lineEnd).toBe(10);
    expect(multi.refs).toContain("helperFn");
    const later = r.symbols.find((s) => s.qualifiedName === "Repo.later")!;
    expect(later.lineStart).toBe(11);
    expect(later.refs).toContain("helperFn");
  });
});

describe("member calls and type bindings", () => {
  const CB_SRC = `import { ToolContext } from "./context";
import { MemoryService } from "./memory";
// decoy: run(decoy: FakeType) { decoy.begin(); }
export function run(ctx: ToolContext, count: number): void {
  ctx.begin();
  ctx.service.commit();
  count.tick();
}
export function make(): MemoryService {
  const svc = new MemoryService();
  return svc;
}
export const note = "svc.begin() inside a string";
export const later = (): void => svc.boot();
export const ctx2: ToolContext = buildContext();
`;
  const result = parseSource(CB_SRC);
  const byName = new Map(result.symbols.map((s) => [s.qualifiedName, s]));

  it("collects member calls on simple receivers, skipping strings and comments", () => {
    const run = byName.get("run")!;
    expect(run.memberCalls).toEqual([
      { receiver: "ctx", method: "begin" },
      { receiver: "count", method: "tick" },
      { receiver: "ctx", method: "commit", via: "service" }
    ]);
    expect(run.refs).toContain("ctx");
    expect(run.refs).not.toContain("service");
    expect(byName.get("later")!.memberCalls).toEqual([{ receiver: "svc", method: "boot" }]);
    expect(byName.get("note")!.memberCalls).toEqual([]);
  });

  it("extracts file-scope bindings from parameters, new-exprs and annotated consts", () => {
    expect(result.bindings).toEqual({
      ctx: "ToolContext",
      svc: "MemoryService",
      ctx2: "ToolContext"
    });
  });

  it("binds let/var annotations and bare new-assignments, skipping annotation reads", () => {
    const src = `import { MemoryService } from "./memory";
let svc: MemoryService;
var legacy: MemoryService = new MemoryService();
describe("suite", () => {
  beforeEach(() => {
    svc = new MemoryService();
    this.cached = new MemoryService();
  });
});
`;
    expect(parseSource(src).bindings).toEqual({ svc: "MemoryService", legacy: "MemoryService", cached: "MemoryService" });
  });
});

describe("harness callback bodies", () => {
  const HARNESS_SRC = `import { MemoryService } from "./memory";
function remoteFn(): void {}
describe("suite", () => {
  beforeEach(() => {
    const svc = new MemoryService();
    svc.prepare();
  });
  it("works", () => {
    ctx.job.run();
    remoteFn();
    note("svc.decoyMethod() and decoyRef()");
  });
});
it("top", (ctx: ToolCtx) => {
  ctx.service.commit();
});
beforeAll(() => boot());
test("plain", function () {
  helperFn();
});
setTimeout(() => { decoyFn(); }, 10);
`;
  const result = parseSource(HARNESS_SRC);

  it("collects bare refs, bindings and member calls from harness bodies onto the file", () => {
    expect(result.moduleRefs).toEqual(expect.arrayContaining(["svc", "MemoryService", "ctx", "remoteFn", "boot", "helperFn", "note"]));
    expect(result.moduleMemberCalls).toEqual([
      { receiver: "svc", method: "prepare" },
      { receiver: "ctx", method: "run", via: "job" },
      { receiver: "ctx", method: "commit", via: "service" }
    ]);
    expect(result.bindings).toMatchObject({ svc: "MemoryService", ctx: "ToolCtx" });
  });

  it("ignores strings, harness names and non-harness callbacks", () => {
    expect(result.moduleRefs).not.toContain("decoyRef");
    expect(result.moduleRefs).not.toContain("decoyFn");
    expect(result.moduleRefs).not.toContain("suite");
    expect(result.moduleRefs).not.toContain("it");
    expect(result.moduleMemberCalls.some((call) => call.method === "decoyMethod")).toBe(false);
  });
});

describe("field type maps", () => {
  const FIELDS_SRC = `export interface ToolCtx {
  service: MemorySvc;
  opts?: Record<string, string>;
  area(): number;
  readonly id: string;
}
export class Widget {
  public label: string;
  private readonly count: number;
  static kind: string;
  state: string = "x";
  optional?: Widget;
  constructor(private width: number) {}
  render(): Widget { const local: number = 1; return this; }
  build(): number { return 1; }
}
export class Loose {
  untyped;
  multi: string | number;
  generic: Map<string, number>;
  invoked: getValue();
}
`;
  const result = parseSource(FIELDS_SRC);

  it("collects simple annotated fields from interfaces and classes", () => {
    expect(result.fields).toEqual({
      ToolCtx: { service: "MemorySvc", id: "string" },
      Widget: { label: "string", count: "number", kind: "string", state: "string", optional: "Widget" }
    });
  });

  it("leaves out methods, unions, generics, untyped and constructor properties", () => {
    expect(result.fields.ToolCtx).not.toHaveProperty("area");
    expect(result.fields.ToolCtx).not.toHaveProperty("opts");
    expect(result.fields.Widget).not.toHaveProperty("width");
    expect(result.fields.Widget).not.toHaveProperty("render");
    expect(result.fields.Widget).not.toHaveProperty("local");
    expect(result.fields).not.toHaveProperty("Loose");
  });
});

describe("dynamic imports and require", () => {
  const DYN_SRC = [
    'import { helper } from "./helper";',
    '// import("./commented") - a comment must not plant an import',
    'const decoy = "require(\'./stringed\')";',
    'export async function load(): Promise<unknown> {',
    '  const mod = await import("./dynamic");',
    '  return mod;',
    '}',
    'const legacy = require("./legacy");',
    'const chained = import("./chained").then((mod) => mod.ready);'
  ].join("\n") + "\n";
  const result = parseSource(DYN_SRC);
  const dynamicImports = result.imports.filter((imp) => imp.dynamic);

  it("collects import() and require() call forms as dynamic entries", () => {
    expect(dynamicImports.map((imp) => imp.spec).sort()).toEqual(["./chained", "./dynamic", "./legacy"]);
    for (const imp of dynamicImports) {
      expect(imp.names).toEqual([]);
      expect(imp.namespace).toBeNull();
      expect(imp.defaultName).toBeNull();
      expect(imp.sideEffect).toBe(false);
      expect(imp.isExport).toBe(false);
    }
  });

  it("does not double-collect a dynamic specifier through the statement scan", () => {
    const dynamic = result.imports.filter((imp) => imp.spec === "./dynamic");
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0]!.dynamic).toBe(true);
    expect(dynamic[0]!.sideEffect).toBe(false);
  });

  it("keeps the static statement scan intact beside dynamic calls", () => {
    const helper = result.imports.find((imp) => imp.spec === "./helper");
    expect(helper?.names).toContain("helper");
    expect(helper?.dynamic).toBeUndefined();
  });

  it("ignores dynamic calls inside comments and strings", () => {
    expect(result.imports.some((imp) => imp.spec === "./commented")).toBe(false);
    expect(result.imports.some((imp) => imp.spec === "./stringed")).toBe(false);
  });
});
