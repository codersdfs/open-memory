import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kotlinGrammar } from "../src/core/codebase/languages/kotlin.js";

/**
 * The Kotlin grammar's fixture suite (roadmap Phase 2, ledger task C5). It
 * pins what every grammar must prove: (a) zero line drift on multi-line
 * signatures, (b) in-repo import resolution through the package-to-directory
 * rule, (c) ambiguous names recorded without the grammar inventing edges, plus
 * the Kotlin-specific traps — raw strings that span lines, block comments that
 * NEST, and the `companion object` whose members belong to the enclosing class.
 */

const parse = (src: string) => kotlinGrammar.parse(src, kotlinGrammar.blank(src));

describe("blankKotlin", () => {
  it("blanks comments, strings and raw strings without moving offsets or newlines", () => {
    const src = [
      "// a line comment",
      "val a = 1",
      "/* a block",
      "   comment */",
      "val doc = \"\"\"raw",
      "   body\"\"\"",
      'val c = "str"'
    ].join("\n");
    const blanked = kotlinGrammar.blank(src);
    expect(blanked.length).toBe(src.length);
    expect(blanked.split("\n").length).toBe(src.split("\n").length);
    expect(blanked).not.toContain("comment");
    expect(blanked).not.toContain("raw");
    expect(blanked).not.toContain("body");
    expect(blanked).not.toContain("str");
    expect(blanked).toContain("val a = 1");
    expect(blanked).toContain("val doc =");
  });

  it("hides a NESTED block comment whole, the way Kotlin's lexer does", () => {
    const src = ["val before = 1", "/* outer /* inner */ still prose */", "val after = 2"].join("\n");
    const blanked = kotlinGrammar.blank(src);
    expect(blanked).not.toContain("inner");
    expect(blanked).not.toContain("prose");
    expect(blanked).toContain("val before = 1");
    expect(blanked).toContain("val after = 2");
  });

  it("keeps every newline inside a raw string so line numbers stay honest", () => {
    const src = 'val doc = """\none\ntwo\nthree"""\nval after = 1\n';
    const blanked = kotlinGrammar.blank(src);
    expect(blanked.split("\n").length).toBe(src.split("\n").length);
    expect(blanked).not.toContain("one");
    expect(blanked).not.toContain("three");
  });

  it("hides a regular string's text and `$` sigil but keeps interpolation code visible", () => {
    const src = 'val line = "total ${count} for $name end"';
    const blanked = kotlinGrammar.blank(src);
    expect(blanked).not.toContain("total");
    expect(blanked).not.toContain("end");
    expect(blanked).toContain("${count}");
    expect(blanked).toContain("name");
  });

  it("hides escaped quotes so a string cannot open a fake block", () => {
    const src = 'val fake = "a \\" fun Planted() {}"';
    const blanked = kotlinGrammar.blank(src);
    expect(blanked).not.toContain("Planted");
    expect(blanked.endsWith("fake =                     ")).toBe(false);
    expect(blanked.length).toBe(src.length);
  });
});

// (a) The drift bar: a signature wrapped over four lines must not move the
// declarations that follow it, and its body refs must still be its own lines.
const DRIFT = [
  "package app.store", // 1
  "", // 2
  "class Repo {", // 3
  "    fun find(", // 4
  "        id: Int,", // 5
  "        opts: Opts", // 6
  "    ): List<Item> {", // 7
  "        return lookup(id, opts)", // 8
  "    }", // 9
  "", // 10
  "    fun count(): Int {", // 11
  "        return total()", // 12
  "    }", // 13
  "}", // 14
  "", // 15
  "fun helper(x: Int): Int {", // 16
  "    return x", // 17
  "}", // 18
  "" // 19
].join("\n");

