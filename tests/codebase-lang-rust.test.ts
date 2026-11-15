import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rustGrammar } from "../src/core/codebase/languages/rust.js";

/**
 * The Rust grammar's fixture suite (roadmap Phase 2, ledger task C4). It pins
 * what every grammar must prove — (a) zero line drift on multi-line signatures,
 * (b) in-repo import resolution through the language's own module system, (c)
 * ambiguous names recorded without the grammar inventing edges — plus Rust's
 * own traps: lifetimes that must NOT blank (or the `fn` behind them disappears),
 * nested block comments, raw strings containing fake declarations, and the
 * `crate::`/`super::`/`self::` forms a path resolver cannot guess from the text.
 */

describe("blankRust", () => {
  it("blanks comments and strings without moving offsets or newlines", () => {
    const src = [
      "// a line comment",
      "pub fn one() {}",
      "/* a block",
      "   comment */",
      'const S: &str = "text"',
      "const T: char = 'x';"
    ].join("\n");
    const blanked = rustGrammar.blank(src);
    expect(blanked.length).toBe(src.length);
    expect(blanked.split("\n").length).toBe(src.split("\n").length);
    expect(blanked).not.toContain("comment");
    expect(blanked).not.toContain("text");
    expect(blanked).not.toContain("'x'");
    expect(blanked).toContain("pub fn one() {}");
    expect(blanked).toContain("const S: &str =");
  });

  it("understands NESTED block comments, the doctest-fence trap", () => {
    // A non-nesting blanker ends at the first `*/` and then reads
    // `fn Fake() {}` as code.
    const src = ["/* outer /* inner */ fn Fake() {} */", "pub fn real() {}"].join("\n");
    const blanked = rustGrammar.blank(src);
    expect(blanked).not.toContain("Fake");
    expect(blanked).toContain("pub fn real() {}");
    expect(blanked.length).toBe(src.length);
    expect(blanked.split("\n").length).toBe(2);
  });

  it("keeps raw-string newlines, with and without # delimiters", () => {
    const src = [
      'const DOC: &str = r"use crate::a::b;', // 1 — a `r"..."` opener…
      'fn Fake() {}"', // 2 — …spans the newline, which must survive
      'const RAW: &str = r#"fn Fake2() {}"#;', // 3 — the `#`-delimited form
      "pub fn real() {}" // 4
    ].join("\n");
    const blanked = rustGrammar.blank(src);
    expect(blanked.length).toBe(src.length);
    expect(blanked.split("\n").length).toBe(4);
    expect(blanked).not.toContain("Fake");
    expect(blanked).not.toContain("Fake2");
    expect(blanked).not.toContain("crate");
    // Nothing after the raw strings was swallowed: the line is still readable.
    expect(blanked).toContain("pub fn real() {}");
  });

  it("blanks an escaped quote inside a char literal, not the line after it", () => {
    const src = "const Q: char = '\\'';\npub fn after() {}";
    const blanked = rustGrammar.blank(src);
    expect(blanked).not.toContain("''");
    expect(blanked).toContain("pub fn after() {}");
    expect(blanked.split("\n").length).toBe(2);
  });

  it("does NOT blank lifetimes — the quotes and the type stay visible", () => {
    const src = "fn f<'a>(x: &'a str, y: &'static str) -> &'a str { x }";
    const blanked = rustGrammar.blank(src);
    expect(blanked).toBe(src);
  });
});

