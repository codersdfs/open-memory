import type { LanguageGrammar, ParsedFile, ParsedImport, ParsedMemberCall, ParsedSymbol } from "./types.js";

/**
 * Kotlin as a registry grammar (roadmap Phase 2, brace family — ledger task C5).
 * The bargain is the one `go.ts` and `java.ts` strike: one pass blanks comments
 * and strings length-preserving, a second walks declarations with a brace
 * tracker whose jumps carry the newline count (the rule ADR-0050's own repo
 * taught the TS scanner, so a signature wrapped over four lines drifts nothing).
 *
 * Kotlin's specific shapes and the v1 choices about them:
 *
 *   - **block comments nest** — an inner opener inside an outer comment is
 *     real Kotlin — so the blanker tracks a comment depth of its own instead
 *     of searching for the first close delimiter;
 *   - **raw strings** (`"""…"""`) span lines and have no escapes at all: the
 *     whole body blanks to spaces with every newline kept — and its body,
 *     `$name`/`${…}` interpolation included, is blanked too (v1 choice,
 *     because the body of a raw string is content rather than code). Only the
 *     six delimiter quotes stay visible, the same courtesy regular strings get:
 *     an extent scan reads the newline after the closing `"""` as the end of a
 *     `val doc = """…"""` statement. Cost, stated: refs that live only inside
 *     a raw string are not collected;
 *   - **regular strings** hide their literal text, and the `$` sigil of a
 *     simple `$name` interpolation, but keep the interpolated NAME and the
 *     `${expr}` block visible as code — reading a variable inside a string is
 *     a reference, so it belongs in `refs`. String delimiters stay visible (as
 *     in Go) so extent scans can still read a statement's shape, and the
 *     visible `${ … }` braces are hopped as string content, never claimed as a
 *     declaration body. Char literals blank whole;
 *   - **kinds come from the SHARED set** (Ruling 3, nothing invented): `class`
 *     → class, `object` → class, `data`/`sealed`/`value`/`open`/`abstract`/
 *     `annotation` class → class (the modifier lives in the signature),
 *     `interface` → interface, `enum class` → enum, `fun` → function at file
 *     scope and method inside a type body. `typealias`, enum constants,
 *     anonymous-object members and extension functions produce NO symbol: a
 *     typealias has no shared kind that says it honestly, and an extension
 *     (`fun String.sha1()`) is not a member of the class the cascade would
 *     resolve it against, so filing it would be the lie Ruling 3 forbids;
 *     constructors (a primary `class Foo(…)` or a `constructor(…)` clause) and
 *     local functions inside a body are omitted for the same reason: Kotlin
 *     names a constructor after its type and scopes a local fun to nothing the
 *     shared cascade can point at;
 *     `fun interface Speaker { … }` (a SAM declaration) is not filed at v1
 *     either — its header starts with a keyword the modifier reader does not
 *     own, and teaching it that would trade one honest omission for a second
 *     scanning path;
 *   - **`companion object { }` is transparent (documented choice)**: its
 *     functions are filed as methods of the ENCLOSING class (`Repo.load`,
 *     parent `Repo`), because callers write `Repo.load()` and the shared
 *     cascade resolves a member against its owning type, not Kotlin's
 *     innermost receiver. A named companion (`companion object Factory`) is
 *     additionally recorded as a class, but its members still ride upward;
 *   - **qualified names carry the package** for top-level declarations
 *     (`app.store.Repo`), exactly as the C# grammar carries its namespace, so
 *     two same-named classes in two packages stay two distinct rows; members
 *     chain from their owner (`app.store.Repo.load`). `bindings` and `fields`
 *     stay keyed by SIMPLE names, as Java and C# leave them.
 */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const IDENT_SOURCE = "[A-Za-z_][A-Za-z0-9_]*";

/** Kotlin hard keywords — never a declaration name, never a ref candidate. */
const KEYWORDS = new Set([
  "as", "break", "catch", "class", "continue", "do", "else", "false", "finally", "for", "fun",
  "if", "in", "interface", "is", "null", "object", "package", "return", "super", "throw",
  "true", "try", "typealias", "val", "var", "when", "while"
]);

/**
 * Declaration modifiers: visibility, inheritance and the contextual soft
 * keywords that may only ever stand in front of a declaration. They are legal
 * identifiers elsewhere (`data`, `value`, `enum`, `inner`, `out`, `in`), which
 * is why the header reader only consumes them while walking a header, and the
 * ref collector still excludes them as names.
 */
const MODIFIERS = new Set([
  "abstract", "actual", "annotation", "companion", "const", "crossinline", "data", "dynamic",
  "enum", "expect", "external", "final", "in", "infix", "inline", "inner", "lateinit",
  "noinline", "open", "operator", "out", "override", "private", "protected", "public",
  "reified", "sealed", "suspend", "tailrec", "value", "vararg"
]);

/** Stdlib names that are identifier-shaped receivers in most files — never edge candidates (ADR-0050). */
const GLOBALS = new Set([
  "Any", "Boolean", "Byte", "Char", "CharSequence", "Class", "Double", "Enum", "Error",
  "Exception", "Float", "Function", "Int", "Iterable", "List", "Long", "Map", "Nothing",
  "Number", "Pair", "Set", "Short", "String", "StringBuilder", "Throwable", "Triple", "Unit",
  "Array", "BooleanArray", "ByteArray", "CharArray", "DoubleArray", "FloatArray", "IntArray",
  "LongArray", "ShortArray", "ArrayList", "HashMap", "HashSet", "LinkedHashMap", "LinkedHashSet",
  "IllegalArgumentException", "IllegalStateException", "UnsupportedOperationException",
  "arrayOf", "listOf", "mapOf", "setOf", "mutableListOf", "mutableMapOf", "mutableSetOf",
  "listOfNotNull", "emptyList", "emptyMap", "emptySet", "println", "print", "readLine",
  "require", "requireNotNull", "check", "checkNotNull", "error", "TODO", "lazy", "also",
  "apply", "let", "run", "with", "repeat", "maxOf", "minOf", "sumOf", "buildString", "format"
]);

