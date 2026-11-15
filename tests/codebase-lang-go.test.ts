import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goGrammar } from "../src/core/codebase/languages/go.js";

/**
 * The Go grammar's fixture suite (roadmap Phase 2). It pins what every grammar
 * must prove: (a) zero line drift on multi-line signatures, (b) in-repo import
 * resolution through the go.mod module prefix, (c) ambiguous names recorded
 * without the grammar inventing edges — plus the Go-specific trap that raw
 * strings and comments cannot plant symbols or imports.
 */

describe("blankGo", () => {
  it("blanks comments and string contents without moving offsets or newlines", () => {
    const src = [
      "// a line comment",
      "const a = 1",
      "/* a block",
      "   comment */",
      "const b = `raw",
      "   string`",
      'const c = "str"'
    ].join("\n");
    const blanked = goGrammar.blank(src);
    expect(blanked.length).toBe(src.length);
    expect(blanked.split("\n").length).toBe(src.split("\n").length);
    expect(blanked).not.toContain("comment");
    expect(blanked).not.toContain("raw");
    expect(blanked).not.toContain("str");
    expect(blanked).toContain("const a = 1");
    expect(blanked).toContain("const b =");
  });

  it("keeps raw-string newlines so line numbers stay honest", () => {
    const src = "const doc = `one\ntwo\nthree`\nconst after = 1\n";
    const blanked = goGrammar.blank(src);
    expect(blanked.split("\n").length).toBe(src.split("\n").length);
    // The newlines INSIDE the raw string survive; its words do not.
    expect(blanked).not.toContain("one");
    expect(blanked).not.toContain("two");
    expect(blanked).not.toContain("three");
  });

  it("hides escaped quotes inside interpreted strings", () => {
    const src = 'const s = "fake \\" func X() {}"';
    const blanked = goGrammar.blank(src);
    expect(blanked).not.toContain("fake");
    expect(blanked).not.toContain("X()");
  });
});