describe("parseRust", () => {
  it("extracts a multi-line fn signature with zero line drift", () => {
    const src = [
      "mod cfg;", // 1
      "", // 2
      "pub async fn wide(", // 3
      "    a: String,", // 4
      "    b: u32, // trailing comment", // 5
      ") -> Result<(), Error> {", // 6
      "    narrow(a, b)", // 7
      "}", // 8
      "", // 9
      "fn narrow(a: String, b: u32) -> u32 {", // 10
      "    b + 1", // 11
      "}", // 12
      "" // 13
    ].join("\n");
    const parsed = rustGrammar.parse(src, rustGrammar.blank(src));
    expect(parsed.parseError).toBeUndefined();
    const wide = parsed.symbols.find((s) => s.name === "wide");
    const narrow = parsed.symbols.find((s) => s.name === "narrow");
    expect(wide?.kind).toBe("function");
    expect(wide?.lineStart).toBe(3);
    expect(wide?.lineEnd).toBe(8);
    expect(wide?.signature).toContain("pub async fn wide(");
    expect(wide?.signature).toContain("Result<(), Error>");
    expect(wide?.exported).toBe(true);
    expect(wide?.refs).toContain("narrow");
    // The comment inside the parameter list did not plant a symbol or a ref.
    expect(wide?.refs).not.toContain("trailing");
    // ... and the line after it is still numbered honestly.
    expect(narrow?.lineStart).toBe(10);
    expect(narrow?.lineEnd).toBe(12);
    expect(narrow?.exported).toBe(false);
  });

  it("maps struct/trait/enum/impl methods onto the shared kinds (Ruling 3)", () => {
    const src = [
      "use std::fmt;", // 1
      "", // 2
      "pub struct Registry {", // 3
      "    repo: Repository,", // 4
      "    limit: usize,", // 5
      "}", // 6
      "", // 7
      "pub trait Store {", // 8
      "    fn get(&self, key: &str) -> Option<String>;", // 9
      "", // 10
      "    fn ping(&self) -> bool {", // 11
      "        true", // 12
      "    }", // 13
      "}", // 14
      "", // 15
      "pub enum Error {", // 16
      "    NotFound,", // 17
      "    Io(std::io::Error),", // 18
      "}", // 19
      "", // 20
      "pub struct List {", // 21
      "    items: Vec<u8>,", // 22
      "}", // 23
      "", // 24
      "impl List {", // 25
      "    pub fn new() -> Self {", // 26
      "        Self { items: Vec::new() }", // 27
      "    }", // 28
      "", // 29
      "    pub fn push(&mut self, item: u8) {", // 30
      "        self.items.push(item);", // 31
      "        self.count();", // 32
      "    }", // 33
      "", // 34
      "    fn count(&self) -> usize {", // 35
      "        self.items.len()", // 36
      "    }", // 37
      "}", // 38
      "", // 39
      "impl fmt::Display for List {", // 40
      "    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {", // 41
      "        Ok(())", // 42
      "    }", // 43
      "}", // 44
      "" // 45
    ].join("\n");
    const parsed = rustGrammar.parse(src, rustGrammar.blank(src));
    expect(parsed.parseError).toBeUndefined();
    const byQ = new Map(parsed.symbols.map((s) => [s.qualifiedName, s]));
    // struct → type, trait → interface, enum → enum; no kinds invented.
    expect(byQ.get("Registry")?.kind).toBe("type");
    expect(byQ.get("Registry")?.lineStart).toBe(3);
    expect(byQ.get("Registry")?.lineEnd).toBe(6);
    expect(byQ.get("Error")?.kind).toBe("enum");
    expect(byQ.get("Error")?.lineEnd).toBe(19);
    expect(byQ.get("Store")?.kind).toBe("interface");
    expect(byQ.get("Store")?.lineEnd).toBe(14);
    // Required signature and provided method are both the trait's methods; the
    // required one's extent is its header only, because it has no body.
    const get = byQ.get("Store.get");
    expect(get?.kind).toBe("method");
    expect(get?.parent).toBe("Store");
    expect(get?.lineStart).toBe(9);
    expect(get?.lineEnd).toBe(9);
    const ping = byQ.get("Store.ping");
    expect(ping?.kind).toBe("method");
    expect(ping?.parent).toBe("Store");
    expect(ping?.lineStart).toBe(11);
    expect(ping?.lineEnd).toBe(13);
    // Inherent impl: parent the type, qualified `Type.method`, visibility written.
    const newMethod = byQ.get("List.new");
    expect(newMethod?.kind).toBe("method");
    expect(newMethod?.parent).toBe("List");
    expect(newMethod?.lineStart).toBe(26);
    expect(newMethod?.lineEnd).toBe(28);
    expect(newMethod?.exported).toBe(true);
    expect(byQ.get("List.push")?.lineStart).toBe(30);
    expect(byQ.get("List.push")?.lineEnd).toBe(33);
    expect(byQ.get("List.count")?.exported).toBe(false);
    // Trait impl: the methods belong to the TYPE, not the trait — the shared
    // shape has only one parent slot, and `List` is the honest half of it.
    const fmt = byQ.get("List.fmt");
    expect(fmt?.kind).toBe("method");
    expect(fmt?.parent).toBe("List");
    expect(fmt?.lineStart).toBe(41);
    expect(fmt?.lineEnd).toBe(43);
    // No duplicate `List` type row, and the enum's variants are not symbols.
    expect(parsed.symbols.filter((s) => s.qualifiedName === "List").length).toBe(1);
    expect(byQ.has("NotFound")).toBe(false);
    // Fields: only the shape that states a bare type binds. `usize` is a keyword
    // and `Vec<u8>` carries a generic argument, so neither binds — and a struct
    // with nothing to bind gets NO entry rather than an empty one.
    expect(parsed.fields["Registry"]).toEqual({ repo: "Repository" });
    expect(Object.keys(parsed.fields)).toEqual(["Registry"]);
    // Member calls: `self.count()` and `List::new`-style paths are the raw
    // material; `self` is kept because it names the enclosing type.
    const push = byQ.get("List.push");
    expect(push?.memberCalls).toContainEqual({ receiver: "self", method: "count" });
  });

  it("keeps lifetimes visible so the fn behind them is still found", () => {
    const src = [
      "pub fn first<'a>(items: &'a [String]) -> &'a str {", // 1
      "    &items[0]", // 2
      "}", // 3
      "", // 4
      "fn borrow<'a, 'b>(a: &'a str, b: &'b str) -> &'a str {", // 5
      "    a", // 6
      "}", // 7
      "" // 8
    ].join("\n");
    const parsed = rustGrammar.parse(src, rustGrammar.blank(src));
    const names = parsed.symbols.map((s) => s.name);
    expect(names).toContain("first");
    expect(names).toContain("borrow");
    expect(parsed.symbols.find((s) => s.name === "borrow")?.lineStart).toBe(5);
    expect(parsed.symbols.find((s) => s.name === "borrow")?.lineEnd).toBe(7);
  });

  it("does not extract declarations planted in raw strings, strings or comments", () => {
    const src = [
      "use std::fmt;", // 1
      "", // 2
      "pub const DOC: &str = r#\"", // 3
      "fn PlantFn() {}", // 4
      "struct PlantStruct {}", // 5
      "use crate::fake::Item;", // 6
      "\"#;", // 7
      "", // 8
      "// pub fn Commented() {}", // 9
      "// struct Commented {}", // 10
      "", // 11
      "pub fn real() -> &'static str {", // 12
      "    \"fn AlsoNotAFn() {}\"", // 13
      "}", // 14
      "", // 15
      "pub struct Later;", // 16
      "" // 17
    ].join("\n");
    const parsed = rustGrammar.parse(src, rustGrammar.blank(src));
    const names = parsed.symbols.map((s) => s.name);
    expect(names).not.toContain("PlantFn");
    expect(names).not.toContain("PlantStruct");
    expect(names).not.toContain("Commented");
    expect(names).not.toContain("AlsoNotAFn");
    expect(names).toContain("DOC");
    expect(names).toContain("real");
    expect(names).toContain("Later");
    expect(parsed.symbols.find((s) => s.name === "DOC")?.kind).toBe("const");
    expect(parsed.symbols.find((s) => s.name === "DOC")?.lineEnd).toBe(7);
    expect(parsed.symbols.find((s) => s.name === "real")?.lineStart).toBe(12);
    expect(parsed.symbols.find((s) => s.name === "Later")?.lineStart).toBe(16);
    // And the fake `use` inside the raw string was not recorded either.
    expect(parsed.imports.map((i) => i.spec)).not.toContain("crate::fake::Item");
  });

  it("records use directives, brace groups and pub re-exports", () => {
    const src = [
      "use crate::store::Store;", // 1
      "use super::sibling::Helper;", // 2
      "use self::local::Thing;", // 3
      "use crate::util::{shuffle, pick};", // 4
      "use crate::inner::{self, Item};", // 5
      "use crate::net::Client as NetClient;", // 6
      "use std::collections::HashMap;", // 7
      "use crate::things::*;", // 8
      "pub use crate::store::Store as PublicStore;", // 9
      "use crate::deep::{outer::{inner, more}};", // 10
      "" // 11
    ].join("\n");
    const parsed = rustGrammar.parse(src, rustGrammar.blank(src));
    const bySpec = new Map(parsed.imports.map((i) => [i.spec, i]));
    // The ledger's shape: spec as written, name = last path segment.
    expect(bySpec.get("crate::store::Store")).toEqual({
      spec: "crate::store::Store",
      names: ["Store"],
      namespace: null,
      defaultName: null,
      sideEffect: false,
      isExport: false
    });
    expect(bySpec.get("super::sibling::Helper")?.names).toEqual(["Helper"]);
    expect(bySpec.get("self::local::Thing")?.names).toEqual(["Thing"]);
    // Trivial brace groups expand per item...
    expect(bySpec.get("crate::util::shuffle")?.names).toEqual(["shuffle"]);
    expect(bySpec.get("crate::util::pick")?.names).toEqual(["pick"]);
    // ... and `{self}` names the module it pulls in.
    expect(bySpec.get("crate::inner")?.names).toEqual(["inner"]);
    expect(bySpec.get("crate::inner::Item")?.names).toEqual(["Item"]);
    // An `as` alias binds the alias: that is the name the file actually calls.
    expect(bySpec.get("crate::net::Client as NetClient")?.names).toEqual(["NetClient"]);
    expect(bySpec.get("std::collections::HashMap")?.names).toEqual(["HashMap"]);
    // A glob imports names it cannot enumerate, so `names` stays empty.
    expect(bySpec.get("crate::things::*")?.names).toEqual([]);
    // A nested group is NOT half-expanded: nothing is recorded, never a guess.
    expect(bySpec.has("crate::deep::outer")).toBe(false);
    expect(bySpec.has("crate::deep::outer::inner")).toBe(false);
    // `pub use` is a re-export, in its own list.
    expect(parsed.imports.some((i) => i.isExport)).toBe(false);
    expect(parsed.reExports.map((i) => i.spec)).toEqual(["crate::store::Store as PublicStore"]);
    expect(parsed.reExports[0]?.names).toEqual(["PublicStore"]);
    expect(parsed.reExports[0]?.isExport).toBe(true);
  });

  it("declares mod files as module rows and recurses into inline mods", () => {
    const src = [
      "pub mod store;", // 1
      "mod hidden;", // 2
      "", // 3
      "pub mod network {", // 4
      "    pub mod client;", // 5
      "", // 6
      "    use crate::network::client::Client;", // 7
      "    use super::store::Store;", // 8
      "", // 9
      "    pub struct Client {", // 10
      "        pub name: String,", // 11
      "    }", // 12
      "", // 13
      "    pub fn connect(cfg: &Config) -> Client {", // 14
      "        Client { name: cfg.host.clone() }", // 15
      "    }", // 16
      "}", // 17
      "", // 18
      "pub fn after() {}", // 19
      "" // 20
    ].join("\n");
    const parsed = rustGrammar.parse(src, rustGrammar.blank(src));
    const byQ = new Map(parsed.symbols.map((s) => [s.qualifiedName, s]));
    const store = byQ.get("store");
    expect(store?.kind).toBe("module");
    expect(store?.lineStart).toBe(1);
    expect(store?.lineEnd).toBe(1);
    expect(store?.exported).toBe(true);
    expect(byQ.get("hidden")?.kind).toBe("module");
    expect(byQ.get("hidden")?.exported).toBe(false);
    // Inline module: its own row closes with its body...
    const network = byQ.get("network");
    expect(network?.kind).toBe("module");
    expect(network?.lineStart).toBe(4);
    expect(network?.lineEnd).toBe(17);
    // ... and its contents carry the qualified prefix, which is the string a
    // `use crate::network::client::Client;` names.
    expect(byQ.get("network::client")?.kind).toBe("module");
    expect(byQ.get("network::client")?.parent).toBe("network");
    expect(byQ.get("network::client")?.lineStart).toBe(5);
    expect(byQ.get("network::Client")?.kind).toBe("type");
    expect(byQ.get("network::Client")?.lineStart).toBe(10);
    expect(byQ.get("network::connect")?.kind).toBe("function");
    expect(byQ.get("network::connect")?.lineStart).toBe(14);
    expect(byQ.get("network::connect")?.lineEnd).toBe(16);
    // The walk came back out at the right line, with no drift from the mod body.
    expect(byQ.get("after")?.lineStart).toBe(19);
    const bySpec = new Map(parsed.imports.map((i) => [i.spec, i]));
    expect(bySpec.get("crate::network::client::Client")?.names).toEqual(["Client"]);
    expect(bySpec.get("super::store::Store")?.names).toEqual(["Store"]);
  });

  it("never throws on malformed code — it reports a parse error or degrades", () => {
    const cases = [
      "pub fn broken( {",
      "impl {",
      "use",
      "mod {",
      "struct",
      "/* unterminated",
      "let x = '\"\""
    ];
    for (const src of cases) {
      const parsed = rustGrammar.parse(src, rustGrammar.blank(src));
      expect(Array.isArray(parsed.symbols)).toBe(true);
      expect(Array.isArray(parsed.imports)).toBe(true);
      for (const sym of parsed.symbols) {
        expect(sym.lineStart).toBeGreaterThan(0);
        if (sym.lineEnd !== null) expect(sym.lineEnd).toBeGreaterThanOrEqual(sym.lineStart);
      }
    }
  });
});