const ANNOTATION_SOURCE = "@[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*(?:\\s*\\((?:[^()]|\\([^()]*\\))*\\))?";
const MOD_SOURCE = `(?:(?:${IDENT_SOURCE}\\s+)|(?:${ANNOTATION_SOURCE}\\s+))*`;

/** `import a.b.C`, `import a.b.*`, `import a.b.C.member`, with the optional `as` alias. */
const IMPORT_SOURCE = `\\bimport\\s+(${IDENT_SOURCE}(?:\\s*\\.\\s*(?:${IDENT_SOURCE}|\\*))*)` +
  `(?:\\s+as\\s+(${IDENT_SOURCE}))?`;

/** `val svc: MemoryService` / `private var x: T? = …` — simple identifier types only. */
const PROPERTY_SOURCE = `^(${MOD_SOURCE})(?:val|var)\\s+(${IDENT_SOURCE})\\s*\\??\\s*` +
  `(?::\\s*(${IDENT_SOURCE})(?![\\w.<])\\s*\\??)?\\s*(?==|;|\\n|$)`;

/** A primary-constructor property: `class Repo(private val db: Db)`. */
const CTOR_PARAM_SOURCE = `(?<![\\w$])(?:val|var)\\s+(${IDENT_SOURCE})\\s*\\??\\s*:\\s*(${IDENT_SOURCE})(?![\\w.<])`;

/** `val db = Db(…)` — Kotlin's stand-in for Java's `x = new T(…)`. */
const NEW_BINDING_SOURCE = `\\b(?:val|var)\\s+(${IDENT_SOURCE})\\s*=\\s*([A-Z][A-Za-z0-9_]*)\\s*\\(`;

// ─────────────────────────────── blanking ───────────────────────────────

/** Index of the bracket matching the opener at `open`, or -1 when unbalanced. */
function matchBracket(text: string, open: number, openCh: string, closeCh: string): number {
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
}

/**
 * Length-preserving blanking (roadmap Phase 2). Comments hide entirely and
 * block comments NEST; a raw string hides its whole body — interpolation
 * included — with every newline kept, keeping only its three+three delimiter
 * quotes; regular strings hide their text but keep their delimiters visible,
 * the same courtesy `go.ts` extends so a statement's extent can still be read
 * from the blanked copy.
 */
function blankKotlin(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < src.length; k++) {
      out[k] = src[k] === "\n" ? "\n" : " ";
    }
  };

  const blankRaw = (open: number): number => {
    // Interior only: the six delimiter quotes stay visible, the same courtesy
    // regular strings and Go raw strings get, because the statement-extent
    // scanner reads the newline that follows the closing `"""` as the end of a
    // `val doc = """…"""` — blank the delimiters and that statement never ends.
    let k = open + 3;
    let closeStart = -1;
    while (k < src.length) {
      if (src[k] === '"') {
        let run = 0;
        let q = k;
        while (q < src.length && src[q] === '"') {
          run++;
          q++;
        }
        if (run >= 3) {
          closeStart = q - 3; // the LAST three of the run close it; extras are content
          k = q;
          break;
        }
        k = q;
        continue;
      }
      k++;
    }
    const to = closeStart === -1 ? src.length : closeStart;
    blank(open + 3, to);
    return closeStart === -1 ? src.length : k;
  };
  /** One regular string: text hides, `${expr}` stays visible as code. */
  const blankString = (open: number): number => {
    let k = open + 1;
    while (k < src.length) {
      const c = src[k]!;
      if (c === "\\") {
        blank(k, Math.min(k + 2, src.length));
        k += 2;
        continue;
      }
      if (c === "\n") return k; // unterminated: Kotlin forbids it — end the literal
      if (c === '"') return k + 1;
      if (c === "$" && /[A-Za-z_]/.test(src[k + 1] ?? "")) {
        // Simple `$name` interpolation: the sigil hides, the interpolated name
        // stays visible — reading it is a reference, so it belongs in `refs`.
        out[k] = " ";
        k++;
        const word = IDENT_RE.exec(src.slice(k));
        if (word) k += word[0].length;
        continue;
      }
      if (c === "$" && src[k + 1] === "{") {
        const close = matchBracket(src, k + 1, "{", "}");
        const to = close === -1 ? src.length : close + 1;
        let j = k + 2;
        while (j < to) {
          const d = src[j]!;
          if (d === '"') {
            j = src[j + 1] === '"' && src[j + 2] === '"' ? blankRaw(j) : blankString(j);
            continue;
          }
          if (d === "\\") {
            blank(j, Math.min(j + 2, src.length));
            j += 2;
            continue;
          }
          j++;
        }
        k = to;
        continue;
      }
      out[k] = " ";
      k++;
    }
    return k;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const nl = src.indexOf("\n", i);
      const to = nl === -1 ? src.length : nl;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === "/" && next === "*") {
      let k = i + 2;
      let nest = 1;
      while (k < src.length && nest > 0) {
        if (src[k] === "/" && src[k + 1] === "*") {
          nest++;
          k += 2;
          continue;
        }
        if (src[k] === "*" && src[k + 1] === "/") {
          nest--;
          k += 2;
          continue;
        }
        k++;
      }
      const to = nest === 0 ? k : src.length;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === '"') {
      if (next === '"' && src[i + 2] === '"') {
        i = blankRaw(i);
        continue;
      }
      i = blankString(i);
      continue;
    }
    if (c === "'") {
      // Char literal ('a', '\n', '"'): one escaped char, or one plain char.
      let k = i + 1;
      while (k < src.length && (src[k] === " " || src[k] === "\t")) k++;
      if (src[k] === "\\") k += 2;
      else if (src[k]) k++;
      let q = k;
      while (q < src.length && (src[q] === " " || src[q] === "\t")) q++;
      if (src[q] === "'") {
        blank(i, q + 1);
        i = q + 1;
        continue;
      }
      out[i] = " ";
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

// ─────────────────────────── header reading ───────────────────────────

/** `<` at `open` and its `>`; `->` is an arrow, never a close. */
function matchAngle(text: string, open: number): number {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    const c = text[k]!;
    if (c === "<") depth++;
    else if (c === "-" && text[k + 1] === ">") {
      k++;
      continue;
    } else if (c === ">") {
      depth--;
      if (depth === 0) return k;
    } else if (c === ";" || c === "\n" || c === "}" || c === ")") return -1;
  }
  return -1;
}