describe("parseKotlin — zero drift", () => {
  it("extracts a multi-line signature and every line number after it", () => {
    const parsed = parse(DRIFT);
    expect(parsed.parseError).toBeUndefined();
    const byQName = new Map(parsed.symbols.map((s) => [s.qualifiedName, s]));
    const find = byQName.get("app.store.Repo.find");
    expect(find?.kind).toBe("method");
    expect(find?.lineStart).toBe(4);
    expect(find?.lineEnd).toBe(9);
    expect(find?.signature).toContain("fun find(");
    expect(find?.signature).toContain("): List<Item>");
    expect(find?.refs).toContain("lookup");
    expect(find?.refs).toContain("opts");
    const count = byQName.get("app.store.Repo.count");
    expect(count?.lineStart).toBe(11);
    expect(count?.lineEnd).toBe(13);
    // The top-level function after the class keeps its own lines: the
    // multi-line header above it moved nothing.
    const helper = byQName.get("app.store.helper");
    expect(helper?.kind).toBe("function");
    expect(helper?.parent).toBeNull();
    expect(helper?.lineStart).toBe(16);
    expect(helper?.lineEnd).toBe(18);
  });
});

// (b) The kinds, the members, the imports and the bindings.
const SHAPES = [
  "package app.store", // 1
  "", // 2
  "import x.y.Util", // 3
  "import x.y.Util.member", // 4
  "import x.y.*", // 5
  "import a.b.C as D", // 6
  "", // 7
  "sealed interface Cache {", // 8
  "    fun get(key: String): String?", // 9
  "}", // 10
  "", // 11
  "enum class Status {", // 12
  "    ACTIVE,", // 13
  "    DISABLED", // 14
  "}", // 15
  "", // 16
  "data class Row(val id: Int, val name: String)", // 17
  "", // 18
  "object Registry {", // 19
  "    fun register(name: String) {", // 20
  "        touch(name)", // 21
  "    }", // 22
  "}", // 23
  "", // 24
  "annotation class Marker", // 25
  "", // 26
  "class Repo(private val db: MemoryService) : Cache {", // 27
  "    val svc: MemoryService = db", // 28
  "", // 29
  "    companion object {", // 30
  "        fun load(id: Int): Repo {", // 31
  "            db.read(id)", // 32
  "            return Repo(id)", // 33
  "        }", // 34
  "    }", // 35
  "", // 36
  "    fun save(row: Row) {", // 37
  "        svc.write(row)", // 38
  "        Util.helper()", // 39
  "    }", // 40
  "}", // 41
  "", // 42
  "fun build(): Repo {", // 43
  "    return Repo(1)", // 44
  "}", // 45
  "" // 46
].join("\n");