const MAIN_RS = [
  "use crate::module::Helper;",
  "use crate::config::Loader;",
  "",
  "pub fn main() {",
  "    let value = helper();",
  "}",
  ""
].join("\n");
const MODULE_RS = [
  "/// Helper doubles the input.",
  "pub fn helper(n: u32) -> u32 {",
  "    n * 2",
  "}",
  "",
  "pub struct Helper;",
  ""
].join("\n");

describe("rustGrammar.resolveImport", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-memory-codebase-rust-"));
    mkdirSync(join(dir, "src", "nested"), { recursive: true });
    writeFileSync(join(dir, "src", "main.rs"), MAIN_RS);
    writeFileSync(join(dir, "src", "module.rs"), MODULE_RS);
    writeFileSync(join(dir, "src", "nested", "sibling.rs"), "pub fn helper() {}\n");
    writeFileSync(join(dir, "src", "nested", "child.rs"), "use super::helper;\nuse self::item::Item;\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses crate:: and unresolvable imports, and keeps the candidates ordered", () => {
    const parsed = rustGrammar.parse(MAIN_RS, rustGrammar.blank(MAIN_RS));
    expect(parsed.imports.map((i) => i.spec)).toEqual(["crate::module::Helper", "crate::config::Loader"]);
    // `crate::a::b` — the full path as a file, then as a directory module, then
    // the prefixes dropping one segment at a time (see resolveRustImport).
    expect(rustGrammar.resolveImport!("crate::module::Helper", "src/main.rs", { repoRoot: dir })).toEqual([
      "src/module/Helper.rs",
      "src/module/Helper/mod.rs",
      "src/module.rs",
      "src/module/mod.rs"
    ]);
    // A `use` whose file is not in the repo yields candidates that land nowhere;
    // the sync's `files.has()` is what turns that into no edge.
    expect(rustGrammar.resolveImport!("crate::config::Loader", "src/main.rs", { repoRoot: dir })).toEqual([
      "src/config/Loader.rs",
      "src/config/Loader/mod.rs",
      "src/config.rs",
      "src/config/mod.rs"
    ]);
  });

  it("resolves super:: against the importing file's parent directory", () => {
    // `src/nested/child.rs` is the module `nested::child`, so `super` is the
    // module `nested`: the first pair is its submodule `helper`, the next two are
    // the files that DECLARE `nested`, and the tail is the fallback for a repo
    // whose parent module has no directory of its own. The full order, and why
    // each anchor is there, is the doc comment on `resolveRustImport`.
    expect(rustGrammar.resolveImport!("super::helper", "src/nested/child.rs", { repoRoot: dir })).toEqual([
      "src/nested/helper.rs",
      "src/nested/helper/mod.rs",
      "src/nested.rs",
      "src/nested/mod.rs",
      "src/helper.rs",
      "src/helper/mod.rs",
      "src/lib.rs",
      "src/main.rs"
    ]);
    // From a crate-root file there is no parent module at all: `use super::x` in
    // `src/main.rs` is not legal Rust, and the resolver claims nothing.
    expect(rustGrammar.resolveImport!("super::module", "src/main.rs", { repoRoot: dir })).toBeNull();
  });

  it("resolves self:: against the importing file's own directory", () => {
    // `self` is the importing file's OWN module: `src/nested/child.rs`'s own
    // directory is `src/nested/child`, and the second half of the list is the
    // containing directory, for layouts that keep `item.rs` beside `child.rs`.
    expect(rustGrammar.resolveImport!("self::item::Item", "src/nested/child.rs", { repoRoot: dir })).toEqual([
      "src/nested/child/item/Item.rs",
      "src/nested/child/item/Item/mod.rs",
      "src/nested/child/item.rs",
      "src/nested/child/item/mod.rs",
      "src/nested/item/Item.rs",
      "src/nested/item/Item/mod.rs",
      "src/nested/item.rs",
      "src/nested/item/mod.rs"
    ]);
  });

  it("resolves a bare one-segment path as a sibling, and never as itself", () => {
    // A path with no `crate`/`self`/`super` anchor is the 2015 `use serde;` form:
    // the sibling list, rooted at the importing file's own module directory. The
    // importing file is NOT a candidate — a bare spec says nothing about this
    // file's own items, and landing there would link a module node to itself.
    expect(rustGrammar.resolveImport!("sibling", "src/nested/mod.rs", { repoRoot: dir })).toEqual([
      "src/nested/sibling.rs",
      "src/nested/sibling/mod.rs"
    ]);
    // An external crate name lands in the same list and hits nothing; the sync
    // keeps no `src/serde.rs`, so no edge is built.
    expect(rustGrammar.resolveImport!("serde", "src/main.rs", { repoRoot: dir })).toEqual([
      "src/serde.rs",
      "src/serde/mod.rs"
    ]);
  });

  it("returns null for specs the crate path rules cannot cover", () => {
    const resolve = (spec: string, from = "src/main.rs"): string[] | null =>
      rustGrammar.resolveImport!(spec, from, { repoRoot: dir });
    expect(resolve("std::collections::HashMap")).toBeNull();
    expect(resolve("anyhow::Result")).toBeNull();
    expect(resolve("::core::fmt::Formatter")).toBeNull();
    expect(resolve("crate")).toBeNull();
    expect(resolve("super")).toBeNull();
    expect(resolve("")).toBeNull();
    expect(resolve("crate::weird path::Item")).toBeNull();
  });
});

