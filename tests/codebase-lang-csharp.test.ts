import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { csharpGrammar } from "../src/core/codebase/languages/csharp.js";

/**
 * The C# grammar (roadmap Phase 2, brace family). These fixtures pin what the
 * zero-dependency scanner extracts from C# — namespace-carrying qualified
 * names in file-scoped and block forms, nested types, the shared kind mapping
 * (record → class, struct → type), method detection across attributes and
 * multi-line signatures, conservative bindings/fields, using-directive
 * resolution — and what it must NOT extract: declarations inside comments,
 * strings, verbatim and raw strings.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-memory-csharp-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SRC = [
  "using System;",                                          // 1
  "using System.Collections.Generic;",                      // 2
  "using static System.Math;",                              // 3
  "",                                                       // 4
  "namespace Acme.Core.Services;",                          // 5
  "",                                                       // 6
  "public class Widget",                                    // 7
  "{",                                                      // 8
  "    public void Begin()",                                // 9
  "    {",                                                  // 10
  "        var renderer = new Renderer();",                 // 11
  "        renderer.Draw();",                               // 12
  "    }",                                                  // 13
  "}",                                                      // 14
  "",                                                       // 15
  "public record Order(int Id, string Sku);",               // 16
  "",                                                       // 17
  "public struct Point",                                    // 18
  "{",                                                      // 19
  "    public int X;",                                      // 20
  "    public int Y;",                                      // 21
  "}",                                                      // 22
  "",                                                       // 23
  "public enum Color { Red, Green }",                       // 24
  "",                                                       // 25
  "public abstract class Base",                             // 26
  "{",                                                      // 27
  "    public abstract void Do();",                         // 28
  "    public virtual void Hook() { }",                     // 29
  "    public async Task<int> LoadAsync() { return 0; }",   // 30
  "    public static Widget Create() => new Widget();",     // 31
  "}",                                                      // 32
  "",                                                       // 33
  "public sealed class Impl : Base",                        // 34
  "{",                                                      // 35
  "    public override void Do() { }",                      // 36
  "    public override sealed void Hook() { }",             // 37
  "}",                                                      // 38
  "",                                                       // 39
  "public interface IRepository",                           // 40
  "{",                                                      // 41
  "    Widget Find(int id);",                               // 42
  "}",                                                      // 43
  "",                                                       // 44
  "internal class Cache { }"                                // 45
].join("\n");

const BLOCK = [
  "namespace A.B",                        // 1
  "{",                                    // 2
  "    using System;",                    // 3
  "",                                     // 4
  "    public class Outer",               // 5
  "    {",                                // 6
  "        public class Inner",           // 7
  "        {",                            // 8
  "            public void Ping() { }",   // 9
  "        }",                            // 10
  "",                                     // 11
  "        public void Pong() { }",       // 12
  "    }",                                // 13
  "}"                                     // 14
].join("\n");

const DRIFT = [
  "public class Wide {",                       // 1
  "    public Result Process(Request req,",    // 2
  "                          Options opts)",   // 3
  "            where Request : class {",       // 4
  "        return Result.Ok();",               // 5
  "    }",                                     // 6
  "",                                          // 7
  "    public int Small() { return 1; }",      // 8
  "}"                                          // 9
].join("\n");

const TRICKY = [
  "// comment planting class CommentFake { void planted() {} }",                              // 1
  "/* block class BlockFake { void blockPlanted() {} } */",                                   // 2
  "public class Real",                                                                        // 3
  "{",                                                                                        // 4
  "    private const string decoy = \"record FakeRecord(int X); class FakeString { void fakeStr() {} }\";", // 5
  "    private const char quote = '\\'';",                                                    // 6
  "    private readonly string verbatim = @\"class FakeVerbatim { void fakeV() {} } \"\"q\"\" // still string\";", // 7
  "    private string raw = \"\"\"",                                                          // 8
  "        class RawFake { void rawPlanted() {} }",                                           // 9
  "        \"\"\";",                                                                          // 10
  "    public void Actual() { }",                                                             // 11
  "}"                                                                                         // 12
].join("\n");

