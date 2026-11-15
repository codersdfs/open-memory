import { posix } from "node:path";
import type { CodeSymbolKind } from "../types.js";
import type { LanguageGrammar, ParsedFile, ParsedImport, ParsedMemberCall, ParsedSymbol } from "./types.js";

/**
 * Rust as a registry grammar (roadmap Phase 2, brace family, ledger task C4). The
 * blanker covers the lexical forms the brace tracker must not trip over — line
 * comments, NESTED block comments (legal Rust, and what every doctest fence is
 * made of), `"..."` strings with escapes, `r"..."` / `r#"..."#` raw strings that
 * may span lines, and char literals — all length-preserving with every newline
 * kept, so offset arithmetic stays honest. The parser fills the same ParsedFile
 * shapes the TS/JS scanner fills, with kinds mapped onto the shared set and
 * nothing invented (Ruling 3): `fn` → function, `struct` → type, `trait` →
 * interface, `enum` → enum, `impl`/`trait` members → method whose parent is the
 * implemented type, `use` → import, `pub use` → re-export.
 *
 * Rust's three real traps for a structural scanner, all handled here:
 *  - **lifetimes vs char literals.** `'a`, `&'a str` and `'static` look exactly
 *    like an unterminated char literal, and a blanker that treats them as one
 *    swallows the rest of the line — including the `fn` keyword it was about to
 *    read. See `blankRust` for the bounded-window rule that tells them apart;
 *    lifetimes are never blanked.
 *  - **nested block comments.** An inner comment opener inside an outer comment
 *    makes the outer one end at its SECOND terminator, not the first. A
 *    non-nesting blanker stops early and reads the tail of the comment — and
 *    everything up to the next real terminator — as code, which is how a doctest
 *    fence plants symbols that were never written. (The literal sequences are
 *    spelled out in `blankRust` and in the fixture, not in this comment, because
 *    writing them here would close this comment.)
 *  - **the mod/use tree.** Rust imports are not path-relative: `use
 *    crate::a::b;` resolves against `src/`, the importing file's module
 *    directory, and `Cargo.toml` rules this scanner cannot read. `resolveImport`
 *    therefore returns an ORDERED list of candidate paths (documented there) and
 *    lets the sync's `files.has()` decide; a spec that lands nowhere builds no
 *    edge, the same rule every other grammar follows.
 *
 * What this scanner leaves out rather than lying about: macro definitions and
 * invocations (`macro_rules!`, `println!` — their expansion does not exist until
 * the compiler makes it), `union` and `extern` blocks (no shared kind says what
 * they are), items declared inside a function body (bodies are jumped whole, as
 * every brace grammar jumps them), and the trait side of `impl Trait for Type`
 * (the shared shape has nowhere to put it).
 */

const IDENT_RE = /^[A-Za-z_]\w*/;

/**
 * Receivers that name the enclosing type rather than a value: `self` (the impl's
 * receiver) and `Self` (the type itself, `Self::new(`). They are keywords, so the
 * filters below would drop them — and a method calling its own type's siblings is
 * exactly what the member-call raw material exists for.
 */
const SELF_RECEIVERS = new Set(["self", "Self"]);

/**
 * A parsed Rust symbol. `mod` declarations land with kind `module` — a word of
 * the SHARED `CodeSymbolKind` set, so Ruling 3 is honoured — while
 * `ParsedSymbol.kind` deliberately excludes it because `sync.ts` synthesizes one
 * module node per FILE and never parses one. Widening the kind here is the
 * honest way to say "this is a module": the row survives as a second, `mod`-level
 * module node whose children point at it through `parentId`, while the sync's own
 * module-node lookups still take the file row it pushes first (`sync.ts` builds
 * `rows` with the file node at index 0 and finds it with
 * `find(r => r.kind === "module")`), so no node is duplicated and no edge
 * cascade changes (`seedEntry` and the call-edge loops skip `module` rows).
 */
type RustSymbol = Omit<ParsedSymbol, "kind"> & { kind: CodeSymbolKind };

/**
 * Rust's reserved words plus the contextual keywords that can never hold a
 * declaration's name and are never a call target (`async`, `dyn`, `impl`, `in`,
 * `pub`, `ref`, `move`, `where`, `self`, `Self`, …). Deliberately narrow: a
 * contextual keyword that real code does use as an identifier (`union`, `try_`,
 * `gen`) stays out, so a symbol honestly named that is not swallowed.
 */
const KEYWORDS = new Set([
  "abstract", "as", "async", "await", "become", "box", "break", "const", "continue", "crate",
  "dyn", "else", "enum", "extern", "false", "final", "fn", "for", "if", "impl", "in", "let",
  "loop", "macro", "macro_rules", "match", "mod", "move", "mut", "override", "priv", "pub",
  "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type",
  "typeof", "unsafe", "unsized", "use", "virtual", "where", "while", "yield"
]);

/**
 * Std traits, collections, primitives and pervasive macros: identifier-shaped,
 * present in nearly every file, and never a symbol another file owns — so never
 * a call-edge candidate (the exclusion the TS/Go/Java/C# grammars all apply,
 * ADR-0050).
 */
const GLOBALS = new Set([
  "Clone", "Copy", "Debug", "Default", "Drop", "Eq", "From", "FromStr", "Into", "Ord", "PartialEq",
  "PartialOrd", "Send", "Sized", "Sync", "Unpin", "Fn", "FnMut", "FnOnce", "Iterator", "AsRef",
  "Some", "None", "Ok", "Err",
  "Box", "Vec", "String", "Str", "Slice", "HashMap", "HashSet", "BTreeMap", "BTreeSet", "VecDeque",
  "BinaryHeap", "Rc", "Arc", "Weak", "Cell", "RefCell", "Mutex", "RwLock", "Cow", "Path", "PathBuf",
  "OsString", "OsStr", "CString", "Option", "Result", "Instant", "Duration", "Thread", "JoinHandle",
  "isize", "usize", "i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128", "f32",
  "f64", "bool", "char", "str",
  "assert", "assert_eq", "assert_ne", "debug_assert", "panic", "unimplemented", "unreachable",
  "todo", "write", "writeln", "print", "println", "eprint", "eprintln", "format", "vec", "matches",
  "dbg", "include_str", "include_bytes", "concat", "env", "stringify", "module_path"
]);