describe("parseKotlin — declarations", () => {
  it("maps every construct onto the SHARED kinds, inventing none (Ruling 3)", () => {
    const parsed = parse(SHAPES);
    expect(parsed.parseError).toBeUndefined();
    const byQName = new Map(parsed.symbols.map((s) => [s.qualifiedName, s]));
    // class / object / interface / enum, with the modifier left in the signature.
    expect(byQName.get("app.store.Cache")?.kind).toBe("interface");
    expect(byQName.get("app.store.Cache")?.lineStart).toBe(8);
    expect(byQName.get("app.store.Cache")?.lineEnd).toBe(10);
    expect(byQName.get("app.store.Status")?.kind).toBe("enum");
    expect(byQName.get("app.store.Row")?.kind).toBe("class");
    expect(byQName.get("app.store.Row")?.signature).toContain("data class Row");
    expect(byQName.get("app.store.Registry")?.kind).toBe("class");
    expect(byQName.get("app.store.Marker")?.kind).toBe("class");
    expect(byQName.get("app.store.Marker")?.signature).toContain("annotation class Marker");
    expect(byQName.get("app.store.Repo")?.kind).toBe("class");
    expect(byQName.get("app.store.Repo")?.signature).toContain(": Cache");
    // Enum constants are not symbols; nothing is guessed.
    expect(parsed.symbols.some((s) => s.name === "ACTIVE")).toBe(false);
  });

  it("separates top-level functions from members, and files companion funs on the class", () => {
    const parsed = parse(SHAPES);
    const byQName = new Map(parsed.symbols.map((s) => [s.qualifiedName, s]));
    const build = byQName.get("app.store.build");
    expect(build?.kind).toBe("function");
    expect(build?.parent).toBeNull();
    expect(build?.exported).toBe(true);
    const register = byQName.get("app.store.Registry.register");
    expect(register?.kind).toBe("method");
    expect(register?.parent).toBe("app.store.Registry");
    expect(register?.lineStart).toBe(20);
    expect(register?.lineEnd).toBe(22);
    const get = byQName.get("app.store.Cache.get");
    expect(get?.kind).toBe("method");
    expect(get?.lineStart).toBe(9);
    expect(get?.lineEnd).toBe(9);
    // DOCUMENTED CHOICE: `companion object` is transparent — callers write
    // `Repo.load()`, so its funs are methods of the enclosing class.
    const load = byQName.get("app.store.Repo.load");
    expect(load?.kind).toBe("method");
    expect(load?.parent).toBe("app.store.Repo");
    expect(load?.lineStart).toBe(31);
    expect(load?.lineEnd).toBe(34);
    expect(load?.memberCalls).toContainEqual({ receiver: "db", method: "read" });
  });

  it("reads imports as spec-plus-bound-name, wildcard and member forms included", () => {
    const parsed = parse(SHAPES);
    const bySpec = new Map(parsed.imports.map((imp) => [imp.spec, imp]));
    expect(bySpec.get("x.y.Util")).toEqual({
      spec: "x.y.Util",
      names: ["Util"],
      namespace: null,
      defaultName: null,
      sideEffect: false,
      isExport: false
    });
    // A member import names the member; its spec stays as written, so
    // resolveImport can still land it on the declaring file.
    expect(bySpec.get("x.y.Util.member")?.names).toEqual(["member"]);
    expect(bySpec.get("x.y.*")?.names).toEqual(["*"]);
    expect(bySpec.get("a.b.C")?.names).toEqual(["C", "D"]);
    expect(parsed.reExports).toEqual([]);
  });

  it("binds the type positions Kotlin states and files class fields", () => {
    const parsed = parse(SHAPES);
    // `val svc: MemoryService` and the primary-constructor `private val db` are
    // structural; generics, qualified and compound types stay out.
    expect(parsed.bindings).toEqual({
      db: "MemoryService",
      svc: "MemoryService",
      id: "Int",
      name: "String"
    });
    expect(parsed.fields.Repo).toEqual({ db: "MemoryService", svc: "MemoryService" });
    expect(parsed.fields.Row).toEqual({ id: "Int", name: "String" });
    const save = parsed.symbols.find((s) => s.qualifiedName === "app.store.Repo.save")!;
    expect(save.memberCalls).toContainEqual({ receiver: "svc", method: "write" });
    expect(save.memberCalls).toContainEqual({ receiver: "Util", method: "helper" });
  });

  it("keeps lambda and `when` braces from moving what follows them", () => {
    // Kotlin puts braces where Java has none — lambda bodies, `when` arms,
    // `init` blocks. None of them may claim a declaration or change the scope
    // the NEXT declaration is filed in, and `it` (the implicit lambda
    // parameter) is dropped from refs because no scan can know its type.
    const src = [
      "package kt", // 1
      "", // 2
      "fun run(items: List<Int>): Int {", // 3
      "    val doubled = items.map { it * 2 }", // 4
      "    return when (doubled.size) {", // 5
      "        0 -> 0", // 6
      "        else -> {", // 7
      "            tally(doubled)", // 8
      "            1", // 9
      "        }", // 10
      "    }", // 11
      "}", // 12
      "", // 13
      "class Tail {", // 14
      "    fun tail() {}", // 15
      "}", // 16
      "" // 17
    ].join("\n");
    const parsed = parse(src);
    const byQName = new Map(parsed.symbols.map((s) => [s.qualifiedName, s]));
    const run = byQName.get("kt.run")!;
    expect(run.kind).toBe("function");
    expect(run.lineStart).toBe(3);
    expect(run.lineEnd).toBe(12);
    expect(run.refs).toContain("doubled");
    expect(run.refs).toContain("tally");
    expect(run.refs).not.toContain("it");
    // The class after the braces is still top-level, and its member its own.
    expect(byQName.get("kt.Tail")?.parent).toBeNull();
    expect(byQName.get("kt.Tail")?.lineStart).toBe(14);
    expect(byQName.get("kt.Tail.tail")?.kind).toBe("method");
    expect(byQName.get("kt.Tail.tail")?.lineStart).toBe(15);
  });
});

