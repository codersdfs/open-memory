import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { javaGrammar } from "../src/core/codebase/languages/java.js";

/**
 * The Java grammar (roadmap Phase 2, brace family). These fixtures pin what
 * the zero-dependency scanner extracts from Java — package-absolute imports,
 * class/interface/enum/record declarations, nested qualified names, method
 * detection across annotations and multi-line signatures, conservative
 * bindings/fields — and what it must NOT extract: declarations inside
 * comments, strings and text blocks.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-memory-java-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SRC = [
  "package com.example.app;",                              // 1
  "",                                                       // 2
  "import com.x.Util;",                                     // 3
  "import static com.x.Util.helper;",                       // 4
  "import com.x.*;",                                        // 5
  "",                                                       // 6
  "public class Service {",                                 // 7
  "  private MemoryService svc;",                           // 8
  "",                                                       // 9
  "  @Override",                                            // 10
  "  public String render(int width,",                      // 11
  "                       int height) {",                   // 12
  "    MemoryService local = svc;",                         // 13
  "    local.prepare();",                                   // 14
  "    return helper(svc);",                                // 15
  "  }",                                                    // 16
  "",                                                       // 17
  "  public void run(MemoryService svc2, Options opts) {",  // 18
  "    svc2.prepare();",                                    // 19
  "  }",                                                    // 20
  "",                                                       // 21
  "  public static class Nested {",                         // 22
  "    public void enter() {}",                             // 23
  "  }",                                                    // 24
  "}",                                                      // 25
  "",                                                       // 26
  "interface Shape {",                                      // 27
  "  double area();",                                       // 28
  "",                                                       // 29
  "  double perimeter();",                                  // 30
  "}",                                                      // 31
  "",                                                       // 32
  "enum Color {",                                           // 33
  "  RED, GREEN;",                                          // 34
  "",                                                       // 35
  "  public String label() { return name(); }",             // 36
  "}",                                                      // 37
  "",                                                       // 38
  "record Point(int x, int y) {",                           // 39
  "  public double radius() { return Math.hypot(x, y); }",  // 40
  "}"                                                       // 41
].join("\n");

const DRIFT = [
  "public class Wide {",                       // 1
  "    public Result process(Request req,",    // 2
  "                          Options opts)",   // 3
  "            throws AppException {",         // 4
  "        return Result.ok();",               // 5
  "    }",                                     // 6
  "",                                          // 7
  "    public int small() { return 1; }",      // 8
  "}"                                          // 9
].join("\n");

const TRICKY = [
  "// comment planting class CommentFake { void planted() {} }",
  "/* block class BlockFake { void blockPlanted() {} } */",
  "class Real {",
  "    String s = \"class StringFake { void stringPlanted() {} }\";",
  "    char c = '\\'';",
  "    String t = \"\"\"",
  "        class TextFake { void textPlanted() {} }",
  "        \"\"\";",
  "}"
].join("\n");

const parse = (src: string) => javaGrammar.parse(src, javaGrammar.blank(src));