describe("parseGo", () => {
  it("extracts multi-line signatures with zero line drift", () => {
    const src = [
      "package main", // 1
      "", // 2
      "func Wide(", // 3
      "\ta string,", // 4
      "\tb int,", // 5
      ") string {", // 6
      "\treturn narrow(a, b)", // 7
      "}", // 8
      "", // 9
      "func narrow(a string, b int) string {", // 10
      "\treturn a", // 11
      "}", // 12
      "" // 13
    ].join("\n");
    const parsed = goGrammar.parse(src, goGrammar.blank(src));
    const wide = parsed.symbols.find((s) => s.name === "Wide");
    const narrow = parsed.symbols.find((s) => s.name === "narrow");
    expect(wide?.kind).toBe("function");
    expect(wide?.lineStart).toBe(3);
    expect(wide?.lineEnd).toBe(8);
    expect(wide?.signature).toContain("func Wide(");
    expect(wide?.signature).toContain(") string");
    expect(wide?.refs).toContain("narrow");
    expect(wide?.exported).toBe(true);
    expect(narrow?.lineStart).toBe(10);
    expect(narrow?.lineEnd).toBe(12);
    expect(narrow?.exported).toBe(false);
  });

  it("extracts methods, structs as type, interfaces and aliases with shared kinds", () => {
    const src = [
      "package store", // 1
      "", // 2
      "type User struct {", // 3
      "\tName string", // 4
      "\tage  int", // 5
      "}", // 6
      "", // 7
      "type Greeter interface {", // 8
      "\tGreet(name string) string", // 9
      "}", // 10
      "", // 11
      "type Users = map[string]User", // 12
      "type ID int", // 13
      "", // 14
      "func (u *User) Rename(next string) {", // 15
      "\tu.Name = next", // 16
      "}", // 17
      "" // 18
    ].join("\n");
    const parsed = goGrammar.parse(src, goGrammar.blank(src));
    const byName = new Map(parsed.symbols.map((s) => [s.qualifiedName, s]));
    const user = byName.get("User");
    const rename = byName.get("User.Rename");
    // Ruling 3: struct → type, interface → interface, no kinds invented.
    expect(user?.kind).toBe("type");
    expect(user?.lineStart).toBe(3);
    expect(user?.lineEnd).toBe(6);
    expect(user?.signature).toContain("type User struct");
    expect(byName.get("Greeter")?.kind).toBe("interface");
    expect(byName.get("Greeter")?.lineEnd).toBe(10);
    expect(byName.get("Users")?.kind).toBe("type");
    expect(byName.get("ID")?.kind).toBe("type");
    expect(rename?.kind).toBe("method");
    expect(rename?.parent).toBe("User");
    expect(rename?.qualifiedName).toBe("User.Rename");
    expect(rename?.lineStart).toBe(15);
    expect(rename?.lineEnd).toBe(17);
    expect(rename?.exported).toBe(true);
    expect(rename?.refs).toContain("next");
  });

  it("extracts single and grouped const/var declarations as const-kind symbols", () => {
    const src = [
      "package cfg", // 1
      "", // 2
      "const single = 4", // 3
      "var typed int = 5", // 4
      "", // 5
      "const (", // 6
      "\tAlpha = 1", // 7
      "\tbeta = 2", // 8
      ")", // 9
      "", // 10
      "var (", // 11
      "\tNamed = build()", // 12
      "\tother = 3", // 13
      ")", // 14
      "" // 15
    ].join("\n");
    const parsed = goGrammar.parse(src, goGrammar.blank(src));
    const byName = new Map(parsed.symbols.map((s) => [s.name, s]));
    for (const name of ["single", "typed", "Alpha", "beta", "Named", "other"]) {
      expect(byName.get(name)?.kind, name).toBe("const");
    }
    expect(byName.get("Alpha")?.exported).toBe(true);
    expect(byName.get("beta")?.exported).toBe(false);
    expect(byName.get("Alpha")?.lineStart).toBe(7);
    expect(byName.get("Alpha")?.lineEnd).toBe(7);
    expect(byName.get("Named")?.lineStart).toBe(12);
    expect(byName.get("Named")?.refs).toContain("build");
    expect(byName.get("single")?.lineStart).toBe(3);
  });

  it("extracts single, aliased, blank and grouped imports", () => {
    const src = [
      "package main", // 1
      "", // 2
      'import "fmt"', // 3
      'import alias "example.com/proj/pkg/util"', // 4
      'import _ "embed"', // 5
      'import . "math"', // 6
      "", // 7
      "import (", // 8
      '\t"strings"', // 9
      '\trenamed "os"', // 10
      '\t_ "net/http/pprof"', // 11
      ")", // 12
      "" // 13
    ].join("\n");
    const parsed = goGrammar.parse(src, goGrammar.blank(src));
    const bySpec = new Map(parsed.imports.map((imp) => [imp.spec, imp]));
    const fmt = bySpec.get("fmt");
    expect(fmt?.namespace).toBe("fmt");
    expect(fmt?.sideEffect).toBe(false);
    expect(bySpec.get("example.com/proj/pkg/util")?.namespace).toBe("alias");
    expect(bySpec.get("embed")?.sideEffect).toBe(true);
    expect(bySpec.get("math")?.namespace).toBeNull();
    expect(bySpec.get("strings")?.namespace).toBe("strings");
    expect(bySpec.get("os")?.namespace).toBe("renamed");
    expect(bySpec.get("net/http/pprof")?.sideEffect).toBe(true);
    for (const imp of parsed.imports) {
      expect(imp.names).toEqual([]);
      expect(imp.isExport).toBe(false);
    }
  });

  it("does not extract declarations planted in raw strings or comments", () => {
    const src = [
      "package main", // 1
      "", // 2
      "const doc = `", // 3
      "// func PlantFake() {}", // 4
      "type Ghost struct { Name string }", // 5
      'import "example.com/fake"', // 6
      "`", // 7
      "", // 8
      '// import "example.com/commented"', // 9
      "", // 10
      'const quoted = "func NotASymbol() {}"', // 11
      "const openBrace = '{'", // 12
      "", // 13
      "func real() {}", // 14
      "" // 15
    ].join("\n");
    const parsed = goGrammar.parse(src, goGrammar.blank(src));
    const names = parsed.symbols.map((s) => s.name);
    expect(names).toContain("doc");
    expect(names).toContain("quoted");
    expect(names).toContain("openBrace");
    expect(names).toContain("real");
    expect(names).not.toContain("PlantFake");
    expect(names).not.toContain("Ghost");
    expect(names).not.toContain("NotASymbol");
    const specs = parsed.imports.map((imp) => imp.spec);
    expect(specs).not.toContain("example.com/fake");
    expect(specs).not.toContain("example.com/commented");
    // The raw string's extent is honest, and it swallowed nothing after it.
    expect(parsed.symbols.find((s) => s.name === "doc")?.lineEnd).toBe(7);
    expect(parsed.symbols.find((s) => s.name === "real")?.lineStart).toBe(14);
  });
});