// (c) Blank immunity: raw strings and nested comments cannot plant code.
const TRAPS = [
  "package kt", // 1
  "", // 2
  "/** KDoc: fun Ghost() {} and import x.y.Doc */", // 3
  "/* outer /* nested */ still prose */", // 4
  'val doc = """', // 5
  "    fun Planted() {}", // 6
  "    import x.y.Fake", // 7
  "    class AlsoPlanted {}", // 8
  '    """', // 9
  "", // 10
  "fun real(): String {", // 11
  '    val s = "a \\"fun Fake2\\" inside"', // 12
  '    return "$doc"', // 13
  "}", // 14
  "" // 15
].join("\n");

describe("parseKotlin — trap immunity", () => {
  it("extracts nothing from raw strings, comments or string literals", () => {
    const parsed = parse(TRAPS);
    expect(parsed.parseError).toBeUndefined();
    const names = parsed.symbols.map((s) => s.name);
    expect(names).toEqual(["real"]);
    expect(names).not.toContain("Planted");
    expect(names).not.toContain("AlsoPlanted");
    expect(names).not.toContain("Ghost");
    expect(names).not.toContain("Fake2");
    expect(parsed.imports).toEqual([]);
    // The raw string's extent is honest and it swallowed nothing after it.
    const real = parsed.symbols.find((s) => s.name === "real")!;
    expect(real.lineStart).toBe(11);
    expect(real.lineEnd).toBe(14);
    // The `$doc` interpolation is a real read of the property, so it counts.
    expect(real.refs).toContain("doc");
  });

  it("never throws on structurally surprising input", () => {
    for (const src of ["fun ({{{ class", 'val x = """unterminated', "class A {", "/* unterminated"]) {
      const parsed = parse(src);
      expect(parsed.parseError, src).toBeUndefined();
      expect(Array.isArray(parsed.symbols)).toBe(true);
    }
  });

  it("does not let interpolated string text plant a package clause or an import", () => {
    // Regular strings keep `$name` and `${expr}` visible as code on purpose,
    // so the clause scan must be anchored to statement starts: nothing inside
    // a string may retitle the file's package or add an edge.
    const src = [
      "package real.pkg",
      "",
      'val note = "see $package fake.pkg and $import a.b.C",',
      'val more = "${package nope.Nope}"',
      "",
      "class Thing",
      ""
    ].join("\n");
    const parsed = parse(src);
    expect(parsed.imports).toEqual([]);
    expect(parsed.symbols.map((s) => s.qualifiedName)).toContain("real.pkg.Thing");
    expect(parsed.symbols.some((s) => s.qualifiedName.includes("fake"))).toBe(false);
    expect(parsed.symbols.some((s) => s.qualifiedName.includes("nope"))).toBe(false);
  });

  it("treats a visible `${expr}` block as string content, not a declaration body", () => {
    // Interpolation stays visible as code so its refs count, but its braces
    // must never be read as a body brace — the class below still closes on
    // its own line and `build` stays a top-level function.
    const src = [
      "package kt",
      "",
      "class Box(val num: Int) {",
      '    fun label(): String = "${num}"', // 4
      '    fun tagged(): String = "${ items.map { it.name } }"', // 5
      "}", // 6
      "", // 7
      "fun build(): Int = 1", // 8
      "" // 9
    ].join("\n");
    const parsed = parse(src);
    const byQName = new Map(parsed.symbols.map((s) => [s.qualifiedName, s]));
    const box = byQName.get("kt.Box")!;
    expect(box.lineStart).toBe(3);
    expect(box.lineEnd).toBe(6);
    expect(byQName.get("kt.Box.label")?.lineEnd).toBe(4);
    expect(byQName.get("kt.Box.tagged")?.lineEnd).toBe(5);
    expect(byQName.get("kt.build")?.kind).toBe("function");
    expect(byQName.get("kt.build")?.parent).toBeNull();
    expect(byQName.get("kt.build")?.lineStart).toBe(8);
    expect(byQName.get("kt.Box.label")?.refs).toContain("num");
  });

  it("does not let a one-line body desynchronise what follows it", () => {
    // `interface A { fun x(): Int }` closes inside the member's own statement
    // extent. Leaping that `}` would misfile `after` as a member of A.
    const src = [
      "package kt", // 1
      "", // 2
      "interface A { fun x(): Int }", // 3
      "class B {", // 4
      "    fun y() {", // 5
      "        zoom()", // 6
      "    }", // 7
      "}", // 8
      "", // 9
      "fun after() {}", // 10
      "" // 11
    ].join("\n");
    const parsed = parse(src);
    const byQName = new Map(parsed.symbols.map((s) => [s.qualifiedName, s]));
    expect(byQName.get("kt.A")?.kind).toBe("interface");
    expect(byQName.get("kt.A")?.lineEnd).toBe(3);
    expect(byQName.get("kt.A.x")?.kind).toBe("method");
    expect(byQName.get("kt.A.x")?.lineEnd).toBe(3);
    expect(byQName.get("kt.B")?.lineStart).toBe(4);
    expect(byQName.get("kt.B")?.lineEnd).toBe(8);
    expect(byQName.get("kt.B.y")?.refs).toContain("zoom");
    // The top-level function after the one-line interface is still top-level.
    expect(byQName.get("kt.after")?.kind).toBe("function");
    expect(byQName.get("kt.after")?.parent).toBeNull();
    expect(byQName.get("kt.after")?.lineStart).toBe(10);
  });
});