describe("ambiguous exports at the grammar level", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai-memory-codebase-rust-ambig-"));
    mkdirSync(join(dir, "src", "a"), { recursive: true });
    mkdirSync(join(dir, "src", "b"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("records both helpers; the no-edge rule stays with the sync machinery", () => {
    // The grammar's job ends at recording: two modules exporting the same bare
    // name produce two symbols whose `name`s collide and whose `qualifiedName`s
    // do not. Whether that collision builds zero edges is the sync's ambiguity
    // rule ("Ambiguous names build nothing", src/core/codebase/sync.ts), pinned
    // end to end by the Phase 1 fixture in tests/codebase-sync.test.ts
    // ("builds no edge when a two-level chain's target is ambiguous").
    const aSrc = "pub mod a {\n    pub fn helper(x: u32) -> u32 {\n        x\n    }\n}\n";
    const bSrc = "pub mod b {\n    pub struct Helper;\n\n    impl Helper {\n        pub fn helper(&self, x: u32) -> u32 {\n            x\n        }\n    }\n}\n";
    writeFileSync(join(dir, "src", "a", "mod.rs"), aSrc);
    writeFileSync(join(dir, "src", "b", "mod.rs"), bSrc);
    const aParsed = rustGrammar.parse(aSrc, rustGrammar.blank(aSrc));
    const bParsed = rustGrammar.parse(bSrc, rustGrammar.blank(bSrc));
    const aFn = aParsed.symbols.find((s) => s.name === "helper");
    const bFn = bParsed.symbols.find((s) => s.name === "helper");
    expect(aFn?.kind).toBe("function");
    expect(aFn?.qualifiedName).toBe("a::helper");
    expect(bFn?.kind).toBe("method");
    expect(bFn?.qualifiedName).toBe("b::Helper.helper");
    expect(bFn?.parent).toBe("b::Helper");
    expect(aFn?.name).toBe(bFn?.name);
    expect(aFn?.qualifiedName).not.toBe(bFn?.qualifiedName);
    // Module rows are the module nodes: distinct, qualified, parented at root.
    expect(aParsed.symbols.find((s) => s.qualifiedName === "a")?.kind).toBe("module");
    expect(bParsed.symbols.find((s) => s.qualifiedName === "b")?.kind).toBe("module");
  });
});