/** Skip spaces/tabs/CR from `from`, clamped at `limit`. */
function skipWs(text: string, from: number, limit: number): number {
  let k = from;
  while (k < limit && (text[k] === " " || text[k] === "\t" || text[k] === "\r")) k++;
  return k;
}

/** Skip every kind of whitespace, newlines included. */
function skipAll(text: string, from: number): number {
  let k = from;
  while (k < text.length && /\s/.test(text[k]!)) k++;
  return k;
}

/** Identifier starting at `at` (bounded by `limit`), or null. */
function identAt(text: string, at: number, limit: number): { name: string; end: number } | null {
  const m = IDENT_RE.exec(text.slice(at, limit));
  return m ? { name: m[0], end: at + m[0].length } : null;
}

/**
 * A dotted name (`x.y.Z`) starting at `at`, spaces around the dots collapsed —
 * the blanked copy is what this reads, so comments and strings cannot plant a
 * segment. Returns null when the shape is not a plain dotted name.
 */
function dottedAt(text: string, at: number, limit: number): { name: string; end: number } | null {
  let k = skipWs(text, at, limit);
  const first = identAt(text, k, limit);
  if (!first) return null;
  const parts = [first.name];
  k = first.end;
  for (;;) {
    const dot = skipWs(text, k, limit);
    if (text[dot] !== "." || dot >= limit) break;
    const seg = identAt(text, skipWs(text, dot + 1, limit), limit);
    if (!seg) break;
    parts.push(seg.name);
    k = seg.end;
  }
  return { name: parts.join("."), end: k };
}

/**
 * The modifier words and annotations in front of a declaration, bounded by
 * `limit` so a header can never walk into the following statement.
 */
function readModifiers(text: string, at: number, limit: number): { mods: string[]; next: number } {
  const mods: string[] = [];
  let k = skipWs(text, at, limit);
  for (;;) {
    if (text[k] === "@") {
      const name = dottedAt(text, k + 1, limit);
      if (!name) break;
      let p = skipWs(text, name.end, limit);
      if (text[p] === "(") {
        const close = matchBracket(text, p, "(", ")");
        if (close === -1 || close > limit) break;
        p = close + 1;
      }
      k = skipWs(text, p, limit);
      continue;
    }
    const word = identAt(text, k, limit);
    if (!word || !MODIFIERS.has(word.name)) break;
    mods.push(word.name);
    k = skipWs(text, word.end, limit);
  }
  return { mods, next: k };
}

/**
 * A regular string keeps its `${expr}` visible as code, so the extent scans
 * must not read that brace as a body: `interpClose` returns the `}` that ends
 * the block whose `${` starts at `open` (nesting-aware, so a lambda inside the
 * interpolation is part of it), or -1 when the block never closes.
 */
function interpClose(text: string, open: number): number {
  if (text[open] !== "$" || text[open + 1] !== "{") return -1;
  const close = matchBracket(text, open + 1, "{", "}");
  return close === -1 ? -1 : close;
}

/**
 * End of a declaration statement: the first newline or `;` at bracket-depth
 * zero whose previous significant character is not a continuation (`=`, `,`,
 * an operator, a dot), so a signature or an initializer wrapped over lines
 * stays one statement. A nullable type's `?` and a `!!` assertion are NOT
 * continuations — in Kotlin a line ending in them ends the statement, and
 * treating them as wraps would let a declaration eat its owner's closing brace.
 * Braces count toward the depth, which is what lets the caller bound a
 * body-brace search by the statement's extent.
 */
function stmtDepth(text: string, from: number): number {
  let depth = 0;
  let lastSig = "";
  for (let k = from; k < text.length; k++) {
    const c = text[k]!;
    if (c === "$" && text[k + 1] === "{") {
      const close = interpClose(text, k);
      if (close !== -1) k = close;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      lastSig = c;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      lastSig = c;
      continue;
    }
    if (depth <= 0) {
      if (c === ";") return k;
      // `?:` and `foo.` wrap on the colon and the dot; `!=` wraps on the `=`;
      // a nullable type (`String?`) and a `!!` assertion END the statement.
      if (c === "\n" && !"+-*/%=<>:&|,.".includes(lastSig)) return k;
    }
    if (!/\s/.test(c)) lastSig = c;
  }
  return text.length;
}

/** First `{` at bracket-depth zero inside `[from, to)` — the declaration's body brace. */
function bodyBraceWithin(text: string, from: number, to: number): number {
  let depth = 0;
  for (let k = from; k < to; k++) {
    const c = text[k]!;
    if (c === "$" && text[k + 1] === "{") {
      // String interpolation is not a body brace, however Kotlin reads it.
      const close = interpClose(text, k);
      if (close !== -1 && close < to) k = close;
      continue;
    }
    if (c === "(" || c === "[") {
      depth++;
      continue;
    }
    if (c === ")" || c === "]") {
      depth--;
      continue;
    }
    if (c === ";") return -1;
    if (c === "}") {
      // The enclosing construct closed before this header found a brace: a
      // bodyless declaration (`interface I { fun greet(name: String): String }`)
      // ends here rather than borrowing the NEXT declaration's body.
      if (depth === 0) return -1;
      depth--;
      continue;
    }
    if (c === "{") {
      if (depth === 0) return k;
      depth++;
      continue;
    }
  }
  return -1;
}

/**
 * The `}` inside `[from, to)` that closes the ENCLOSING frame — the first one
 * the scanner meets while still at bracket-depth zero. A one-line body
 * (`interface A { fun x(): Int }`) puts that brace inside a member header's own
 * statement extent, and the walker must not leap over it: skipping it
 * desynchronises the depth and frame stack, and the next top-level declaration
 * is filed as a member of a class that closed lines ago.
 */