describe("javaGrammar", () => {
  it("claims .java files as the java grammar", () => {
    expect(javaGrammar.id).toBe("java");
    expect(javaGrammar.label).toBe("Java");
    expect(javaGrammar.extensions).toEqual([".java"]);
  });

  it("blanks comments, strings, char literals and text blocks without moving offsets", () => {
    const blank = javaGrammar.blank(TRICKY);
    expect(blank.length).toBe(TRICKY.length);
    // The text block spans lines; its newlines survive so line counts hold.
    expect(blank.split("\n").length).toBe(TRICKY.split("\n").length);
    expect(blank).not.toContain("Fake");
    expect(blank).toContain("class Real");
  });

  it("keeps zero line drift across a multi-line method signature", () => {
    const byName = new Map(parse(DRIFT).symbols.map((s) => [s.qualifiedName, s]));
    const process = byName.get("Wide.process")!;
    expect(byName.get("Wide")!.lineStart).toBe(1);
    expect(byName.get("Wide")!.lineEnd).toBe(9);
    expect(process.lineStart).toBe(2);
    expect(process.lineEnd).toBe(6);
    expect(process.signature).toBe("public Result process(Request req, Options opts) throws AppException");
    // The declaration AFTER the multi-line header lands on its true line.
    const small = byName.get("Wide.small")!;
    expect(small.lineStart).toBe(8);
    expect(small.lineEnd).toBe(8);
    expect(process.memberCalls).toContainEqual({ receiver: "Result", method: "ok" });
  });

  it("extracts classes, interfaces, enums, records and their members", () => {
    const result = parse(SRC);
    const byName = new Map(result.symbols.map((s) => [s.qualifiedName, s]));
    for (const q of [
      "Service", "Service.render", "Service.run", "Service.Nested", "Service.Nested.enter",
      "Shape", "Shape.area", "Shape.perimeter", "Color", "Color.label", "Point", "Point.radius"
    ]) {
      expect(byName.has(q), q).toBe(true);
    }
    expect(byName.get("Service")!.kind).toBe("class");
    expect(byName.get("Service")!.exported).toBe(true);
    expect(byName.get("Shape")!.kind).toBe("interface");
    expect(byName.get("Shape")!.exported).toBe(false);
    expect(byName.get("Color")!.kind).toBe("enum");
    expect(byName.get("Point")!.kind).toBe("class");
    expect(byName.get("Service.Nested")!.qualifiedName).toBe("Service.Nested");
    expect(byName.get("Service.Nested")!.parent).toBe("Service");
    expect(byName.get("Service.Nested.enter")!.parent).toBe("Service.Nested");
    // Lines: annotations on the preceding line never shift a method's start.
    expect(byName.get("Service.render")!.lineStart).toBe(11);
    expect(byName.get("Service.render")!.lineEnd).toBe(16);
    expect(byName.get("Service.run")!.lineStart).toBe(18);
    expect(byName.get("Service.Nested.enter")!.lineStart).toBe(23);
    expect(byName.get("Shape.area")!.lineStart).toBe(28);
    expect(byName.get("Shape.area")!.lineEnd).toBe(28);
    expect(byName.get("Shape.area")!.signature).toBe("double area()");
    expect(byName.get("Color.label")!.lineStart).toBe(36);
    expect(byName.get("Point.radius")!.lineStart).toBe(40);
    expect(byName.get("Point")!.lineEnd).toBe(41);
  });

  it("records imports with static and wildcard forms", () => {
    const result = parse(SRC);
    expect(result.imports).toEqual([
      { spec: "com.x.Util", names: ["Util"], namespace: null, defaultName: null, sideEffect: false, isExport: false },
      { spec: "com.x.Util", names: ["helper"], namespace: null, defaultName: null, sideEffect: false, isExport: false },
      { spec: "com.x.*", names: ["*"], namespace: null, defaultName: null, sideEffect: false, isExport: false }
    ]);
    expect(result.reExports).toEqual([]);
  });

  it("fills conservative bindings and fields for member-call resolution", () => {
    const result = parse(SRC);
    expect(result.fields).toEqual({ Service: { svc: "MemoryService" } });
    expect(result.bindings).toEqual({
      svc: "MemoryService",
      local: "MemoryService",
      svc2: "MemoryService",
      opts: "Options"
    });
    const render = result.symbols.find((s) => s.qualifiedName === "Service.render")!;
    expect(render.memberCalls).toContainEqual({ receiver: "local", method: "prepare" });
    expect(render.refs).toContain("helper");
    expect(render.refs).toContain("MemoryService");
    expect(render.refs).not.toContain("prepare");
    const run = result.symbols.find((s) => s.qualifiedName === "Service.run")!;
    expect(run.memberCalls).toContainEqual({ receiver: "svc2", method: "prepare" });
  });

  it("does not extract declarations inside comments, strings or text blocks", () => {
    const result = parse(TRICKY);
    expect(result.symbols.map((s) => s.name)).toEqual(["Real"]);
  });

  it("resolves package imports to repo-relative candidates", () => {
    mkdirSync(join(dir, "com", "x"), { recursive: true });
    writeFileSync(join(dir, "com", "x", "Util.java"), "package com.x;\npublic class Util {}\n");
    const resolve = javaGrammar.resolveImport!;
    expect(resolve("com.x.Util", "com/example/App.java", { repoRoot: dir })).toEqual(["com/x/Util.java"]);
    expect(existsSync(join(dir, "com", "x", "Util.java"))).toBe(true);
    expect(resolve("com.x.*", "com/example/App.java", { repoRoot: dir })).toEqual(["com/x/"]);
    expect(resolve("com.x.*.Util", "com/example/App.java", { repoRoot: dir })).toBeNull();
  });

  it("parses two packages declaring the same class independently", () => {
    // Two packages declaring `Widget` both parse: each file keeps its own
    // package-qualified path and its own symbol, and the parse layer never
    // merges them. Whether the project graph links anything across them is
    // the sync's call, and Phase 1 pins that rule in
    // tests/codebase-sync.test.ts ("builds no edge when a two-level chain's
    // target is ambiguous") — ambiguity builds nothing.
    const widgetA = "package com.a;\n\npublic class Widget { public void draw() {} }\n";
    const widgetB = "package com.b;\n\npublic class Widget { public void draw() {} }\n";
    const pathA = join("com", "a", "Widget.java");
    const pathB = join("com", "b", "Widget.java");
    mkdirSync(join(dir, "com", "a"), { recursive: true });
    mkdirSync(join(dir, "com", "b"), { recursive: true });
    writeFileSync(join(dir, pathA), widgetA);
    writeFileSync(join(dir, pathB), widgetB);
    const a = parse(widgetA);
    const b = parse(widgetB);
    const widgetAInA = a.symbols.find((s) => s.name === "Widget");
    const widgetInB = b.symbols.find((s) => s.name === "Widget");
    expect(widgetAInA?.kind).toBe("class");
    expect(widgetInB?.kind).toBe("class");
    expect(widgetAInA?.exported).toBe(true);
    expect(widgetInB?.exported).toBe(true);
    expect(existsSync(join(dir, pathA))).toBe(true);
    expect(existsSync(join(dir, pathB))).toBe(true);
    expect(pathA).not.toBe(pathB);
  });
});