/**
 * Length-preserving blanking. Comments hide completely (a line comment's extent
 * IS the newline, which survives; a nested block comment hides character by
 * character so its newlines keep counting). Strings and raw strings hide their
 * interior with every newline kept — a raw string may span lines, and losing
 * those newlines is exactly how line numbers after it drift. Char literals hide
 * too, but ONLY when they genuinely are one.
 *
 * LIFETIME HEURISTIC, stated honestly because Rust makes the exact split
 * undecidable without a real parser: a `'` opens a char literal only when a
 * closing `'` turns up inside a bounded window after it — 4 characters, the
 * shortest bound that covers every legal char body (`a`, `\n`, `\'`, `\\`),
 * widened to 12 for the one fixed-shape exception `\u{...}`. The window stops at
 * a newline, so a lifetime can never reach across a line. Anything else is a
 * lifetime (`'a`, `'static`, `&'a str`, `fn f<'a>(x: &'a str)`) and the quote
 * stays VISIBLE in the blanked copy, the same courtesy Go's blanker extends to
 * string delimiters so the parser can still read the text around it.
 *
 * The cost of the bound, in both directions: two lifetimes written close
 * together — `<'a, 'b>` puts the second quote 4 characters after the first — read
 * as a char literal and blank the few characters between them, so generic
 * parameter NAMES disappear from the blanked copy (no symbol, no line, and no
 * brace is ever lost, so nothing after shifts). Conversely, a Unicode char
 * literal written with extra spaces inside its braces would be mistaken for a
 * lifetime and left visible — which plants no declaration either, because its
 * interior is hex digits and braces. The failure mode is a lost identifier, never
 * a fake declaration: the dangerous direction (a swallowed `fn` keyword, which is
 * what treating lifetimes as char literals would cause) is closed by construction.
 */
function blankRust(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < src.length; k++) {
      out[k] = src[k] === "\n" ? "\n" : " ";
    }
  };
  /** Count of `#` starting at `at` — a raw string's delimiter strength. */
  const hashes = (at: number): number => {
    let n = 0;
    while (src[at + n] === "#") n++;
    return n;
  };
  /** End of the char literal opened at `i`, or -1 when the quote is a lifetime. */
  const charLiteralEnd = (): number => {
    const limit = src.slice(i + 1, i + 3) === "\\u" ? i + 12 : i + 4;
    for (let j = i + 1; j <= limit && j < src.length; j++) {
      const c = src[j]!;
      if (c === "\n" || c === "\r") return -1;
      if (c === "\\") {
        j++;
        if (j >= src.length) return -1;
        continue;
      }
      if (c === "'") return j;
    }
    return -1;
  };
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 0;
      let j = i;
      while (j < src.length) {
        if (src[j] === "/" && src[j + 1] === "*") {
          depth++;
          j += 2;
          continue;
        }
        if (src[j] === "*" && src[j + 1] === "/") {
          depth--;
          j += 2;
          if (depth === 0) break;
          continue;
        }
        j++;
      }
      const to = Math.min(j, src.length);
      blank(i, to);
      i = to;
      continue;
    }
    if (c === '"' || c === "r") {
      // `"..."` — and `b"..."`, whose `b` is an ordinary identifier character the
      // walk leaves visible while the quote still hides its bytes — or a raw
      // string `r"..."` / `r#"..."#` / `br"..."`. The `#`s of a raw string sit on
      // BOTH sides of the quote (`r#"..."#`), so the opener is `r`, then the
      // hashes, then the quote.
      const raw = c === "r";
      const h = raw ? hashes(i + 1) : 0;
      const quote = raw ? i + 1 + h : i;
      if (raw && src[quote] !== '"') {
        // Not a string. `r#ident` is a RAW IDENTIFIER (Rust 2018: the way a
        // keyword is spelled as an item name, `fn r#type()`). The `#` is not a
        // token a declaration parser can step over, so the prefix is blanked
        // away: `fn r#type(` reads as `fn type(`, which names the item the way
        // the module path does. Bare `r` is left visible — a variable named `r`
        // is common in generated code, and the letter alone is not a delimiter.
        // The same cleanup reaches a `use` path read from this copy
        // (`use crate::r#type::Item;` keeps the alias-less path with the keyword
        // spelled plainly), which still names the same file: the effect is on the
        // spelling, never on where the candidate list points.
        if (h > 0 && /^[A-Za-z_]/.test(src[quote] ?? "")) {
          blank(i, i + 1 + h);
          i = quote;
          continue;
        }
        i++;
        continue;
      }
      const closer = raw ? `"${"#".repeat(h)}` : '"';
      let j = quote + 1;
      let closed = false;
      while (j < src.length) {
        if (!raw && src[j] === "\\") {
          blank(j, j + 2);
          j += 2;
          continue;
        }
        if (src.startsWith(closer, j)) {
          closed = true;
          break;
        }
        if (!raw && src[j] === "\n") break;
        j++;
      }
      if (!raw && !closed) {
        // Unterminated interpreted string: stop at the newline, the same
        // courtesy `blankSource` extends to one in TS/JS.
        blank(quote + 1, j);
        i = j;
        continue;
      }
      blank(quote + 1, closed ? j : src.length);
      i = closed ? j + closer.length : src.length;
      continue;
    }
    if (c === "'") {
      const end = charLiteralEnd();
      if (end !== -1) {
        blank(i + 1, end);
        i = end + 1;
        continue;
      }
      // Lifetime: the quote and everything after it stay visible.
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Index of the bracket matching the opener, or -1 when unbalanced. */
const matchBracket = (text: string, open: number, openCh: string, closeCh: string): number => {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    const c = text[k]!;
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
};

/**
 * Where a declaration's header ends: the first `{` (its body brace) or `;` (a
 * braceless declaration — a tuple struct, a trait's required method, a `static`)
 * at bracket-depth zero, searched only up to `limit` (the enclosing scope's
 * closing brace, so a header can never run into the next sibling file scope).
 *
 * Angle brackets are deliberately NOT tracked: `a < b`, `Box<T>` and `==` make
 * `<` ambiguous in general code, and no Rust declaration puts a `{` or `;` inside
 * generic arguments where the tracker would need them. A `}` at depth zero is the
 * enclosing body's end, so it stops the search rather than running on.
 */
const headEnd = (text: string, from: number, limit: number): { brace: number; semi: number; at: number } => {
  let depth = 0;
  const stop = Math.min(limit, text.length);
  for (let k = from; k < stop; k++) {
    const c = text[k]!;
    if (c === "(" || c === "[") {
      depth++;
      continue;
    }
    if (c === ")" || c === "]") {
      if (depth > 0) depth--;
      continue;
    }
    if (depth !== 0) continue;
    if (c === "{") return { brace: k, semi: -1, at: k };
    if (c === ";") return { brace: -1, semi: k, at: k };
    if (c === "}") return { brace: -1, semi: -1, at: k };
  }
  return { brace: -1, semi: -1, at: stop };
};

const endOfLine = (text: string, from: number): number => {
  const nl = text.indexOf("\n", from);
  return nl === -1 ? text.length : nl;
};

/** Newlines in `text[from…to)` — the carry every leap and extent needs. */
const countNewlines = (text: string, from: number, to: number): number => {
  let n = 0;
  for (let k = Math.max(0, from); k < Math.min(to, text.length); k++) if (text[k] === "\n") n++;
  return n;
};

/** First `;` at bracket-depth zero, or -1 — the fallback for a macro statement. */
const firstSemi = (text: string, from: number, limit: number): number => {
  let depth = 0;
  for (let k = from; k < Math.min(limit, text.length); k++) {
    const c = text[k]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return -1;
      depth--;
    } else if (c === ";" && depth === 0) return k;
  }
  return -1;
};