function frameCloseWithin(text: string, from: number, to: number): number {
  let depth = 0;
  for (let k = from; k < to; k++) {
    const c = text[k]!;
    if (c === "$" && text[k + 1] === "{") {
      const close = interpClose(text, k);
      if (close !== -1 && close < to) k = close;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      if (c === "}" && depth === 0) return k;
      depth--;
      continue;
    }
    if (c === ";" && depth <= 0) return -1;
  }
  return -1;
}

/** Signature text for a declaration, read from the ORIGINAL source. */
function signatureOf(src: string, from: number, to: number): string {
  return src
    .slice(from, Math.max(from, to))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Kotlin's default visibility is public; `private`/`internal`/`protected` are not. */
function isExported(mods: string[]): boolean {
  return !mods.includes("private") && !mods.includes("internal") && !mods.includes("protected");
}

/**
 * The name filter for refs, bindings and fields. Deliberately NARROWER than
 * `MODIFIERS`, which the header reader needs whole: Kotlin's soft modifiers are
 * ordinary identifiers in real code (`data`, `value`, `enum`, `inner`), and
 * filtering them out of `refs` would drop the references the cascade exists to
 * find. Hard keywords never name a reference; the stdlib set never names a call.
 */
/**
 * Modifier words that name a declaration but never a value: visibility,
 * inheritance and function qualifiers. A structural scan reads the whole
 * declaration extent (header included, exactly as `java.ts` does), and these
 * words sit in headers constantly, so without this list every `override fun`
 * and every `inline fun` would carry them as refs.
 */
const MODIFIER_NOISE = new Set([
  "abstract", "actual", "annotation", "companion", "const", "crossinline", "dynamic", "expect",
  "external", "final", "infix", "inline", "lateinit", "noinline", "operator", "override",
  "private", "protected", "public", "internal", "reified", "sealed", "suspend", "tailrec",
  "vararg", "virtual"
]);

/**
 * The filter for refs and member-call names, and why it is its own set:
 * Kotlin's soft modifiers (`data`, `value`, `enum`, `inner`) are ordinary
 * identifiers in real code, so filtering them the way the Java and C#
 * grammars filter their keywords would drop the references the cascade exists
 * to find. `it` is the exception worth making — Kotlin's implicit lambda
 * parameter, whose type no structural scan can know, so it can never become an
 * edge and only adds noise.
 */
const NOT_A_REF = new Set([...KEYWORDS, ...GLOBALS, ...MODIFIER_NOISE, "it"]);

/**
 * Identifiers referenced in one declaration's extent. Positions are validated
 * against the blanked copy, so comments, raw strings and string bodies plant
 * nothing, while `${expr}` inside a regular string — left visible as code —
 * does contribute. Identifiers after `.` are skipped: those pairs are member
 * calls, not bare names (ADR-0050).
 */
function collectRefs(src: string, blanked: string, from: number, to: number, self: string): string[] {
  const refs = new Set<string>();
  const slice = src.slice(from, Math.max(from, to));
  const blank = blanked.slice(from, Math.max(from, to));
  const re = new RegExp(`(?<=^|[^.\\w])(${IDENT_SOURCE})`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice))) {
    const name = m[1]!;
    if (NOT_A_REF.has(name) || name === self || name.length < 2) continue;
    const at = blank[m.index];
    if (at === " " || at === "\n" || at === "\t" || at === "\r") continue; // hidden — prose, not code
    refs.add(name);
  }
  return [...refs];
}

/**
 * `<receiver>.<method>(` and `recv.field.method(` pairs inside one extent,
 * safe-call `?.` chains included — the raw material that lets the sync resolve
 * service-layer methods through `bindings` (ADR-0050).
 */
function collectMemberCalls(src: string, blanked: string, from: number, to: number): ParsedMemberCall[] {
  const calls = new Map<string, ParsedMemberCall>();
  const slice = src.slice(from, Math.max(from, to));
  const blank = blanked.slice(from, Math.max(from, to));
  const visible = (index: number): boolean => {
    if (index < 0 || index >= blank.length) return false;
    const c = blank[index]!;
    return c !== " " && c !== "\n" && c !== "\r" && c !== "\t";
  };
  const clean = (name: string): boolean => !NOT_A_REF.has(name);
  let m: RegExpExecArray | null;
  const oneRe = new RegExp(`(?<=^|[^.\\w])(${IDENT_SOURCE})\\s*\\??\\.\\s*(${IDENT_SOURCE})\\s*\\(`, "g");
  while ((m = oneRe.exec(slice))) {
    if (!visible(m.index)) continue;
    const receiver = m[1]!;
    const method = m[2]!;
    if (receiver !== "this" && !clean(receiver)) continue;
    if (!clean(method)) continue;
    calls.set(`${receiver}.${method}`, { receiver, method });
  }
  const twoRe = new RegExp(
    `(?<=^|[^.\\w])(${IDENT_SOURCE})\\s*\\??\\.\\s*(${IDENT_SOURCE})\\s*\\??\\.\\s*(${IDENT_SOURCE})\\s*\\(`,
    "g"
  );
  while ((m = twoRe.exec(slice))) {
    if (!visible(m.index)) continue;
    const receiver = m[1]!;
    const field = m[2]!;
    const method = m[3]!;
    if (receiver !== "this" && !clean(receiver)) continue;
    if (!clean(field) || !clean(method)) continue;
    calls.set(`${receiver}.${field}.${method}`, { receiver, method, via: field });
  }
  return [...calls.values()];
}

// ─────────────────────────────── parsing ───────────────────────────────

/**
 * One brace frame of the walker. `owner` is the symbol whose body closes here;
 * `memberSym` is the type members are filed on — the class itself for a type
 * body, the enclosing class for a `companion object`, null inside a function
 * body or a plain block, where nothing is a member.
 */
interface Frame {
  owner: ParsedSymbol | null;
  memberSym: ParsedSymbol | null;
  isType: boolean;
  bodyDepth: number;
}