describe("kotlinGrammar.resolveImport", () => {
  let dir: string;
  const UTIL_KT = [
    "package x.y", // 1
    "", // 2
    "object Util {", // 3
    "    fun helper(value: Int): Int = value * 2", // 4
    "}", // 5
    "", // 6
    "fun topLevel(): Int = 1", // 7
    "" // 8
  ].join("\n");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-memory-codebase-kotlin-"));
    mkdirSync(join(dir, "x", "y"), { recursive: true });
    writeFileSync(join(dir, "x", "y", "Util.kt"), UTIL_KT);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("maps a package-absolute spec onto its file, per the package-to-directory rule", () => {
    const resolve = (spec: string): string[] | null => kotlinGrammar.resolveImport!(spec, "main.kt", { repoRoot: dir });
    expect(resolve("x.y.Util")).toEqual(["x/y/Util.kt"]);
    // A member import lands on the file of the declaring type.
    expect(resolve("x.y.Util.member")).toEqual(["x/y/Util.kt"]);
    // A wildcard becomes the package's DIRECTORY prefix — types.ts: a
    // "/"-suffixed candidate is a prefix, so one import can claim the package.
    expect(resolve("x.y.*")).toEqual(["x/y/"]);
    expect(resolve("a.b.C")).toEqual(["a/b/C.kt"]);
  });

  it("falls back to the package prefix for a top-level member, whose file the name cannot reveal", () => {
    // `import x.y.topLevel`: Kotlin lets a package spread its top-level members
    // over arbitrarily named files, so the honest candidate is the package dir.
    expect(kotlinGrammar.resolveImport!("x.y.topLevel", "main.kt", { repoRoot: dir })).toEqual(["x/y/"]);
  });

  it("returns null for specs that are not dotted names", () => {
    const resolve = (spec: string): string[] | null => kotlinGrammar.resolveImport!(spec, "main.kt", { repoRoot: dir });
    expect(resolve("not a name")).toBeNull();
    expect(resolve("")).toBeNull();
    expect(resolve("../relative/thing")).toBeNull();
    expect(resolve("Util")).toBeNull();
  });

  it("resolves the file an in-repo import points at", () => {
    const main = ["package app", "", "import x.y.Util", "", "fun start() {", "    Util.helper(2)", "}", ""].join("\n");
    const parsed = parse(main);
    const imp = parsed.imports.find((entry) => entry.spec === "x.y.Util");
    expect(imp?.names).toEqual(["Util"]);
    const candidates = kotlinGrammar.resolveImport!(imp!.spec, "main.kt", { repoRoot: dir });
    expect(candidates).toEqual(["x/y/Util.kt"]);
    const utilParsed = parse(UTIL_KT);
    const helper = utilParsed.symbols.find((s) => s.name === "helper");
    expect(helper?.kind).toBe("method");
    expect(helper?.parent).toBe("x.y.Util");
    // An expression body (`= value * 2`) is still one declaration, and its
    // refs are the identifiers it reads. (Single-character names are dropped by
    // the same length floor the TS and Java scanners use.)
    expect(helper?.lineStart).toBe(4);
    expect(helper?.lineEnd).toBe(4);
    expect(helper?.refs).toContain("value");
  });
});