const CONTROL = [
  "public class Tricky",                                    // 1
  "{",                                                      // 2
  "    [Fact]",                                             // 3
  "    public void Real() { }",                             // 4
  "    public void Statements(Widget w)",                   // 5
  "    {",                                                  // 6
  "        if (w == null) { return; }",                     // 7
  "        for (var i = 0; i < 3; i++) { }",                // 8
  "        while (i < 3) { }",                              // 9
  "        switch (i) { case 1: break; }",                  // 10
  "        try { } catch (System.Exception e) { }",         // 11
  "        lock (w) { }",                                   // 12
  "        var made = new Widget();",                       // 13
  "        using var s = System.IO.File.OpenText(\"f\");",  // 14
  "        using (var t = MakeReader()) { }",               // 15
  "        return;",                                        // 16
  "    }",                                                  // 17
  "}"                                                       // 18
].join("\n");

const NAMESPACES = [
  "namespace North.South",          // 1
  "{",                              // 2
  "    public class Widget { }",    // 3
  "}",                              // 4
  "",                               // 5
  "namespace East.West",            // 6
  "{",                              // 7
  "    public class Widget { }",    // 8
  "}"                               // 9
].join("\n");

const parse = (src: string) => csharpGrammar.parse(src, csharpGrammar.blank(src));