const MAIN_GO = 'package main\n\nimport "example.com/proj/pkg/util"\n\nfunc main() {\n\tutil.Helper(21)\n}\n';
const UTIL_GO = "package util\n\n// Helper doubles the input.\nfunc Helper(n int) int {\n\treturn n * 2\n}\n";

describe("goGrammar.resolveImport", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-memory-codebase-go-"));
    writeFileSync(join(dir, "go.mod"), "module example.com/proj\n");
    mkdirSync(join(dir, "pkg", "util"), { recursive: true });
    writeFileSync(join(dir, "pkg", "util", "util.go"), UTIL_GO);
    writeFileSync(join(dir, "main.go"), MAIN_GO);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses the import and resolves it to the package directory prefix", () => {
    const parsed = goGrammar.parse(MAIN_GO, goGrammar.blank(MAIN_GO));
    const imp = parsed.imports.find((entry) => entry.spec === "example.com/proj/pkg/util");
    expect(imp).toBeDefined();
    expect(imp?.namespace).toBe("util");
    const utilParsed = goGrammar.parse(UTIL_GO, goGrammar.blank(UTIL_GO));
    const helper = utilParsed.symbols.find((s) => s.name === "Helper");
    expect(helper?.kind).toBe("function");
    expect(helper?.exported).toBe(true);
    expect(goGrammar.resolveImport!("example.com/proj/pkg/util", "main.go", { repoRoot: dir })).toEqual(["pkg/util/"]);
  });

  it("returns null for the module root, dot-relative specs and foreign specs", () => {
    const resolve = (spec: string): string[] | null => goGrammar.resolveImport!(spec, "main.go", { repoRoot: dir });
    // The module root would have to return ["/"], which prefix-matches every
    // file in the repo — it builds nothing instead.
    expect(resolve("example.com/proj")).toBeNull();
    expect(resolve("./pkg/util")).toBeNull();
    expect(resolve("fmt")).toBeNull();
    expect(resolve("github.com/other/repo/pkg")).toBeNull();
  });

  it("tolerates comments in go.mod", () => {
    writeFileSync(join(dir, "go.mod"), "// generated by go mod init\nmodule example.com/proj // the root\n");
    expect(goGrammar.resolveImport!("example.com/proj/pkg/util", "main.go", { repoRoot: dir })).toEqual(["pkg/util/"]);
  });

  it("returns null when go.mod is missing", () => {
    rmSync(join(dir, "go.mod"));
    expect(goGrammar.resolveImport!("example.com/proj/pkg/util", "main.go", { repoRoot: dir })).toBeNull();
  });
});

describe("ambiguous exports at the grammar level", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-memory-codebase-go-ambig-"));
    mkdirSync(join(dir, "pkg", "a"), { recursive: true });
    mkdirSync(join(dir, "pkg", "b"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("records both Helpers; the no-edge rule stays with the sync machinery", () => {
    // The grammar's job ends at recording: two packages exporting the same
    // bare name produce two symbols, and whether that collision builds zero
    // edges is the sync's ambiguity rule ("Ambiguous names build nothing",
    // src/core/codebase/sync.ts) — pinned end to end by the Phase 1 fixture in
    // tests/codebase-sync.test.ts ("builds no edge when a two-level chain's
    // target is ambiguous"). Here we pin the grammar-level facts that rule
    // consumes: the bare names collide, the qualifiedNames do not.
    const aSrc = "package a\n\nfunc Helper(x int) int {\n\treturn x\n}\n";
    const bSrc = "package b\n\ntype Store struct{ n int }\n\nfunc (s *Store) Helper(x int) int {\n\treturn s.n + x\n}\n";
    writeFileSync(join(dir, "pkg", "a", "a.go"), aSrc);
    writeFileSync(join(dir, "pkg", "b", "b.go"), bSrc);
    const aParsed = goGrammar.parse(aSrc, goGrammar.blank(aSrc));
    const bParsed = goGrammar.parse(bSrc, goGrammar.blank(bSrc));
    const aHelper = aParsed.symbols.find((s) => s.name === "Helper");
    const bHelper = bParsed.symbols.find((s) => s.name === "Helper");
    expect(aHelper?.kind).toBe("function");
    expect(aHelper?.qualifiedName).toBe("Helper");
    expect(bHelper?.kind).toBe("method");
    expect(bHelper?.qualifiedName).toBe("Store.Helper");
    expect(aHelper?.name).toBe(bHelper?.name);
    expect(aHelper?.qualifiedName).not.toBe(bHelper?.qualifiedName);
  });
});