describe("same-name classes in different packages", () => {
  let dir: string;
  const widget = (pkg: string): string =>
    [`package ${pkg}`, "", "class Widget {", "    fun spin() {}", "}", ""].join("\n");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-memory-codebase-kotlin-ambig-"));
    mkdirSync(join(dir, "north", "shape"), { recursive: true });
    mkdirSync(join(dir, "south", "shape"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps their qualified names distinct; the no-edge rule stays with the sync", () => {
    // The grammar's job ends at recording. Whether a collision builds zero
    // edges is the sync's ambiguity rule ("Ambiguous names build nothing",
    // src/core/codebase/sync.ts), pinned end to end by the Phase 1 fixture in
    // tests/codebase-sync.test.ts — "builds no edge when a two-level chain's
    // target is ambiguous". Here the package prefix carries the distinction
    // that rule consumes: the bare names collide, the qualifiedNames do not.
    const northSrc = widget("north.shape");
    const southSrc = widget("south.shape");
    writeFileSync(join(dir, "north", "shape", "Widget.kt"), northSrc);
    writeFileSync(join(dir, "south", "shape", "Widget.kt"), southSrc);
    const north = parse(northSrc);
    const south = parse(southSrc);
    const northWidget = north.symbols.find((s) => s.name === "Widget")!;
    const southWidget = south.symbols.find((s) => s.name === "Widget")!;
    expect(northWidget.qualifiedName).toBe("north.shape.Widget");
    expect(southWidget.qualifiedName).toBe("south.shape.Widget");
    expect(northWidget.qualifiedName).not.toBe(southWidget.qualifiedName);
    const northSpin = north.symbols.find((s) => s.name === "spin")!;
    const southSpin = south.symbols.find((s) => s.name === "spin")!;
    expect(northSpin.kind).toBe("method");
    expect(northSpin.parent).toBe("north.shape.Widget");
    expect(southSpin.parent).toBe("south.shape.Widget");
    expect(northSpin.name).toBe(southSpin.name);
    expect(northSpin.qualifiedName).not.toBe(southSpin.qualifiedName);
  });
});