/**
 * The `pub` prefix, read from the BLANKED text so a comment cannot pose as
 * visibility: `pub`, `pub(crate)`, `pub(super)`, `pub(in crate::path)`.
 */
const VIS_RE = /^pub(?:\s*\([^)]*\))?\s+/;

/**
 * Rust visibility is written, not inferred from the name's case (the opposite of
 * Go). Only a bare `pub` exports: `pub(crate)`/`pub(super)`/`pub(in …)` are
 * crate-internal and cannot be `use`d from outside, and the sync resolves a
 * `use`'s name through `exportedIds` — a map built from exactly this flag — so
 * claiming an export the language does not grant would invent an edge.
 */
const isExported = (vis: string): boolean => /^pub\s*$/.test(vis.trim());

/** Any `pub` form, restricted-path included: `pub(crate) use x;` re-exports. */
const isReExport = (vis: string): boolean => vis.trimStart().startsWith("pub");

/**
 * Identifier at `at` plus its generic argument list (`Vec<u8>`), so callers land
 * after the type rather than inside it.
 */
const readTypeName = (text: string, at: number): { name: string; end: number } | null => {
  const m = IDENT_RE.exec(text.slice(at, at + 200));
  if (!m) return null;
  let j = at + m[0].length;
  while (j < text.length && /\s/.test(text[j]!)) j++;
  if (text[j] === "<") {
    const close = matchBracket(text, j, "<", ">");
    if (close !== -1) j = close + 1;
    while (j < text.length && /\s/.test(text[j]!)) j++;
  }
  return { name: m[0], end: j };
};

/**
 * The type an `impl` block hangs its methods on: `impl List` → `List`,
 * `impl<'a> List<'a>` → `List`, `impl fmt::Debug for List` → `List` (the trait
 * side is dropped — the shared shape has no field for it), `impl &List` →
 * `List`. A qualified path yields its LAST segment, the plain name the type is
 * recorded under (Go's receiver parser keeps the same rule). Anything the scanner
 * cannot name yields null and the block is skipped whole rather than given a
 * guessed parent.
 */
const readImplOwner = (text: string, at: number): string | null => {
  /** Skip whitespace, a leading `&`, one lifetime, and a generic head. */
  const skipTo = (from: number): number => {
    let k = from;
    while (k < text.length && (/\s/.test(text[k]!) || text[k] === "&")) k++;
    if (text[k] === "'") {
      const life = IDENT_RE.exec(text.slice(k + 1, k + 40));
      if (life) k += 1 + life[0].length;
      while (k < text.length && /\s/.test(text[k]!)) k++;
    }
    if (text[k] === "<") {
      const close = matchBracket(text, k, "<", ">");
      if (close === -1) return -1;
      k = close + 1;
      while (k < text.length && /\s/.test(text[k]!)) k++;
    }
    return k;
  };
  let j = skipTo(at);
  if (j === -1) return null;
  let name: string | null = null;
  for (;;) {
    const read = readTypeName(text, j);
    if (!read) return null;
    // A keyword where a type name must be (`impl<T: X> for Y`, malformed but the
    // shape a scanner must survive) is not a type: the block gets no owner and
    // is skipped whole rather than filing its methods under `for`.
    if (KEYWORDS.has(read.name)) return null;
    name = read.name;
    j = read.end;
    if (text.startsWith("::", j)) {
      const next = skipTo(j + 2);
      if (next === -1) return null;
      j = next;
      continue;
    }
    break;
  }
  const forM = /^for\s+/.exec(text.slice(j, j + 12));
  if (forM) {
    const target = skipTo(j + forM[0].length);
    if (target === -1) return null;
    const read = readTypeName(text, target);
    if (!read || KEYWORDS.has(read.name)) return null;
    return read.name;
  }
  return name;
};

/**
 * `<receiver>.<method>(` and `<Type>::<method>(` inside one body — the raw
 * material the sync resolves into `calls` edges (ADR-0050). Rust spells method
 * calls and associated-function calls the same way, so `List::new(` lands as
 * receiver `List`, exactly what the sync's receiver-is-the-class rule turns into
 * an edge to `List.new`. `self.method(` is recorded with the honest receiver
 * name: the sync's `this` rule is TS/Java/C#-specific and does not claim `self`,
 * so those pairs build nothing here — the shape is right, the resolution is the
 * shared machinery's call.
 */