interface Pending {
  sym: ParsedSymbol;
  /** Depth at which the declaration was seen; its body brace must arrive here. */
  declDepth: number;
  opened: boolean;
  isType: boolean;
  memberSym: ParsedSymbol | null;
}

/** Where the walker currently is: file scope, a type body, or some other body. */
type Scope = "top" | "type" | "body";

/**
 * Parse one Kotlin file into the shared shapes (roadmap Phase 2). `blanked` is
 * sync's precomputed `blank(src)`; signatures and binding types are read from
 * `src` at the same offsets, the established pattern (ADR-0050). Never throws
 * for parseable-looking code — a structural surprise surfaces as `parseError`.
 */
function parseKotlin(src: string, blanked: string): ParsedFile {
  try {
    const text = blanked;
    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    const bindings: Record<string, string> = {};
    const fields: Record<string, Record<string, string>> = {};

    const bind = (name: string, type: string): void => {
      if (!name || !type) return;
      // Filters, and why they differ per position: a soft-modifier word is a
      // LEGAL name (`val value: Int`), so only hard keywords are rejected
      // there; as a TYPE it would be prose, so the type position keeps the
      // wider filter — but stdlib type names (`Int`, `String`) are honest
      // types and must NOT be dropped, which is why the ref filter and the
      // type filter are not the same set.
      if (KEYWORDS.has(name) || KEYWORDS.has(type) || MODIFIERS.has(type)) return;
      bindings[name] = type;
    };
    const addField = (owner: string, fieldName: string, type: string): void => {
      if (!owner || !fieldName || !type) return;
      if (KEYWORDS.has(fieldName) || KEYWORDS.has(type) || MODIFIERS.has(type)) return;
      (fields[owner] ??= {})[fieldName] = type;
    };

    /**
     * True when `index` opens a line (only spaces/tabs/CR stand before it).
     * Clauses are anchored here instead of searched anywhere, because a
     * regular string deliberately keeps its interpolated names and its
     * `${expr}` blocks visible as code: text like `"$package x.y"` would
     * otherwise plant a package clause or an import that Kotlin never had. A
     * clause is a statement, and in Kotlin a statement starts a line.
     */
    const opensLine = (index: number): boolean => {
      let j = index - 1;
      while (j >= 0 && (text[j] === " " || text[j] === "\t" || text[j] === "\r")) j--;
      return j < 0 || text[j] === "\n";
    };

    // Package clause: walker state, never a symbol (Java ships the same rule —
    // the module row already derives from the file path, and a `package`
    // pseudo-symbol would duplicate it). It is the prefix every top-level
    // qualified name carries, which is what keeps two same-named classes in two
    // packages two distinct rows. Read from the blanked copy, so a comment or a
    // raw string mentioning the word cannot set it.
    let pkg = "";
    const pkgRe = /\bpackage\s+/g;
    let pm: RegExpExecArray | null;
    while ((pm = pkgRe.exec(text))) {
      if (!opensLine(pm.index)) continue;
      const dotted = dottedAt(text, pm.index + pm[0].length, text.length);
      if (dotted) {
        pkg = dotted.name;
        break;
      }
    }
    const qualify = (name: string, parent: string | null): string =>
      parent ? `${parent}.${name}` : pkg ? `${pkg}.${name}` : name;

    // Imports: a statement scan on the blanked text (comments, strings and raw
    // strings cannot plant one). `spec` stays as written — package-absolute,
    // wildcard included — and `names` carries what the file can actually use:
    // the type for a class import, the member for a member import, "*" for a
    // wildcard, plus the alias when `as` renames the binding.
    const pushImport = (imp: ParsedImport): void => {
      const dup = imports.find(
        (q) => q.spec === imp.spec && q.names.length === imp.names.length && q.names.every((n, idx) => n === imp.names[idx])
      );
      if (dup) return;
      imports.push(imp);
    };
    const importRe = new RegExp(IMPORT_SOURCE, "g");
    let im: RegExpExecArray | null;
    while ((im = importRe.exec(text))) {
      if (!opensLine(im.index)) continue;
      const raw = im[1]!.replace(/\s+/g, "");
      if (!new RegExp(`^${IDENT_SOURCE}(?:\\.(?:${IDENT_SOURCE}|\\*))*$`).test(raw)) continue;
      const alias = im[2];
      const segments = raw.split(".");
      const wildcard = segments.at(-1) === "*";
      const real = wildcard ? segments.slice(0, -1) : segments;
      if (real.length === 0) continue;
      const names: string[] = [];
      if (wildcard) names.push("*");
      else if (real.length >= 2) names.push(real.at(-1)!);
      if (alias && !names.includes(alias)) names.push(alias);
      if (names.length === 0) continue;
      pushImport({ spec: raw, names, namespace: null, defaultName: null, sideEffect: false, isExport: false });
    }

    const stack: Frame[] = [];
    const pending: Pending[] = [];
    let depth = 0;
    let parenDepth = 0;
    let line = 1;
    let i = 0;
    let annoJustEnded = false;

    // Jump helper: every branch that leaps `i` forward must carry the newline
    // count with it, or every lineStart after a multi-line signature drifts.
    const advance = (to: number): void => {
      for (let k = i; k < to && k < text.length; k++) if (text[k] === "\n") line++;
      i = Math.min(Math.max(to, i), text.length);
    };
    const lineOf = (index: number): number => {
      let l = line;
      for (let k = i; k < index && k < text.length; k++) if (text[k] === "\n") l++;
      for (let k = index; k < i && k >= 0; k--) if (text[k] === "\n") l--;
      return l;
    };

    const memberSym = (): ParsedSymbol | null => {
      const top = stack.at(-1);
      return top && top.memberSym && depth === top.bodyDepth ? top.memberSym : null;
    };

    const scope = (): Scope => {
      if (depth === 0 && stack.length === 0) return "top";
      const owner = memberSym();
      if (owner) return "type";
      return "body";
    };
    // Kotlin is newline-sensitive: a statement ends at its newline, so an
    // identifier that opens a line is at a statement start — that is what makes
    // `fun a()` / `fun b()` on consecutive lines two declarations. Only spaces
    // and tabs are skipped looking back; a continuation (`=`, `,`, an operator,
    // a dot, an open paren) means the word is mid-expression, not mid-file.
    const atStatementStart = (): boolean => {
      if (annoJustEnded) return true;
      let j = i - 1;
      while (j >= 0 && (text[j] === " " || text[j] === "\t" || text[j] === "\r")) j--;
      if (j < 0) return true;
      const prev = text[j]!;
      if (prev === "\n" || prev === ";" || prev === "{" || prev === "}") return true;
      if (prev === "@" || prev === ":") return true;
      return false;
    };

    const closePending = (): void => {
      for (let p = pending.length - 1; p >= 0; p--) {
        const pd = pending[p]!;
        if (pd.declDepth >= depth) {
          if (pd.sym.lineEnd === null) pd.sym.lineEnd = line;
          pending.splice(p, 1);
        }
      }
    };

    /**
     * One declaration at `declStart`, filed on `parent` (null at file scope).
     * Headers are read structurally — modifiers, annotation, keyword, optional
     * generic list, optional extension receiver, name, parameter parens, then a
     * body brace, an expression body, or nothing — which is what keeps a
     * signature wrapped over four lines one header with zero drift.
     */
    const tryDeclaration = (declStart: number, parent: ParsedSymbol | null, current: Scope): boolean => {
      // A one-line enclosing body (`interface A { fun x(): Int }`) closes
      // inside this member's own statement extent; cap the scan there so the
      // walker never leaps that `}` and desynchronises the frame stack.
      let stmtTo = stmtDepth(text, declStart);
      const closer = frameCloseWithin(text, declStart, stmtTo);
      if (closer !== -1) stmtTo = closer;
      let brace = bodyBraceWithin(text, declStart, stmtTo);
      // K&R-optional braces: a body brace may also sit on the line after a
      // header that ended in an identifier (`class Foo` / `{`). Only that one
      // shape is allowed, so a following block never masquerades as a body.
      if (brace === -1) {
        const after = skipAll(text, stmtTo);
        if (text[after] === "{" && text[stmtTo] !== ";" && /[A-Za-z0-9_)]/.test(text[stmtTo - 1] ?? "")) brace = after;
      }
      const bound = brace === -1 ? stmtTo : brace;
      const { mods, next } = readModifiers(text, declStart, bound);
      const keyword = identAt(text, skipWs(text, next, bound), bound);
      if (!keyword) return false;

      // Clause and form the scanner deliberately does not file: package and
      // import statements (collected above), and `typealias`, which has no
      // shared kind that would say it honestly (Ruling 3). Skipping the
      // statement is the point — the name must not be read as a member of
      // whatever type happens to be open.
      if (keyword.name === "package" || keyword.name === "import" || keyword.name === "typealias") {
        if (keyword.name === "package" || keyword.name === "import") {
          const semi = text.indexOf(";", declStart);
          const dotted = dottedAt(text, keyword.end, text.length);
          advance(dotted && dotted.end > declStart ? dotted.end : Math.max(declStart + keyword.name.length, semi + 1));
        } else {
          advance(stmtTo);
        }
        return true;
      }

      if (keyword.name === "class" || keyword.name === "interface" || keyword.name === "object") {
        const isCompanion = mods.includes("companion");
        if (isCompanion && keyword.name !== "object") return false;
        const named = identAt(text, skipWs(text, keyword.end, bound), bound);
        const hasName = named && !KEYWORDS.has(named.name) && !MODIFIERS.has(named.name) && !["object", "class", "interface"].includes(named.name);
        if (!hasName) {
          if (keyword.name === "object" && isCompanion && parent && brace !== -1) {
            // `companion object { }`: transparent — recorded nowhere, its
            // members ride upward to the enclosing class (documented choice).
            const transparent: ParsedSymbol = {
              name: "",
              kind: "class",
              qualifiedName: "",
              signature: "",
              lineStart: line,
              lineEnd: null,
              exported: false,
              parent: parent.qualifiedName,
              refs: [],
              memberCalls: []
            };
            pending.push({ sym: transparent, declDepth: depth, opened: false, isType: false, memberSym: parent });
            advance(brace);
            return true;
          }
          return false; // anonymous `object : Foo { … }` — no name, no symbol
        }
        let p = skipWs(text, named!.end, bound);
        if (text[p] === "<") {
          const close = matchAngle(text, p);
          if (close === -1) return false;
          p = skipWs(text, close + 1, bound);
        }
        const kind: ParsedSymbol["kind"] =
          keyword.name === "interface" ? "interface" : mods.includes("enum") ? "enum" : "class";
        const sym: ParsedSymbol = {
          name: named!.name,
          kind,
          qualifiedName: qualify(named!.name, parent?.qualifiedName ?? null),
          signature: signatureOf(src, declStart, brace === -1 ? bound : brace),
          lineStart: line,
          lineEnd: null,
          exported: isCompanion ? false : isExported(mods),
          parent: parent?.qualifiedName ?? null,
          refs: [],
          memberCalls: []
        };
        symbols.push(sym);
        // Constructor properties exist whether or not the class has a body:
        // `data class Row(val id: Int, val name: String)` binds just the same.
        collectConstructorFields(text, named!.name, named!.end, brace === -1 ? bound : brace, bind, addField);
        if (brace === -1) {
          sym.lineEnd = lineOf(bound);
          advance(bound);
          return true;
        }
        // A named companion is recorded as its own class, but its members ride
        // upward to the enclosing type — the documented companion choice.
        pending.push({ sym, declDepth: depth, opened: false, isType: true, memberSym: isCompanion ? parent : sym });
        advance(brace);
        return true;
      }

      if (keyword.name === "fun") {
        if (current === "body") return false; // local functions are not filed
        let p = skipWs(text, keyword.end, bound);
        if (text[p] === "<") {
          const close = matchAngle(text, p);
          if (close === -1) return false;
          p = skipWs(text, close + 1, bound);
        }
        const first = identAt(text, p, bound);
        if (!first || (KEYWORDS.has(first.name) && !mods.includes("operator"))) return false;
        const dot = skipWs(text, first.end, bound);
        if (text[dot] === ".") {
          // Extension function (`fun String.sha1()`): no symbol (see header).
          const second = identAt(text, skipWs(text, dot + 1, bound), bound);
          if (!second) return false;
          const paren = skipWs(text, second.end, bound);
          if (text[paren] !== "(") return false;
          advance(brace === -1 ? stmtTo : brace);
          return true;
        }
        const paren = skipWs(text, first.end, bound);
        if (text[paren] !== "(") return false;
        if (matchBracket(text, paren, "(", ")") === -1) return false;
        // Members of a type are not importable names; the shared shapes say so
        // through `exported: false`, exactly as the Java and C# grammars do.
        const isMember = current === "type" && parent !== null;
        const sym: ParsedSymbol = {
          name: first.name,
          kind: isMember ? "method" : "function",
          qualifiedName: qualify(first.name, isMember ? parent!.qualifiedName : null),
          signature: signatureOf(src, declStart, brace === -1 ? bound : brace),
          lineStart: line,
          lineEnd: null,
          exported: isMember ? false : isExported(mods),
          parent: isMember ? parent!.qualifiedName : null,
          refs: [],
          memberCalls: []
        };
        symbols.push(sym);
        if (brace === -1) {
          sym.lineEnd = lineOf(stmtTo);
          advance(stmtTo);
          return true;
        }
        pending.push({ sym, declDepth: depth, opened: false, isType: false, memberSym: null });
        advance(brace);
        return true;
      }

      if (keyword.name === "val" || keyword.name === "var") {
        // `val svc: MemoryService` / `var x: T? = …`: the type position is
        // structural, so it binds. Only a simple identifier type (no generic,
        // no qualified name, no compound type) is honest — ADR-0050's rule, and
        // Kotlin's own type inference would be needed for anything richer.
        const m = new RegExp(PROPERTY_SOURCE, "s").exec(text.slice(declStart, bound));
        if (!m) {
          advance(brace === -1 ? stmtTo : brace);
          return true;
        }
        const propName = m[2]!;
        const propType = m[3];
        if (propType) {
          bind(propName, propType);
          if (parent) addField(parent.name, propName, propType);
        }
        advance(brace === -1 ? stmtTo : brace);
        return true;
      }

      return false;
    };

    while (i < text.length) {
      const c = text[i]!;
      const ws = c === " " || c === "\t" || c === "\r" || c === "\n";
      // `annoJustEnded` survives the spaces after an annotation — `@JvmStatic
      // fun load()` and `@JvmStatic fun load()` are both one declaration — and
      // every branch below that consumes a token clears it.
      if (c === "\n") {
        line++;
        i++;
        continue;
      }
      if (ws) {
        i++;
        continue;
      }
      if (c === "(" || c === "[") {
        parenDepth++;
        annoJustEnded = false;
        i++;
        continue;
      }
      if (c === "$" && text[i + 1] === "{") {
        // A visible `${expr}` block is string content, not a body brace: hop
        // the whole block so its braces never enter or leave a frame. An
        // unterminated block simply yields the `${` and walks on.
        const close = interpClose(text, i);
        if (close === -1) {
          i += 2;
          continue;
        }
        advance(close + 1);
        continue;
      }
      if (c === ")" || c === "]") {
        parenDepth = Math.max(0, parenDepth - 1);
        annoJustEnded = false;
        i++;
        continue;
      }
      if (c === "{") {
        annoJustEnded = false;
        // A brace inside a parameter list is a lambda default, never a body:
        // only parenDepth-zero braces may claim a pending declaration.
        const claimable = parenDepth === 0;
        const claimant = claimable ? pending.find((pd) => !pd.opened && pd.declDepth === depth) : undefined;
        if (claimant) {
          claimant.opened = true;
          stack.push({
            owner: claimant.sym,
            memberSym: claimant.memberSym,
            isType: claimant.isType,
            bodyDepth: depth + 1
          });
        } else {
          stack.push({ owner: null, memberSym: null, isType: false, bodyDepth: depth + 1 });
        }
        depth++;
        i++;
        continue;
      }
      if (c === "}") {
        annoJustEnded = false;
        const frame = stack.pop();
        depth = Math.max(0, depth - 1);
        if (frame?.owner && frame.owner.name && frame.owner.lineEnd === null) frame.owner.lineEnd = line;
        closePending();
        i++;
        continue;
      }
      if (c === ";") {
        annoJustEnded = true;
        i++;
        continue;
      }
      if (c === "@" && !new RegExp(`^\\s*interface(?![\\w])`).test(text.slice(i + 1, i + 60))) {
        // An annotation (Java's `@interface` aside): hop its dotted name and
        // its argument list so neither changes the frame stack.
        const name = dottedAt(text, i + 1, text.length);
        if (!name) {
          i++;
          continue;
        }
        let k = skipWs(text, name.end, text.length);
        if (text[k] === "(") {
          const close = matchBracket(text, k, "(", ")");
          if (close !== -1) k = close + 1;
        }
        advance(k);
        annoJustEnded = true;
        continue;
      }
      if (c === "'") {
        annoJustEnded = false;
        // Char literal: its delimiters survived blanking, so hop over it.
        let k = i + 1;
        if (text[k] === "\\") k += 2;
        else if (text[k]) k++;
        if (text[k] === "'") {
          advance(k + 1);
          continue;
        }
        i++;
        continue;
      }
      if (c === ":" && text[i + 1] !== ":") {
        annoJustEnded = false;
        // A header's `: Type` — hop the name so a supertype is never read as a
        // declaration of its own.
        const after = skipWs(text, i + 1, text.length);
        const hop = dottedAt(text, after, text.length);
        if (hop && hop.end > i) {
          advance(hop.end);
          continue;
        }
        i++;
        continue;
      }

      const word = identAt(text, i, text.length);
      if (word) {
        annoJustEnded = false;
        const current = scope();
        const parent = current === "type" ? memberSym() : null;
        const start = i;
        if (atStatementStart() && (current === "top" || current === "type" || word.name === "val" || word.name === "var")) {
          if (tryDeclaration(i, parent, current)) {
            if (i === start) advance(start + 1);
            continue;
          }
        }
        const handled =
          atStatementStart() &&
          (current === "top" || current === "type" || word.name === "val" || word.name === "var") &&
          tryDeclaration(i, parent, current);
        if (!handled) advance(word.end);
        if (i === start) advance(start + 1);
        continue;
      }
      i++;
      annoJustEnded = false;
    }

    // `val db = Db(…)`: Kotlin's stand-in for Java's `x = new T(…)` — the shape
    // is unambiguous, so it binds without any scope model. Read from the
    // blanked copy, so a comment or string can never plant a binding.
    const newRe = new RegExp(NEW_BINDING_SOURCE, "g");
    let nm: RegExpExecArray | null;
    while ((nm = newRe.exec(text))) bind(nm[1]!, nm[2]!);

    // Body refs and member calls: a function's extent runs from its header line
    // to the line its body closed on (end of file when a body never closed).
    const lineStarts: number[] = [0];
    for (let k = 0; k < text.length; k++) if (text[k] === "\n") lineStarts.push(k + 1);
    const offsetOfLine = (l: number): number => lineStarts[Math.min(Math.max(l - 1, 0), lineStarts.length - 1)] ?? 0;
    for (const sym of symbols) {
      if (sym.kind !== "function" && sym.kind !== "method") continue;
      const from = offsetOfLine(sym.lineStart);
      const to = sym.lineEnd === null ? text.length : offsetOfLine(sym.lineEnd + 1);
      sym.refs = collectRefs(src, blanked, from, to, sym.name);
      sym.memberCalls = collectMemberCalls(src, blanked, from, to);
    }

    // `bindings` is the type-position map above (properties and constructor
    // properties); `moduleRefs`/`moduleMemberCalls` stay empty by design —
    // Kotlin file scope holds declarations, not the test-harness callback
    // bodies the TS scanner harvests — and `reExports` is empty because the
    // language has no re-export form.
    return { symbols, imports, reExports: [], bindings, moduleRefs: [], moduleMemberCalls: [], fields };
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
 * `val`/`var` parameters of a primary constructor are the type's properties —
 * Kotlin's most common binding shape (`class Repo(private val db: Db)`) and the
 * simplest to read honestly, so each lands in `fields` (keyed by the simple
 * type name) and in `bindings`. The scan is bounded by the parameter list and
 * takes simple identifier types only; generics and qualified types bind nothing
 * (ADR-0050's rule).
 */
function collectConstructorFields(
  text: string,
  owner: string,
  from: number,
  to: number,
  bind: (name: string, type: string) => void,
  addField: (owner: string, name: string, type: string) => void
): void {
  const open = text.indexOf("(", from);
  if (open === -1 || open >= to) return;
  const close = matchBracket(text, open, "(", ")");
  if (close === -1 || close > to) return;
  const inner = text.slice(open + 1, close);
  const re = new RegExp(CTOR_PARAM_SOURCE, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    const name = m[1]!;
    const type = m[2]!;
    if (KEYWORDS.has(name) || KEYWORDS.has(type) || MODIFIERS.has(type)) continue;
    bind(name, type);
    addField(owner, name, type);
  }
}

// ─────────────────────────────── resolution ───────────────────────────────

/**
 * Kotlin packages map to directories: `x.y.Util` lives at `x/y/Util.kt`
 * relative to the repo root — the purely lexical rule Java ships, so `fromFile`
 * plays no part (specs are package-absolute; the exception, a relative import
 * written against the importing file's own package, cannot be recognised from
 * the spec alone and simply lands nowhere, falling through to the default
 * machinery, which builds nothing for it).
 *
 * The three shapes, told apart by Kotlin's own convention that packages start
 * lowercase and types start uppercase:
 *   - `x.y.Util`        → `x/y/Util.kt`;
 *   - `x.y.*`           → the directory prefix `x/y/` (types.ts: a candidate
 *                         ending in "/" is a prefix, so one wildcard can claim
 *                         every file in the package);
 *   - `x.y.Util.member` → `x/y/Util.kt` (a member import lands on the file of
 *                         the declaring type).
 * A spec whose last segment is lowercase has no type in it: it names a
 * top-level function or property, whose declaring FILE Kotlin does not encode
 * in the name (a package may spread its top-level members over arbitrarily
 * named files), so the candidate is the package's directory prefix — the right
 * package, first file in sorted order, and the sync's own name lookup decides
 * whether the symbol lives there. A single segment is no package at all —
 * Kotlin specs are package-absolute, so an unqualified name (and any source
 * root like `src/main/kotlin/…`) is never guessed: null falls through to the
 * default machinery untouched.
 */
function resolveKotlinImport(spec: string, _fromFile: string, _ctx: { repoRoot: string }): string[] | null {
  const raw = spec.trim();
  if (!new RegExp(`^${IDENT_SOURCE}(?:\\s*\\.\\s*(?:${IDENT_SOURCE}|\\*))*$`).test(raw)) return null;
  const segments = raw.replace(/\s+/g, "").split(".");
  const wildcard = segments.at(-1) === "*";
  const real = wildcard ? segments.slice(0, -1) : segments;
  if (real.length < 2) return null;
  let typeIndex = -1;
  for (let k = real.length - 1; k >= 0; k--) {
    if (/^[A-Z]/.test(real[k]!)) {
      typeIndex = k;
      break;
    }
  }
  if (wildcard) return [`${real.join("/")}/`];
  if (typeIndex !== -1) return [`${real.slice(0, typeIndex + 1).join("/")}.kt`];
  if (real.length >= 2) return [`${real.slice(0, -1).join("/")}/`];
  return null;
}

export const kotlinGrammar: LanguageGrammar = {
  id: "kotlin",
  label: "Kotlin",
  extensions: [".kt"],
  blank: blankKotlin,
  parse: parseKotlin,
  resolveImport: resolveKotlinImport
};