describe("csharpGrammar", () => {
  it("claims .cs files as the csharp grammar", () => {
    expect(csharpGrammar.id).toBe("csharp");
    expect(csharpGrammar.label).toBe("C#");
    expect(csharpGrammar.extensions).toEqual([".cs"]);
  });

  it("blanks comments, strings, char, verbatim and raw strings without moving offsets", () => {
    const blank = csharpGrammar.blank(TRICKY);
    expect(blank.length).toBe(TRICKY.length);
    // The verbatim and raw strings span lines; their newlines survive so line counts hold.
    expect(blank.split("\n").length).toBe(TRICKY.split("\n").length);
    expect(blank).not.toContain("Fake");
    expect(blank).toContain("class Real");
  });

  it("keeps zero line drift across a multi-line method signature", () => {
    const byName = new Map(parse(DRIFT).symbols.map((s) => [s.qualifiedName, s]));
    const process = byName.get("Wide.Process")!;
    expect(byName.get("Wide")!.lineStart).toBe(1);
    expect(byName.get("Wide")!.lineEnd).toBe(9);
    expect(process.lineStart).toBe(2);
    expect(process.lineEnd).toBe(6);
    expect(process.signature).toBe("public Result Process(Request req, Options opts) where Request : class");
    // The declaration AFTER the multi-line header lands on its true line.
    const small = byName.get("Wide.Small")!;
    expect(small.lineStart).toBe(8);
    expect(small.lineEnd).toBe(8);
    expect(process.memberCalls).toContainEqual({ receiver: "Result", method: "Ok" });
    expect(process.refs).toContain("Request");
    expect(process.refs).toContain("Options");
  });

  it("extracts types and methods with namespace-carrying qualified names", () => {
    const result = parse(SRC);
    const byName = new Map(result.symbols.map((s) => [s.qualifiedName, s]));
    for (const q of [
      "Acme.Core.Services.Widget", "Acme.Core.Services.Widget.Begin",
      "Acme.Core.Services.Order", "Acme.Core.Services.Point", "Acme.Core.Services.Color",
      "Acme.Core.Services.Base", "Acme.Core.Services.Base.Do", "Acme.Core.Services.Base.Hook",
      "Acme.Core.Services.Base.LoadAsync", "Acme.Core.Services.Base.Create",
      "Acme.Core.Services.Impl", "Acme.Core.Services.Impl.Do", "Acme.Core.Services.Impl.Hook",
      "Acme.Core.Services.IRepository", "Acme.Core.Services.IRepository.Find",
      // The file-scoped namespace covers the whole file — that is its entire
      // point — so the last type carries the prefix too.
      "Acme.Core.Services.Cache"
    ]) {
      expect(byName.has(q), q).toBe(true);
    }
    expect(byName.get("Acme.Core.Services.Widget")!.kind).toBe("class");
    expect(byName.get("Acme.Core.Services.Widget")!.exported).toBe(true);
    // Ruling 3 kind mapping: record says class, struct says type.
    expect(byName.get("Acme.Core.Services.Order")!.kind).toBe("class");
    expect(byName.get("Acme.Core.Services.Point")!.kind).toBe("type");
    expect(byName.get("Acme.Core.Services.Color")!.kind).toBe("enum");
    expect(byName.get("Acme.Core.Services.IRepository")!.kind).toBe("interface");
    expect(byName.get("Acme.Core.Services.Cache")!.exported).toBe(false);
    expect(byName.get("Acme.Core.Services.Widget")!.parent).toBeNull();
    expect(byName.get("Acme.Core.Services.Widget.Begin")!.parent).toBe("Acme.Core.Services.Widget");
    // Lines: the file-scoped namespace never shifts a declaration's start.
    expect(byName.get("Acme.Core.Services.Widget")!.lineStart).toBe(7);
    expect(byName.get("Acme.Core.Services.Widget")!.lineEnd).toBe(14);
    expect(byName.get("Acme.Core.Services.Widget.Begin")!.lineStart).toBe(9);
    expect(byName.get("Acme.Core.Services.Widget.Begin")!.lineEnd).toBe(13);
    // A positional record is braceless; its end is the `;` line, not the match line.
    expect(byName.get("Acme.Core.Services.Order")!.lineStart).toBe(16);
    expect(byName.get("Acme.Core.Services.Order")!.lineEnd).toBe(16);
    expect(byName.get("Acme.Core.Services.Order")!.signature).toBe("public record Order(int Id, string Sku)");
    // Abstract, expression-bodied and interface members parse braceless too.
    expect(byName.get("Acme.Core.Services.Base.Do")!.lineStart).toBe(28);
    expect(byName.get("Acme.Core.Services.Base.Do")!.lineEnd).toBe(28);
    expect(byName.get("Acme.Core.Services.Base.Do")!.signature).toBe("public abstract void Do()");
    expect(byName.get("Acme.Core.Services.Base.Create")!.lineStart).toBe(31);
    expect(byName.get("Acme.Core.Services.Base.Create")!.lineEnd).toBe(31);
    expect(byName.get("Acme.Core.Services.Base.Create")!.signature).toBe("public static Widget Create() => new Widget()");
    expect(byName.get("Acme.Core.Services.IRepository.Find")!.lineStart).toBe(42);
    expect(byName.get("Acme.Core.Services.IRepository.Find")!.lineEnd).toBe(42);
    expect(byName.get("Acme.Core.Services.IRepository.Find")!.signature).toBe("Widget Find(int id)");
  });

  it("parses block namespaces and nested types with prefixed qualified names", () => {
    const result = parse(BLOCK);
    const byName = new Map(result.symbols.map((s) => [s.qualifiedName, s]));
    expect(byName.get("A.B.Outer")!.kind).toBe("class");
    expect(byName.get("A.B.Outer")!.lineStart).toBe(5);
    expect(byName.get("A.B.Outer")!.lineEnd).toBe(13);
    expect(byName.get("A.B.Outer.Inner")!.parent).toBe("A.B.Outer");
    expect(byName.get("A.B.Outer.Inner")!.lineStart).toBe(7);
    expect(byName.get("A.B.Outer.Inner.Ping")!.parent).toBe("A.B.Outer.Inner");
    expect(byName.get("A.B.Outer.Pong")!.lineStart).toBe(12);
    // Usings inside a namespace block are imports too.
    expect(result.imports).toEqual([
      { spec: "System", names: [], namespace: null, defaultName: null, sideEffect: false, isExport: false }
    ]);
  });

  it("records using directives for namespaces and static classes", () => {
    const result = parse(SRC);
    expect(result.imports).toEqual([
      { spec: "System", names: [], namespace: null, defaultName: null, sideEffect: false, isExport: false },
      { spec: "System.Collections.Generic", names: [], namespace: null, defaultName: null, sideEffect: false, isExport: false },
      { spec: "static System.Math", names: ["Math"], namespace: null, defaultName: null, sideEffect: false, isExport: false }
    ]);
    expect(result.reExports).toEqual([]);
  });

  it("fills conservative bindings and fields for member-call resolution", () => {
    const result = parse(SRC);
    expect(result.fields).toEqual({ Point: { X: "int", Y: "int" } });
    expect(result.bindings).toEqual({ renderer: "Renderer" });
    const begin = result.symbols.find((s) => s.qualifiedName === "Acme.Core.Services.Widget.Begin")!;
    expect(begin.memberCalls).toContainEqual({ receiver: "renderer", method: "Draw" });
    expect(begin.refs).toContain("Renderer");
    expect(begin.refs).not.toContain("Draw");
  });

  it("does not extract declarations inside comments, strings or raw strings", () => {
    const result = parse(TRICKY);
    expect(result.symbols.map((s) => s.name)).toEqual(["Real", "Actual"]);
    // Member scanning survives the literals: the fields are real, the planted classes are not.
    expect(result.fields.Real).toEqual({ decoy: "string", quote: "char", verbatim: "string", raw: "string" });
  });

  it("never turns control-flow statements into symbols", () => {
    const result = parse(CONTROL);
    expect(result.symbols.map((s) => s.name)).toEqual(["Tricky", "Real", "Statements"]);
    // The attribute above Real shifts nothing: the method still starts on its own line.
    const byName = new Map(result.symbols.map((s) => [s.qualifiedName, s]));
    expect(byName.get("Tricky.Real")!.lineStart).toBe(4);
    expect(byName.get("Tricky.Statements")!.lineStart).toBe(5);
    // `using var` and `using (...)` are statements, never imports.
    expect(result.imports).toEqual([]);
    expect(result.bindings).toEqual({ w: "Widget", made: "Widget" });
  });

  it("resolves using directives to directory-prefix and file candidates", () => {
    mkdirSync(join(dir, "X", "Y"), { recursive: true });
    writeFileSync(join(dir, "X", "Y", "Foo.cs"), "namespace X.Y\n{\n    public static class Foo { }\n}\n");
    const resolve = csharpGrammar.resolveImport!;
    // `using X.Y;` — the namespace maps to its directory prefix (a "/"-suffixed
    // candidate is a directory prefix, types.ts), so the fixture file under
    // X/Y/ is reachable through it.
    expect(resolve("X.Y", "P.cs", { repoRoot: dir })).toEqual(["X/Y/"]);
    expect("X/Y/Foo.cs".startsWith("X/Y/")).toBe(true);
    expect(existsSync(join(dir, "X", "Y", "Foo.cs"))).toBe(true);
    // `using static X.Y.Foo;` — also tries the static class's own file.
    expect(resolve("static X.Y.Foo", "P.cs", { repoRoot: dir })).toEqual(["X/Y/Foo/", "X/Y/Foo.cs"]);
    // Non-namespace specs fall back to the default machinery untouched.
    expect(resolve("not a namespace", "P.cs", { repoRoot: dir })).toBeNull();
    expect(resolve("", "P.cs", { repoRoot: dir })).toBeNull();
  });

  it("keeps same-name classes in different namespaces distinct", () => {
    // Phase 1 pinned the ambiguity rule in tests/codebase-sync.test.ts
    // ("builds no edge when a two-level chain's target is ambiguous") —
    // ambiguity builds nothing. Here the namespace prefix carries the
    // disambiguation at parse level: two `Widget` classes stay two symbols
    // with two distinct qualified names, never a merged one.
    const result = parse(NAMESPACES);
    const byName = new Map(result.symbols.map((s) => [s.qualifiedName, s]));
    expect(byName.get("North.South.Widget")!.kind).toBe("class");
    expect(byName.get("East.West.Widget")!.kind).toBe("class");
    expect(byName.get("North.South.Widget")).not.toBe(byName.get("East.West.Widget"));
    expect(byName.get("Widget")).toBeUndefined();
    const names = result.symbols.filter((s) => s.name === "Widget").map((s) => s.qualifiedName).sort();
    expect(names).toEqual(["East.West.Widget", "North.South.Widget"]);
  });
});