const collectMemberCalls = (text: string, from: number, to: number): ParsedMemberCall[] => {
  const calls = new Map<string, ParsedMemberCall>();
  const slice = text.slice(from, Math.max(from, to));
  const re = /(?<=^|[^.\w$])([A-Za-z_]\w*)\s*(?:\.|::)\s*([A-Za-z_]\w*)\s*\(/g;
  for (const m of slice.matchAll(re)) {
    const receiver = m[1]!;
    const method = m[2]!;
    // `self`/`Self` name the enclosing type, the Rust spelling of Java's `this`;
    // they are keywords, so the ordinary filter would drop them.
    if (!SELF_RECEIVERS.has(receiver) && (KEYWORDS.has(receiver) || GLOBALS.has(receiver))) continue;
    if (KEYWORDS.has(method) || GLOBALS.has(method)) continue;
    if (receiver === "std" || receiver === "core" || receiver === "alloc") continue;
    calls.set(`${receiver}.${method}`, { receiver, method });
  }
  return [...calls.values()];
};

/**
 * Identifiers referenced in one body, read from the blanked text so comments and
 * strings cannot plant refs. Identifiers after `.` or `::` are skipped — those
 * pairs are member calls, not bare names, and letting a method name pose as a
 * bare ref would match it against an unrelated function (ADR-0050).
 */
const collectRefs = (text: string, from: number, to: number, self: string): string[] => {
  const refs = new Set<string>();
  const slice = text.slice(from, Math.max(from, to));
  const re = /(?<=^|[^.:\w])[A-Za-z_]\w*/g;
  for (const m of slice.matchAll(re)) {
    const name = m[0];
    if (KEYWORDS.has(name) || GLOBALS.has(name) || name === self || name.length < 2) continue;
    refs.add(name);
  }
  return [...refs];
};

/**
 * `let x: Type = …` / `let x = Type::new(…)` — the identifier → simple type map
 * the sync resolves member calls through (ADR-0050). Only the two shapes that
 * state a type bind honestly: an annotation and a constructor call. `let x =
 * compute()` binds nothing, because reading `compute` as the type of `x` would
 * build an edge the code never declared.
 */
const collectLetBindings = (text: string, from: number, to: number, bindings: Record<string, string>): void => {
  const slice = text.slice(from, Math.max(from, to));
  const annotated = /(?:^|[;{}\n])[ \t]*(?:let|static|const)(?:\s+mut)?\s+([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)(?:<[^\n<>]*>)?\s*=/g;
  for (const m of slice.matchAll(annotated)) {
    const name = m[1]!;
    const type = m[2]!;
    if (KEYWORDS.has(name) || KEYWORDS.has(type)) continue;
    bindings[name] = type;
  }
  const constructed = /(?:^|[;{}\n])[ \t]*(?:let|static|const)(?:\s+mut)?\s+([A-Za-z_]\w*)\s*=\s*([A-Z][A-Za-z0-9_]*)::new\s*\(/g;
  for (const m of slice.matchAll(constructed)) {
    const name = m[1]!;
    const type = m[2]!;
    if (KEYWORDS.has(name) || KEYWORDS.has(type)) continue;
    bindings[name] = type;
  }
};

/**
 * Struct fields of the simple `name: Type,` shape — the type → field → type map
 * that lets the sync walk `self.repo.save()` one level (ADR-0050). Only a bare
 * capitalized type name binds: `repo: Repository` yes; `items: Vec<u8>`,
 * `f: fn(u8) -> u8` and `x: &'a dyn Repo` no, because stripping generics or
 * trait objects to guess a type resolves a call through a type the field never
 * had. Lifetimes survive blanking (see the header), so `&'a str` is still visible
 * here and is correctly rejected by the shape.
 */
const collectStructFields = (text: string, from: number, to: number, typeName: string, fields: Record<string, Record<string, string>>): void => {
  const slice = text.slice(from, Math.max(from, to));
  const re = /(?:^|[{,;])[ \t\n]*(?:pub(?:\s*\([^)]*\))?\s+)?([a-z_]\w*)\s*:\s*&?\s*([A-Z][A-Za-z0-9_]*)\b[ \t]*(?=[,;])/g;
  for (const m of slice.matchAll(re)) {
    const field = m[1]!;
    const type = m[2]!;
    if (KEYWORDS.has(field) || KEYWORDS.has(type) || GLOBALS.has(type)) continue;
    (fields[typeName] ??= {})[field] = type;
  }
};

/**
 * Split one `use` body into the full paths it names. `a::{b, c as d}` expands
 * per item — the cheap, exact half of brace-group flattening, since every result
 * is still a plain path. A nested group (`a::{b::{c, d}}`) is skipped as a whole:
 * flattening two levels means deciding what `b::c` is without the module tree,
 * and a half-expanded path is a wrong path. The `{self}` form keeps the enclosing
 * module's own name, which is what Rust binds.
 */
const expandUse = (body: string): string[] => {
  const trimmed = body.replace(/\s+/g, " ").trim();
  if (!trimmed) return [];
  const open = trimmed.indexOf("{");
  if (open === -1) return [trimmed];
  const close = trimmed.lastIndexOf("}");
  if (close < open) return [];
  const prefix = trimmed.slice(0, open).replace(/::\s*$/, "").trim();
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of trimmed.slice(open + 1, close)) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(current);
  const out: string[] = [];
  for (const itemRaw of items) {
    const item = itemRaw.trim();
    if (!item || item.includes("{")) continue;
    // A trailing ` as Alias` is part of the item, not a second path: keeping it
    // means `use a::{b as c, d};` records `a::b as c`, whose bound name
    // `useEntry` reads from the alias. A nested group (`a::{b::{c}}`) is the
    // honest skip above; anything else that fails this shape is skipped too,
    // because a half-expanded path is a wrong path.
    if (!/^(?:[A-Za-z_]\w*|\*|self)(?:\s*::\s*(?:[A-Za-z_]\w*|\*))*(?:\s+as\s+[A-Za-z_]\w*)?$/.test(item)) continue;
    if (item === "self") {
      if (prefix) out.push(prefix);
      continue;
    }
    out.push(prefix ? `${prefix}::${item}` : item);
  }
  return out;
};

/**
 * One expanded `use` path → ParsedImport. The specifier is kept exactly as
 * written (`crate::module::Item`) — the shared contract says as-written
 * (types.ts), and `resolveImport` reads its leading token from it — with one
 * normalization: whitespace around `::` is dropped, because that spacing is
 * formatting and a spec is a lookup key downstream (`use a :: b;` and
 * `use a::b;` are the same import). The single space inside `a::b as c` stays,
 * since it is what separates the path from its binding. The bound name is the
 * last segment, or the `as` alias — the deliberate divergence from the TS
 * scanner, which keeps the PRE-alias name because a JS module exports under it.
 * Rust's `use a::b as c;` binds `c` and leaves `b` unreachable in this file, so
 * `c` is the name its body calls and the only one an edge can honestly follow.
 */
const useEntry = (path: string): ParsedImport | null => {
  const spec = path.replace(/\s*::\s*/g, "::").replace(/\s+/g, " ").trim();
  if (!spec) return null;
  const segments = spec.split("::").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return null;
  const last = segments[segments.length - 1]!;
  if (last === "*") {
    // `use a::b::*;` imports every name in the module without naming one, so
    // `names` stays empty and the sync's module-node fallback is the only edge
    // it can build.
    return { spec, names: [], namespace: null, defaultName: null, sideEffect: true, isExport: false };
  }
  const aliasM = /^([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)$/.exec(last);
  const name = aliasM ? aliasM[2]! : last;
  if (!/^[A-Za-z_]\w*$/.test(name) || KEYWORDS.has(name)) return null;
  return { spec, names: [name], namespace: null, defaultName: null, sideEffect: false, isExport: false };
};

/** One scope the linear walk is inside: an inline `mod`, `impl` or `trait` body. */
interface Scope {
  kind: "module" | "impl" | "trait";
  /** The module path enclosing this scope's declarations (`""`, `"m::inner"`). */
  modulePath: string;
  /** For `impl`/`trait`: the parent a member method is filed under. */
  owner: string | null;
  /** Index of the body's closing brace — where the scope ends. */
  close: number;
  /** The line of that brace, kept so a module row's extent can close honestly. */
  closeLine: number;
  /** Module scopes carry the row whose extent closes with the scope. */
  sym?: RustSymbol;
}

/**
 * Parse one Rust source file into the shared shapes. `blanked` is sync's
 * precomputed `blank(src)`; raw literals (signatures, `use` paths) are read from
 * `src` at the same offsets — the established pattern (ADR-0050). Never throws
 * for parseable-looking code: a structural surprise surfaces as `parseError` and
 * the sync moves on.
 *
 * One linear pass over the blanked text with a scope stack. Every construct the
 * walk does not model — function, struct and enum bodies, macro invocations — is
 * jumped whole after its extents and refs are taken, so every position the walk
 * inspects is a declaration position: top level, or inside a `mod`/`impl`/`trait`
 * body. That is what lets Rust skip the statement-shape heuristics the Java and
 * C# grammars need, and it is why an item declared inside a function body is not
 * recorded: the same jump that makes everything else exact goes past it.
 */
function parseRust(src: string, blanked: string): ParsedFile {
  try {
    const text = blanked;
    const symbols: RustSymbol[] = [];
    const imports: ParsedImport[] = [];
    const reExports: ParsedImport[] = [];
    const bindings: Record<string, string> = {};
    const fields: Record<string, Record<string, string>> = {};
    const scopes: Scope[] = [];
    let line = 1;
    let i = 0;

    // Jump helper: every branch that leaps `i` forward must carry the newline
    // count with it, or every lineStart after a multi-line signature drifts and
    // body refs slice the wrong lines (the bug ADR-0050's own repo exposed).
    const advance = (to: number): void => {
      for (let k = i; k < to && k < text.length; k++) {
        if (text[k] === "\n") line++;
      }
      i = Math.min(Math.max(to, i), text.length);
    };

    const scopeLimit = (): number => (scopes.length ? scopes[scopes.length - 1]!.close : text.length);
    const modulePath = (): string => (scopes.length ? scopes[scopes.length - 1]!.modulePath : "");
    /**
     * The nearest impl/trait owner, if any — what makes an `fn` a method. The
     * search STOPS at a module scope: a `mod` inside an `impl` body declares
     * items of its own, and filing them as the impl's methods would be a lie.
     */
    const owner = (): string | null => {
      for (let k = scopes.length - 1; k >= 0; k--) {
        const scope = scopes[k]!;
        if (scope.kind === "module") return null;
        if (scope.owner) return scope.owner;
      }
      return null;
    };

    /**
     * Qualified name inside the current scope: members nest with `.` (the shared
     * `Type.method` shape the ledger names), items nest with `::` — Rust's own
     * spelling, and the string a `use crate::m::Item;` writes, which is what
     * lets the sync's name lookup meet a module-nested item halfway.
     */
    const qualified = (name: string, parent: string | null): string => {
      if (parent) return `${parent}.${name}`;
      const prefix = modulePath();
      return prefix ? `${prefix}::${name}` : name;
    };

    const pushImport = (list: ParsedImport[], entry: ParsedImport): void => {
      const dup = list.find((q) => q.spec === entry.spec && q.isExport === entry.isExport);
      if (dup) {
        for (const n of entry.names) if (!dup.names.includes(n)) dup.names.push(n);
        return;
      }
      list.push(entry);
    };

    /**
     * `use` (or `pub use`) at `at`: read to the terminating `;` at bracket-depth
     * zero, expand any brace group, record one entry per path. The path text
     * comes from the BLANKED copy: a Rust path is pure identifiers, `::`, braces
     * and `as` — it holds no literal — so that copy keeps every character and
     * turns any comment inside the statement (legal, between brace-group items)
     * into the spaces `expandUse` already collapses.
     */
    const readUse = (at: number, vis: string): number => {
      let depth = 0;
      let end = -1;
      const limit = scopeLimit();
      for (let k = at; k < limit; k++) {
        const c = text[k]!;
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") {
          if (depth === 0) break;
          depth--;
        } else if (c === ";" && depth === 0) {
          end = k;
          break;
        }
      }
      if (end === -1) return -1;
      const body = text.slice(at + 3, end);
      const stripped = isReExport(vis) ? body.replace(/^\s*pub(?:\s*\([^)]*\))?\s+/, "") : body;
      for (const path of expandUse(stripped)) {
        const entry = useEntry(path);
        if (!entry) continue;
        if (isReExport(vis)) {
          entry.isExport = true;
          pushImport(reExports, entry);
          continue;
        }
        pushImport(imports, entry);
      }
      return end + 1;
    };

    /**
     * Enter a braced body: record the closing brace's line for the extent, push
     * the scope, and leave the cursor INSIDE the body (just after the `{`) so the
     * walk reads its declarations. `open` is that brace, `line`-wise still ahead
     * of the cursor's own line, which is why the count runs from `i`.
     */
    const enter = (open: number, scope: Omit<Scope, "closeLine">): void => {
      const closeLine = line + countNewlines(text, i, scope.close);
      scopes.push({ ...scope, closeLine });
      advance(open + 1);
    };

    /** Pop every scope the cursor has left, closing its module row's extent. */
    const leaveScopes = (): void => {
      while (scopes.length && i > scopes[scopes.length - 1]!.close) {
        const scope = scopes.pop()!;
        if (scope.sym) scope.sym.lineEnd = scope.closeLine;
      }
    };

    while (i < text.length) {
      leaveScopes();
      const c = text[i]!;
      if (c === "\n") {
        line++;
        i++;
        continue;
      }
      if (c === "#") {
        // Attribute: `#[derive(Debug)]`, `#[cfg(test)] mod …` carry no
        // declaration of their own, so the list is skipped and the item it
        // decorates is what the next iteration reads.
        const open = i + 1;
        if (text[open] === "[") {
          const close = matchBracket(text, open, "[", "]");
          if (close === -1) {
            advance(endOfLine(text, i));
            continue;
          }
          advance(close + 1);
          continue;
        }
        i++;
        continue;
      }
      if (!/[A-Za-z_]/.test(c)) {
        i++;
        continue;
      }

      const rest = text.slice(i, Math.min(text.length, i + 400));

      // Bare `use` (no visibility prefix) is checked before anything else: its
      // brace group's items are paths, never declarations.
      if (/^use\b/.test(rest)) {
        const next = readUse(i, "");
        if (next === -1) {
          advance(endOfLine(text, i));
          continue;
        }
        advance(next);
        continue;
      }

      // Macro invocation or `macro_rules!` definition: an identifier followed by
      // `!`. Its expansion is not source text and nothing inside it is a symbol,
      // so the whole balanced group (or the statement) is jumped.
      const bangM = /^[A-Za-z_]\w*\s*!(?:\s*[A-Za-z_]\w*)?\s*([{[(])/.exec(rest);
      if (bangM && bangM[1]) {
        const openCh = bangM[1];
        const closeCh = openCh === "{" ? "}" : openCh === "[" ? "]" : ")";
        const open = i + bangM[0].length - 1;
        const close = matchBracket(text, open, openCh, closeCh);
        if (close === -1) {
          advance(endOfLine(text, i));
          continue;
        }
        advance(text[close + 1] === ";" ? close + 2 : close + 1);
        continue;
      }
      if (/^[A-Za-z_]\w*\s*!/.test(rest)) {
        // `foo!;` or a macro with no group — the statement form.
        const semi = firstSemi(text, i, scopeLimit());
        advance(semi === -1 ? endOfLine(text, i) : semi + 1);
        continue;
      }

      // Visibility, then the modifiers that may precede an item keyword.
      const visM = VIS_RE.exec(rest);
      const vis = visM ? visM[0] : "";
      let decl = i + (vis ? vis.length : 0);
      for (;;) {
        const m = /^(?:unsafe|extern(?:\s+"[^"]*")?|default|auto|async)\s+/.exec(text.slice(decl, decl + 60));
        if (!m) break;
        decl += m[0].length;
      }
      const declRest = text.slice(decl, Math.min(text.length, decl + 400));
      const limit = scopeLimit();

      if (/^use\b/.test(declRest)) {
        const next = readUse(decl, vis);
        if (next === -1) {
          advance(endOfLine(text, i));
          continue;
        }
        advance(next);
        continue;
      }

      // --- fn: function, or method inside an impl/trait scope ---------------
      const fnM = /^(?:const\s+)?fn\s+([A-Za-z_]\w*)/.exec(declRest);
      if (fnM) {
        const startLine = line;
        const name = fnM[1]!;
        const head = headEnd(text, decl + fnM[0].length, limit);
        // The KIND and the edge follow the impl/trait owner; the PARENT field
        // falls back to the enclosing `mod`'s row, so a module-nested function
        // hangs off its module like every other item does (the sync files
        // `parentId` from it, and only `this` receivers read it for member
        // calls — a form Rust never writes).
        const ownerName = owner();
        const parent = ownerName ?? (modulePath() || null);
        const sym: RustSymbol = {
          name,
          kind: ownerName ? "method" : "function",
          qualifiedName: qualified(name, ownerName),
          signature: src.slice(i, head.at).replace(/\s+/g, " ").trim().slice(0, 120),
          lineStart: startLine,
          lineEnd: null,
          exported: isExported(vis),
          parent,
          refs: [],
          memberCalls: []
        };
        symbols.push(sym);
        if (head.brace === -1) {
          // Declared, not defined: a trait's required method (`fn f(&self);`), an
          // `extern "C"` declaration. The header IS the extent, and there is no
          // body to harvest refs from.
          advance(head.semi === -1 ? endOfLine(text, decl) : head.semi + 1);
          sym.lineEnd = line;
          continue;
        }
        const close = matchBracket(text, head.brace, "{", "}");
        if (close === -1) {
          // Unterminated body: the symbol stays open, the walk resumes after the
          // header — malformed Rust is not our brief (same rule as Go).
          advance(endOfLine(text, head.brace));
          continue;
        }
        advance(head.brace + 1);
        sym.refs = collectRefs(text, i, close, name);
        sym.memberCalls = collectMemberCalls(text, i, close);
        collectLetBindings(text, i, close, bindings);
        advance(close + 1);
        sym.lineEnd = line;
        continue;
      }

      // --- struct / trait / enum -------------------------------------------
      const typeM = /^(struct|trait|enum)\s+([A-Za-z_]\w*)/.exec(declRest);
      if (typeM) {
        const startLine = line;
        const keyword = typeM[1]!;
        const name = typeM[2]!;
        // Ruling 3: struct → type, trait → interface, enum → enum. `union` is a
        // distinct construct with no shared kind, so it is not here at all.
        const kind = keyword === "trait" ? "interface" : keyword === "enum" ? "enum" : "type";
        const head = headEnd(text, decl + typeM[0].length, limit);
        const qual = qualified(name, null);
        const sym: RustSymbol = {
          name,
          kind,
          qualifiedName: qual,
          signature: src.slice(i, head.at).replace(/\s+/g, " ").trim().slice(0, 120),
          lineStart: startLine,
          lineEnd: null,
          exported: isExported(vis),
          parent: modulePath() || null,
          refs: [],
          memberCalls: []
        };
        symbols.push(sym);
        if (keyword === "trait" && head.brace !== -1) {
          // A trait body is WALKED, not jumped: its `fn`s are that trait's
          // methods, filed under it (`Renderer.draw`, parent `Renderer`). A
          // required method (`fn f(&self);`) still lands as a method symbol with
          // the header as its extent — declared here, defined elsewhere.
          const close = matchBracket(text, head.brace, "{", "}");
          if (close === -1) {
            advance(endOfLine(text, head.brace));
            continue;
          }
          sym.lineEnd = line + countNewlines(text, i, close);
          enter(head.brace, { kind: "trait", modulePath: modulePath(), owner: qual, close });
          continue;
        }
        if (head.brace !== -1) {
          const close = matchBracket(text, head.brace, "{", "}");
          if (close === -1) {
            advance(endOfLine(text, head.brace));
            continue;
          }
          if (keyword === "struct") collectStructFields(text, head.brace + 1, close, qual, fields);
          advance(close + 1);
          sym.lineEnd = line;
          continue;
        }
        // Braceless: `struct Unit;`, `struct Tup(i32, u8);`, a `trait T;` (illegal
        // but harmless) — extent = the statement.
        advance(head.semi === -1 ? endOfLine(text, decl) : head.semi + 1);
        sym.lineEnd = line;
        continue;
      }

      // --- type alias -------------------------------------------------------
      const aliasM = /^type\s+([A-Za-z_]\w*)/.exec(declRest);
      if (aliasM) {
        const startLine = line;
        const name = aliasM[1]!;
        const head = headEnd(text, decl + aliasM[0].length, limit);
        const end = head.semi === -1 ? endOfLine(text, decl) : head.semi + 1;
        const sym: RustSymbol = {
          name,
          kind: "type",
          qualifiedName: qualified(name, null),
          signature: src.slice(i, end).replace(/\s+/g, " ").trim().slice(0, 120),
          lineStart: startLine,
          lineEnd: null,
          exported: isExported(vis),
          parent: modulePath() || null,
          refs: [],
          memberCalls: []
        };
        symbols.push(sym);
        advance(end);
        sym.lineEnd = line;
        continue;
      }

      // --- const / static ---------------------------------------------------
      const constM = /^(?:const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)/.exec(declRest);
      // `const fn`/`static` never name a keyword: the guard keeps a `const fn`
      // header (already claimed above) from being read as a constant named `fn`.
      if (constM && !KEYWORDS.has(constM[1]!)) {
        const startLine = line;
        const name = constM[1]!;
        const head = headEnd(text, decl + constM[0].length, limit);
        const end = head.semi === -1 ? endOfLine(text, decl) : head.semi + 1;
        const sym: RustSymbol = {
          name,
          kind: "const",
          qualifiedName: qualified(name, null),
          signature: src.slice(i, end).replace(/\s+/g, " ").trim().slice(0, 120),
          lineStart: startLine,
          lineEnd: null,
          exported: isExported(vis),
          parent: modulePath() || null,
          refs: [],
          memberCalls: []
        };
        symbols.push(sym);
        collectLetBindings(text, decl, end, bindings);
        advance(end);
        sym.lineEnd = line;
        continue;
      }

      // --- impl ------------------------------------------------------------
      if (/^impl\b/.test(declRest)) {
        const ownerName = readImplOwner(text, decl + 4);
        const head = headEnd(text, decl + 4, limit);
        const close = head.brace === -1 ? -1 : matchBracket(text, head.brace, "{", "}");
        if (!ownerName || head.brace === -1) {
          // No honest parent, or no body: the header is skipped, and the block
          // with it when one exists. Its methods get no symbol rather than a
          // wrong owner.
          if (close === -1) {
            advance(head.semi === -1 ? endOfLine(text, decl) : head.semi + 1);
            continue;
          }
          advance(close + 1);
          continue;
        }
        if (close === -1) {
          advance(endOfLine(text, head.brace));
          continue;
        }
        // The impl's scope owns its methods; `modulePath` stays the enclosing
        // module's, so a module-nested impl still qualifies into `m::Type.method`.
        const qual = qualified(ownerName, null);
        enter(head.brace, { kind: "impl", modulePath: modulePath(), owner: qual, close });
        continue;
      }

      // --- mod --------------------------------------------------------------
      const modM = /^mod\s+([A-Za-z_]\w*)/.exec(declRest);
      if (modM) {
        const startLine = line;
        const name = modM[1]!;
        const head = headEnd(text, decl + modM[0].length, limit);
        const qual = qualified(name, null);
        if (head.semi !== -1 && (head.brace === -1 || head.semi < head.brace)) {
          // `mod x;` — a file/directory declaration. Its items live in another
          // file, so this is a module node and nothing more: kind `module`,
          // qualified name the path it declares (top level `x`; nested inside an
          // inline module, `outer::x`).
          symbols.push({
            name,
            kind: "module",
            qualifiedName: qual,
            signature: src.slice(i, head.semi + 1).replace(/\s+/g, " ").trim().slice(0, 120),
            lineStart: startLine,
            lineEnd: startLine,
            exported: isExported(vis),
            parent: modulePath() || null,
            refs: [],
            memberCalls: []
          });
          advance(head.semi + 1);
          continue;
        }
        if (head.brace === -1) {
          advance(endOfLine(text, decl));
          continue;
        }
        const close = matchBracket(text, head.brace, "{", "}");
        const sym: RustSymbol = {
          name,
          kind: "module",
          qualifiedName: qual,
          signature: src.slice(i, head.brace).replace(/\s+/g, " ").trim().slice(0, 120),
          lineStart: startLine,
          // Closed by `leaveScopes` when the walk leaves the body; null for an
          // unterminated one, the same honesty rule as a truncated fn.
          lineEnd: null,
          exported: isExported(vis),
          parent: modulePath() || null,
          refs: [],
          memberCalls: []
        };
        symbols.push(sym);
        if (close === -1) {
          advance(endOfLine(text, head.brace));
          continue;
        }
        enter(head.brace, { kind: "module", modulePath: qual, owner: null, close, sym });
        continue;
      }

      // Nothing this grammar models: a `where`-clause fragment, an
      // `extern crate`, a bare identifier in a braceless position. Skip the whole
      // word so the next one cannot start mid-token and pose as a keyword.
      const wordM = IDENT_RE.exec(rest);
      const skipTo = i + (wordM ? wordM[0].length : 1);
      line += countNewlines(text, i, skipTo);
      i = skipTo;
    }

    // `moduleRefs`/`moduleMemberCalls` stay empty BY DESIGN: Rust has no
    // test-harness callback whose body belongs to the file rather than a function
    // — a `#[test] fn` is an ordinary function symbol, refs and all. Go and Java
    // leave them empty for the same reason.
    return { symbols: symbols as ParsedSymbol[], imports, reExports, bindings, moduleRefs: [], moduleMemberCalls: [], fields };
  } catch (e) {
    return {
      symbols: [],
      imports: [],
      reExports: [],
      bindings: {},
      moduleRefs: [],
      moduleMemberCalls: [],
      fields: {},
      parseError: e instanceof Error ? e.message : String(e)
    };
  }
}

/**
 * Crate path → candidate repo-relative paths, "/"-suffixed candidates meaning a
 * directory prefix (types.ts). Cargo resolves `crate::…`/`self::…`/`super::…`
 * against `src/` and the importing file's own module directory, and a grammar
 * cannot read `Cargo.toml`, `#[path = "…"]`, workspace roots or `src/bin/*.rs` —
 * so these are ORDERED candidates and the sync's `files.has()` is the existence
 * test. No filesystem read happens here (Go's `go.mod` is the only grammar that
 * needs one, because a module prefix cannot be derived from the spec), so
 * `repoRoot` plays no part.
 *
 * Candidate order — most specific first, then the same list one segment shorter,
 * because the LAST segment of a `use` path is the ITEM and the ones before it are
 * MODULES:
 *  1. `crate::a::b` → `src/a/b.rs`, `src/a/b/mod.rs`, `src/a.rs`, `src/a/mod.rs`.
 *     The full path as a file, then as a directory module, then dropped one
 *     segment at a time — which is how `use crate::store::Store;` lands on
 *     `src/store.rs` when `Store` is an item inside it. The ledger's example
 *     `crate::module::Item` therefore yields `src/module/Item.rs`,
 *     `src/module/Item/mod.rs`, `src/module.rs`, `src/module/mod.rs`, and against
 *     a repo holding `src/module.rs` that is the candidate that lands.
 *  2. `self::x` → the list rooted at the importing file's OWN module directory,
 *     and `super::x` → the list rooted at its PARENT module directory. Neither
 *     anchor is simply the directory the file sits in: a file named after a
 *     module owns a directory of its own.
 *       - `src/a/b.rs` declares the module `a::b`; its own directory is
 *         `src/a/b` (where its `mod c;` lives), and its parent module `a` is
 *         declared by `src/a.rs` or `src/a/mod.rs`.
 *       - `src/a/mod.rs` IS its directory's module, so its own directory is
 *         `src/a` and its parent is the crate root.
 *       - `src/lib.rs` / `src/main.rs` is the crate root: own directory `src`,
 *         no parent module.
 *     Each anchor contributes its own list, in this order:
 *       a. `<anchor>/<full path>.rs` and `<anchor>/<full path>/mod.rs`;
 *       b. the same pair with the last segment dropped, and on down — the
 *          `src/store.rs` case above, where the final segment is an ITEM;
 *       c. when one segment is left, the anchor's DECLARING files
 *          (`src/lib.rs`, `src/main.rs`, `src/a.rs`, `src/a/mod.rs`), because
 *          that item may live inline in the file that declares the module:
 *          `use super::helper;` for a `fn helper` written in `src/a.rs`.
 *     `self` adds the containing directory as a second anchor (a repo that
 *     keeps `x.rs` beside `b.rs`, without the `mod x;` hop, is common enough
 *     to be worth the guess); `super` adds the directory above the parent as a
 *     second anchor, so `src/nested/child.rs`'s `super::helper` tries
 *     `src/helper.rs` after `src/nested/helper.rs`. Duplicates are dropped, so
 *     anchors that coincide yield one list. `super::super::x` climbs one module
 *     level per extra leading `super`; a climb out of the repo yields nothing.
 *  3. a TRAILING `*` (`use super::*;`, the `#[cfg(test)] mod tests` idiom) names
 *     a MODULE, not an item, so its candidates are the files that DECLARE it —
 *     the module path as `.rs` / `/mod.rs`, or the anchor's declaring files when
 *     no segment is left. Never a directory prefix: the files under a module
 *     directory declare its SUBMODULES, not the names the glob imports, and
 *     picking one alphabetically would attribute every name to the wrong file.
 *  4. a one-segment bare path (the 2015 `use serde;` and crate forms) → the
 *     sibling lists, WITHOUT the importing file itself: a spec with no module
 *     anchor says nothing about this file's own items, and landing there would
 *     link a module node to itself. An external crate name lands in the same
 *     list and resolves to nothing, because no `src/serde.rs` is indexed.
 *  5. anything else (`std::…`, `::core::…`, `serde::Serialize`, the bare word
 *     `crate`, a spec that is not a path once `::` padding and a trailing
 *     ` as Alias` are removed) → null, which falls through to the default
 *     machinery and builds nothing. An ALIAS is not a reason to give up: the
 *     path keeps its candidates, and since the aliased name is not what the
 *     target file exports, the sync's name lookup misses and its module-node
 *     fallback is what links the two files — the honest half.
 *
 * Repo-relative with forward slashes — the row format `scan.ts` documents and the
 * key format of the sync's `files` map.
 */
function resolveRustImport(spec: string, fromFile: string, _ctx: { repoRoot: string }): string[] | null {
  // A path is identifiers joined by `::`; padding around the separator is
  // formatting, and a trailing ` as Alias` is the binding, not the path (see the
  // doc above for what an aliased spec can still land on). Anything else that
  // survives the cleanup is prose, not a path.
  const withoutAlias = spec.replace(/\s+as\s+[A-Za-z_]\w*$/, "");
  const path = withoutAlias.replace(/\s*::\s*/g, "::").trim();
  if (/\s/.test(path)) return null;
  if (!/^(?:::)?[A-Za-z_]\w*(?:::(?:[A-Za-z_]\w*|\*))*$/.test(path)) return null;
  const segments = path.split("::").filter(Boolean);
  if (segments.length === 0) return null;
  // `a::b::*` imports the names module `a::b` declares: the `*` is not a segment
  // of a path, it is the statement that the path is a module.
  const glob = segments[segments.length - 1] === "*";
  if (glob) segments.pop();
  const file = fromFile.replace(/\\/g, "/");
  const dir = posix.dirname(file);
  const base = posix.basename(file);
  const stem = base.replace(/\.rs$/, "");
  const ROOT_FILES = ["src/lib.rs", "src/main.rs"];
  // A climb out of `src` reaches `/` (the repo root's parent, since paths are
  // repo-relative) or a `..` — neither is an anchor, and `/x.rs` would be a
  // candidate outside the repo the sync's `files` map can never hold.
  const insideRepo = (d: string): boolean =>
    !!d && d !== "." && d !== "/" && d !== ".." && !d.startsWith("../") && !d.startsWith("/");

  // The directory cargo treats as this file's own module directory, and the
  // parent module's directory. `mod.rs`/`init.rs` IS its directory's module;
  // `lib.rs`/`main.rs` is the crate root; any other stem declares a module whose
  // children live in the stem directory — `src/a/b.rs`'s `mod c;` is
  // `src/a/b/c.rs`, so `c`'s `super::x` is `src/a/b/x.rs`.
  const isModFile = base === "mod.rs" || base === "init.rs";
  const isCrateRoot = (base === "lib.rs" || base === "main.rs") && dir === "src";
  const ownDir = isModFile || isCrateRoot ? dir : posix.join(dir, stem);
  const parentDir = posix.dirname(ownDir);

  /** The file(s) that declare the module whose children live in `d`. */
  const declaringFiles = (d: string): string[] =>
    d === "src" || !insideRepo(d) ? [...ROOT_FILES] : [`${d}.rs`, `${d}/mod.rs`];

  /** Ordered anchors, each a directory plus the file(s) that declare it. */
  const anchorsFor = (head: string, climb: number): { dir: string; files: string[] }[] => {
    const climbUp = (d: string, n: number): string => {
      let out = d;
      for (let k = 0; k < n; k++) out = posix.dirname(out);
      return out;
    };
    if (head === "crate") {
      const root = climbUp("src", climb);
      return insideRepo(root) ? [{ dir: root, files: declaringFiles(root) }] : [];
    }
    if (head === "self") {
      const list = [{ dir: ownDir, files: [file, ...declaringFiles(ownDir)] }];
      if (dir !== ownDir) list.push({ dir, files: [file] });
      return list.map((a) => ({ ...a, dir: climbUp(a.dir, climb) })).filter((a) => insideRepo(a.dir));
    }
    if (head === "super") {
      const out: { dir: string; files: string[] }[] = [];
      for (const d of [parentDir, posix.dirname(dir)]) {
        if (!insideRepo(d) || out.some((a) => a.dir === d)) continue;
        out.push({ dir: climbUp(d, climb), files: [] });
      }
      return out
        .filter((a) => insideRepo(a.dir))
        .map((a) => ({ dir: a.dir, files: declaringFiles(a.dir) }));
    }
    return [];
  };

  /** `<anchor>/<path>.rs` then `<anchor>/<path>/mod.rs`, deepest prefix first. */
  const candidates = (dirOf: string, segs: string[]): string[] => {
    const out: string[] = [];
    for (let n = segs.length; n >= 1; n--) {
      const prefix = [dirOf, ...segs.slice(0, n)].filter((s) => s && s !== ".").join("/");
      if (!prefix) continue;
      out.push(`${prefix}.rs`, `${prefix}/mod.rs`);
    }
    return out;
  };

  const head = segments[0]!;
  const rest = segments.slice(1);
  if (head !== "crate" && head !== "self" && head !== "super") {
    if (path.startsWith("::") || segments.length > 1 || glob) {
      // A global path (`::core::fmt`) or a bare qualified path (`serde::Serialize`,
      // `anyhow::Result`) names a crate this repo does not contain; guessing a
      // directory from it would point an import edge at an unrelated file.
      return null;
    }
    // A single bare segment: the 2015 `use serde;` form. Sibling modules first;
    // deliberately no entry for the importing file itself (see the doc above).
    const out = anchorsFor("self", 0).flatMap((a) => candidates(a.dir, segments));
    return out.length ? [...new Set(out)] : null;
  }
  // Leading `super`s after the first climb one module level each.
  let segs = rest;
  let climb = 0;
  while (segs.length > 1 && segs[0] === "super") {
    climb++;
    segs = segs.slice(1);
  }
  const anchors = anchorsFor(head, climb);
  if (!anchors.length) return null;
  // `crate`/`self`/`super` ALONE (no `*`, no segment left) name a module with no
  // item to file: for `self`/`super` the module IS this file's own or its
  // parent's, so the declaring files are the answer; for `crate` the bare word
  // would prefix-match the repo, so nothing is claimed.
  if (segs.length === 0 && !glob) return head === "crate" ? null : [...new Set(anchors.flatMap((a) => a.files))];
  const out = anchors.flatMap((a) => {
    const paths = candidates(a.dir, segs);
    // A trailing `*` names a MODULE, so only the files that declare it — never
    // the directory prefix, whose first file alphabetically declares submodules,
    // not the names the glob imports. With no segment left the anchor's own
    // declaring files are the module. Otherwise one segment may still be an ITEM
    // declared INLINE in the anchor's file — `use crate::helper;` for a
    // `fn helper` in `src/lib.rs`.
    if (glob) return segs.length ? paths : a.files;
    return segs.length === 1 ? [...paths, ...a.files] : paths;
  });
  return out.length ? [...new Set(out)] : null;
}

export const rustGrammar: LanguageGrammar = {
  id: "rust",
  label: "Rust",
  extensions: [".rs"],
  blank: blankRust,
  parse: parseRust,
  resolveImport: resolveRustImport
};
