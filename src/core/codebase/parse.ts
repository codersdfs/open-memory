import type { ParsedFile, ParsedImport, ParsedMemberCall, ParsedSymbol } from "./languages/types.js";

export type { ParsedFile, ParsedImport, ParsedMemberCall, ParsedSymbol } from "./languages/types.js";

/**
 * The zero-dependency TS/JS parser (ADR-0050).
 *
 * One pass blanks comments and string literals (same length, offsets stay valid),
 * a second finds declarations and tracks brace depth for bodies and end lines.
 * This is structural scanning, not a grammar: it extracts what an agent needs to
 * navigate a repository — exported symbols, classes with their methods, imports —
 * and it says so through the `name-match` evidence on every heuristic edge.
 *
 * The parsed shapes it fills (roadmap Phase 2) are the grammar registry's
 * contract and live in `languages/types.ts`; they are re-exported here so
 * every existing importer keeps working unchanged.
 */

const IDENT = "[A-Za-z_$][\\w$]*";

const KEYWORDS = new Set([
  "abstract", "any", "as", "assert", "async", "await", "boolean", "break", "case", "catch", "class",
  "const", "constructor", "continue", "debugger", "declare", "default", "delete", "do", "else", "enum",
  "export", "extends", "false", "finally", "for", "from", "function", "get", "if", "implements", "import",
  "in", "infer", "instanceof", "interface", "is", "keyof", "let", "namespace", "never", "new", "null",
  "number", "object", "of", "override", "package", "private", "protected", "public", "readonly", "return",
  "satisfies", "set", "static", "string", "super", "switch", "symbol", "this", "throw", "true", "try",
  "type", "typeof", "undefined", "union", "unique", "unknown", "var", "void", "while", "with", "yield"
]);

/** Names every file can reference without importing — never call-edge candidates. */
const GLOBALS = new Set([
  "Array", "Boolean", "Buffer", "console", "Date", "Error", "globalThis", "Infinity", "JSON", "Map",
  "Math", "NaN", "Number", "Object", "Promise", "RegExp", "Set", "String", "Symbol", "WeakMap",
  "WeakSet", "document", "exports", "module", "process", "require", "window"
]);

const METHOD_EXCLUDE = new Set([
  "if", "for", "while", "switch", "catch", "function", "return", "const", "let", "var", "class",
  "interface", "type", "enum", "export", "import", "new", "delete", "typeof", "await", "yield", "case"
]);

/**
 * Replace comments and string literals with spaces, preserving length and newlines,
 * so offsets into the blanked text index the original. Template interpolations
 * (`${...}`) are code again; regex literals are blanked when a lookahead can
 * confirm them, and left alone when it cannot (division), so a misfire costs a
 * declaration, never a crash.
 */
export function blankSource(src: string): string {
  // Pre-fill with the source: untouched characters (a template interpolation's
  // expression, a regex the lookahead declined) stay code instead of collapsing.
  const out = src.split("");
  let i = 0;
  let lastSig = ""; // last significant (non-space, non-blanked) char in code position

  const isRegexStart = (): boolean => {
    if (!lastSig) return true;
    if ("(,=:[!&|?{};+-*%~^<>".includes(lastSig)) return true;
    // `return /re/` and friends: the word before `/` decides, not the letter itself.
    if (/[A-Za-z_$]/.test(lastSig)) {
      let j = i - 1;
      while (j >= 0 && /[A-Za-z_$0-9]/.test(src[j]!)) j--;
      const word = src.slice(j + 1, i);
      return ["return", "typeof", "case", "in", "of", "new", "delete", "void", "instanceof", "do", "else", "yield", "await"].includes(word);
    }
    return false;
  };

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < src.length; k++) {
      out[k] = src[k] === "\n" ? "\n" : " ";
    }
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
      const end = src.indexOf("*/", i + 2);
      const to = end === -1 ? src.length : end + 2;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        j++;
      }
      blank(i, j < src.length && src[j] === c ? j + 1 : j);
      i = j < src.length && src[j] === c ? j + 1 : j;
      lastSig = c;
      continue;
    }
    if (c === "`") {
      // Walk the template, blanking text but leaving `${ ... }` as code.
      let j = i + 1;
      blank(i, i + 1);
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "`") break;
        if (src[j] === "$" && src[j + 1] === "{") {
          // Interpolation: find the matching `}` with brace depth.
          let depth = 1;
          let k = j + 2;
          while (k < src.length && depth > 0) {
            const d = src[k]!;
            if (d === "{") depth++;
            else if (d === "}") depth--;
            else if (d === '"' || d === "'" || d === "`") {
              const quote = d;
              k++;
              while (k < src.length && src[k] !== quote && src[k] !== "\n") {
                if (src[k] === "\\") k++;
                k++;
              }
            } else if (d === "/" && src[k + 1] === "/") {
              const end = src.indexOf("\n", k);
              if (end === -1) k = src.length; else k = end;
              continue;
            }
            k++;
          }
          blank(j, j + 2); // blank `${` itself, keep the expression
          blank(k - 1, k); // and its closing `}` — brace depth must not see it
          j = k; // positioned at the closing `}` of the interpolation
          continue;
        }
        out[j] = src[j] === "\n" ? "\n" : " ";
        j++;
      }
      if (j < src.length) { out[j] = " "; j++; }
      i = j;
      lastSig = "`";
      continue;
    }
    if (c === "/" && isRegexStart()) {
      // Scan ahead first; only blank when the regex closes before a raw newline.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length) {
        const d = src[j]!;
        if (d === "\\") { j += 2; continue; }
        if (d === "\n") break;
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        blank(i, j + 1);
        i = j + 1;
        lastSig = "/";
        continue;
      }
    }
    if (!/\s/.test(c)) lastSig = c;
    out[i] = c;
    i++;
  }
  return out.join("");
}

interface BraceFrame {
  /** Symbol whose body closes at this brace; null for plain blocks. */
  owner: ParsedSymbol | null;
  bodyDepth: number;
}

interface PendingDecl {
  sym: ParsedSymbol;
  /** Brace depth at the declaration (before its opening brace). */
  depth: number;
  /** True once the declaration's opening `{` has been consumed. */
  opened: boolean;
  /** `type` aliases may end with `;` instead of a brace. */
  braceless: boolean;
}

interface ClassFrame {
  name: string;
  qualifiedName: string;
  bodyDepth: number;
  classSym: ParsedSymbol;
}

const lineOf = (src: string, index: number): number => {
  let line = 1;
  for (let k = 0; k < index && k < src.length; k++) if (src[k] === "\n") line++;
  return line;
};

const findBodyBrace = (text: string, from: number, depth: number): number => {
  let d = depth;
  for (let k = from; k < text.length; k++) {
    const c = text[k]!;
    if (c === "{" && d === depth) return k;
    if (c === "{" || c === "(" || c === "[") d++;
    else if (c === "}" || c === ")" || c === "]") d--;
    else if (c === ";" && d === depth) return -1;
    if (d < depth) return -1;
  }
  return -1;
};

const collectRefs = (text: string, from: number, to: number, self: string): string[] => {
  const refs = new Set<string>();
  const slice = text.slice(from, Math.max(from, to));
  const re = /(?<=^|[^.\w$])[A-Za-z_$][\w$]*/g;
  for (const m of slice.matchAll(re)) {
    const name = m[0];
    if (KEYWORDS.has(name) || GLOBALS.has(name) || name === self || name.length < 2) continue;
    refs.add(name);
  }
  return [...refs];
};

/**
 * Member calls `<receiver>.<method>(` inside one body, read from the blanked
 * text so comments and strings cannot plant calls. Bare `refs` deliberately
 * skip identifiers after `.`; these pairs are the raw material that lets sync
 * resolve service-layer methods to their callers (ADR-0050). `this` is the one
 * keyword receiver kept — it resolves to the enclosing class; keyword and
 * global receivers can never name a project class.
 */
const collectMemberCalls = (text: string, from: number, to: number): ParsedMemberCall[] => {
  const calls = new Map<string, ParsedMemberCall>();
  const slice = text.slice(from, Math.max(from, to));
  const re = /(?<=^|[^.\w$])([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of slice.matchAll(re)) {
    const receiver = match[1]!;
    const method = match[2]!;
    if (receiver !== "this" && (KEYWORDS.has(receiver) || GLOBALS.has(receiver))) continue;
    if (KEYWORDS.has(method)) continue;
    calls.set(`${receiver}.${method}`, { receiver, method });
  }
  // Two-level chains `receiver.field.method(`: the field name rides in `via` so
  // sync can walk the receiver's type to the real target (ADR-0050). The
  // one-level pattern cannot see these -- its lookbehind rejects identifiers
  // after `.` -- so the two shapes never double-record one occurrence.
  const chainRe = /(?<=^|[^.\w$])([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of slice.matchAll(chainRe)) {
    const receiver = match[1]!;
    const field = match[2]!;
    const method = match[3]!;
    if (receiver !== "this" && (KEYWORDS.has(receiver) || GLOBALS.has(receiver))) continue;
    if (KEYWORDS.has(field) || KEYWORDS.has(method)) continue;
    calls.set(`${receiver}.${field}.${method}`, { receiver, method, via: field });
  }
  return [...calls.values()];
};

/**
 * File-scope identifier → type-name bindings (ADR-0050): annotated parameters,
 * `const x: T = ...` and `const x = new T(...)`, read from the blanked text.
 * Parameter annotations are trusted only between param-list delimiters at brace
 * depth zero of their group — object-literal entries and ternary branches share
 * the `a: b` shape and would otherwise masquerade as parameters. Requiring `=`
 * right after a const's type keeps unions, generics and arrays out, so only
 * simple identifier types ever bind.
 */
const collectBindings = (text: string): Record<string, string> => {
  const bindings: Record<string, string> = {};
  const bind = (name: string, type: string): void => {
    if (KEYWORDS.has(name) || KEYWORDS.has(type)) return;
    bindings[name] = type;
  };
  for (const m of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*=/g)) bind(m[1]!, m[2]!);
  for (const m of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$]*)\s*\(/g)) bind(m[1]!, m[2]!);
  for (const m of text.matchAll(/\b(?:let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g)) bind(m[1]!, m[2]!);
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    // `name = new Type(...)` as a statement (also `this.field = ...` and
    // annotated class fields); a match directly behind a `:` is the type
    // annotation a `Foo: Foo = new Foo(...)` declaration leaves behind, not a
    // binding, so it is skipped.
    let back = m.index;
    while (back > 0 && /\s/.test(text[back - 1]!)) back--;
    if (text[back - 1] === ":") continue;
    bind(m[1]!, m[2]!);
  }

  const paramRe = /(?<=^|[({,]\s*|(?:private|protected|public|readonly)\s+)([A-Za-z_$][\w$]*)\s*\??\s*:\s*([A-Za-z_$][\w$]*)(?=\s*[,)=]|\s*$)/g;
  const opens: number[] = [];
  for (let k = 0; k < text.length; k++) {
    const ch = text[k]!;
    if (ch === "(") opens.push(k);
    else if (ch === ")" && opens.length > 0) {
      const inner = text.slice(opens.pop()! + 1, k);
      if (!inner.includes(":")) continue;
      paramRe.lastIndex = 0;
      let cursor = 0;
      let braceDepth = 0;
      let m: RegExpExecArray | null;
      while ((m = paramRe.exec(inner))) {
        for (; cursor < m.index; cursor++) {
          if (inner[cursor] === "{") braceDepth++;
          else if (inner[cursor] === "}") braceDepth--;
        }
        if (braceDepth > 0) continue;
        bind(m[1]!, m[2]!);
      }
    }
  }
  return bindings;
};

const HARNESS_CALLBACKS = new Set(["describe", "it", "test", "beforeEach", "afterEach", "beforeAll", "afterAll"]);
const HARNESS_CALL = new RegExp(`^(?:${[...HARNESS_CALLBACKS].join("|")})\\s*\\(`);

const findCallClose = (text: string, openIdx: number): number => {
  let depth = 0;
  for (let index = openIdx; index < text.length; index++) {
    const char = text[index]!;
    if (char === "(" || char === "{" || char === "[") depth++;
    else if (char === ")" || char === "}" || char === "]") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
};

/**
 * Body extent of a harness call's callback, or null when the last argument is
 * not visibly a function -- a bare identifier stays uncollected, the graph
 * would rather miss than guess (ADR-0050). Arrows qualify when their `=>` sits
 * at argument depth zero, so defaults like `(cb = () => {}) =>` hide their
 * inner arrows one level down and never masquerade as the body.
 */
const harnessCallbackBody = (text: string, openIdx: number, closeIdx: number): { from: number; to: number } | null => {
  let depth = 0;
  let argStart = openIdx + 1;
  for (let index = openIdx + 1; index < closeIdx; index++) {
    const char = text[index]!;
    if (char === "(" || char === "{" || char === "[") depth++;
    else if (char === ")" || char === "}" || char === "]") depth--;
    else if (char === "," && depth === 0) argStart = index + 1;
  }
  while (argStart < closeIdx && /\s/.test(text[argStart]!)) argStart++;
  if (argStart >= closeIdx) return null;
  let cursor = argStart;
  const asyncM = /^\s*async\b/.exec(text.slice(argStart, closeIdx));
  if (asyncM) cursor = argStart + asyncM[0].length;
  const fnM = /^\s*function\b/.exec(text.slice(cursor, closeIdx));
  if (fnM) {
    cursor += fnM[0].length;
    while (cursor < closeIdx && /[\s*]/.test(text[cursor]!)) cursor++;
    const paramsM = /^\s*(?:[A-Za-z_$][\w$]*)?\s*\(/.exec(text.slice(cursor, closeIdx));
    if (!paramsM) return null;
    const paramsOpen = cursor + paramsM[0].length - 1;
    let parenDepth = 0;
    let paramsClose = -1;
    for (let scan = paramsOpen; scan < closeIdx; scan++) {
      const char = text[scan]!;
      if (char === "(") parenDepth++;
      else if (char === ")") {
        parenDepth--;
        if (parenDepth === 0) {
          paramsClose = scan;
          break;
        }
      }
    }
    if (paramsClose === -1) return null;
    let braceIdx = paramsClose + 1;
    while (braceIdx < closeIdx && /\s/.test(text[braceIdx]!)) braceIdx++;
    if (text[braceIdx] !== "{") return null;
    return bracedBodyExtent(text, braceIdx, closeIdx);
  }
  depth = 0;
  for (; cursor < closeIdx - 1; cursor++) {
    const char = text[cursor]!;
    if (char === "(" || char === "{" || char === "[") depth++;
    else if (char === ")" || char === "}" || char === "]") depth--;
    else if (char === "=" && text[cursor + 1] === ">" && depth === 0) {
      let bodyIdx = cursor + 2;
      while (bodyIdx < closeIdx && /\s/.test(text[bodyIdx]!)) bodyIdx++;
      if (text[bodyIdx] === "{") return bracedBodyExtent(text, bodyIdx, closeIdx);
      return { from: cursor + 2, to: closeIdx };
    }
  }
  return null;
};

const bracedBodyExtent = (text: string, braceIdx: number, limit: number): { from: number; to: number } | null => {
  let depth = 0;
  for (let index = braceIdx; index < limit; index++) {
    const char = text[index]!;
    if (char === "{" || char === "(" || char === "[") depth++;
    else if (char === "}" || char === ")" || char === "]") {
      depth--;
      if (depth === 0) return { from: braceIdx + 1, to: index };
    }
  }
  return null;
};

const FIELD_MEMBER = new RegExp(
  `^(?:(?:public|private|protected|readonly|static|declare|override)\\s+)*([A-Za-z_$][\\w$]*)\\s*\\??\\s*:\\s*([A-Za-z_$][\\w$]*)\\s*(?=[;,=}]|$)`
);

/** Primitive type keywords are identifier-shaped types a field may honestly carry (ADR-0050). */
const PRIMITIVE_TYPES = new Set(["any", "bigint", "boolean", "never", "null", "number", "object", "string", "symbol", "unknown", "void"]);

/**
 * Field annotations of one interface/class body (ADR-0050): `name: Type` with a
 * simple identifier type, at member position only -- brace depth one of the
 * body, after a statement boundary. Methods never match (their name is
 * followed by `(`, not `:`), constructor parameter properties sit inside
 * parens, and unions/generics fail the terminator, so only what resolution can
 * actually use is kept.
 */
const collectFields = (text: string, from: number, to: number): Record<string, string> => {
  const fields: Record<string, string> = {};
  let depth = 0;
  let lastSig = "";
  let cursor = from;
  while (cursor < to) {
    const char = text[cursor]!;
    if (char === "{") {
      depth++;
      lastSig = char;
      cursor++;
      continue;
    }
    if (char === "}") {
      depth--;
      lastSig = char;
      cursor++;
      continue;
    }
    if (/[ \t\r\n]/.test(char)) {
      cursor++;
      continue;
    }
    if (depth === 1 && (";}{".includes(lastSig) || lastSig === "")) {
      const rest = text.slice(cursor, Math.min(to, cursor + 160));
      const newlineIdx = rest.indexOf("\n");
      const line = newlineIdx === -1 ? rest : rest.slice(0, newlineIdx);
      const match = line.match(FIELD_MEMBER);
      if (match && !KEYWORDS.has(match[1]!) && (!KEYWORDS.has(match[2]!) || PRIMITIVE_TYPES.has(match[2]!))) {
        fields[match[1]!] = match[2]!;
        cursor += match[0].length;
        lastSig = ";";
        continue;
      }
    }
    lastSig = char;
    cursor++;
  }
  return fields;
};

function parseImports(text: string, src: string): { imports: ParsedImport[]; reExports: ParsedImport[] } {
  const imports: ParsedImport[] = [];
  const reExports: ParsedImport[] = [];
  const push = (list: ParsedImport[], p: ParsedImport): void => {
    const dup = list.find((q) => q.spec === p.spec && q.isExport === p.isExport && q.namespace === p.namespace && q.defaultName === p.defaultName && q.dynamic === p.dynamic);
    if (!dup) list.push(p);
    else for (const n of p.names) if (!dup.names.includes(n)) dup.names.push(n);
  };
  const splitNames = (raw: string): string[] =>
    raw.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim()).filter((s) => s && s !== "type");

  // Statement starts, found on the blanked text so comments and strings cannot
  // plant fake imports. The specifier literal is read from the ORIGINAL slice at
  // the same offsets — the blanked copy has spaces where every string was.
  const token = /\b(import|export)\b/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(text))) {
    const start = m.index;
    const rest = text.slice(start, start + 80);
    if (m[1] === "export") {
      if (!/^export\s+(?:type\s+)?\{/.test(rest) && !/^export\s*\*/.test(rest)) continue;
    }
    if (m[1] === "import" && /^\s*\(/.test(text.slice(start + m[1].length, start + m[1].length + 80))) {
      // `import (` is the dynamic call form — an expression, not a statement.
      // The dedicated scan below collects it; letting the statement scan see
      // it too would record the same specifier twice (ADR-0050).
      continue;
    }
    // `import` needs no statement-shape check: the token regex already matched a
    // bare word on blanked text, and a side-effect import may be nothing but a
    // blanked specifier by the time we look at it.
    // Search after the keyword itself — the statement begins with it, and a
    // self-match would truncate the statement to nothing.
    const seg = text.slice(start + m[1].length, start + 800);
    const stop = seg.search(/;|\b(?:import|export)\b/);
    const end = stop === -1 ? Math.min(text.length, start + 800) : start + m[1].length + stop;
    const blanked = text.slice(start, end);
    const specM = src.slice(start, end).match(/["']([^"']+)["']/);
    if (!specM) continue;
    const spec = specM[1]!;
    if (m[1] === "import") {
      const braces = blanked.match(/\{([^}]*)\}/);
      const star = blanked.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
      const defaultM = blanked.match(/^import\s*(?:type\s+)?([A-Za-z_$][\w$]*)/);
      push(imports, {
        spec,
        names: braces ? splitNames(braces[1]!) : [],
        namespace: star?.[1] ?? null,
        defaultName: defaultM?.[1] ?? null,
        sideEffect: !braces && !star && !defaultM,
        isExport: false
      });
    } else {
      const braces = blanked.match(/\{([^}]*)\}/);
      push(reExports, { spec, names: braces ? splitNames(braces[1]!) : ["*"], namespace: null, defaultName: null, sideEffect: false, isExport: true });
    }
  }
  // Dynamic imports and require() live in EXPRESSION positions — `await
  // import("./x")`, `import("./x").then(...)`, `require("./x")` — where the
  // statement scan's keyword walk never looks, so they are scanned separately
  // on the blanked text. Call positions come from the blanked copy (comments
  // and strings cannot plant one); the specifier literal is read from the
  // ORIGINAL slice at the same offsets, the established pattern (ADR-0050).
  const callRe = /(?<=^|[^.\w$])(import|require)\s*\(/g;
  while ((m = callRe.exec(text))) {
    const openIdx = m.index + m[0].length - 1;
    let depth = 1;
    let closeIdx = -1;
    for (let index = openIdx + 1; index < text.length; index++) {
      const char = text[index]!;
      if (char === "(") depth++;
      else if (char === ")") {
        depth--;
        if (depth === 0) {
          closeIdx = index;
          break;
        }
      }
    }
    if (closeIdx === -1) continue;
    const specM = src.slice(openIdx + 1, closeIdx).match(/["']([^"']+)["']/);
    if (!specM) continue;
    push(imports, {
      spec: specM[1]!,
      names: [],
      namespace: null,
      defaultName: null,
      sideEffect: false,
      isExport: false,
      dynamic: true
    });
  }
  return { imports, reExports };
}

/**
 * Parse one TS/JS source file. Never throws for parseable-looking code — a
 * structural surprise surfaces as `parseError` and the sync moves on (ADR-0050).
 */
export function parseSource(src: string): ParsedFile {
  try {
    const text = blankSource(src);
    const symbols: ParsedSymbol[] = [];
    const { imports, reExports } = parseImports(text, src);
    const bindings = collectBindings(text);
    const moduleRefs = new Set<string>();
    const moduleMemberCalls = new Map<string, ParsedMemberCall>();
    const stack: BraceFrame[] = [];
    const classes: ClassFrame[] = [];
    const pending: PendingDecl[] = [];

    let depth = 0;
    let line = 1;
    let i = 0;

    const isStatementStart = (): boolean => {
      let j = i - 1;
      while (j >= 0 && /[ \t\r\n]/.test(text[j]!)) j--;
      if (j < 0) return true;
      return ";}{".includes(text[j]!);
    };

    const closePending = (): void => {
      for (let p = pending.length - 1; p >= 0; p--) {
        const pd = pending[p]!;
        if (pd.opened && depth < pd.depth + 1) {
          pd.sym.lineEnd = line;
          if (pd.sym.kind === "class") {
            const idx = classes.findIndex((c) => c.classSym === pd.sym);
            if (idx !== -1) classes.splice(idx, 1);
          }
          pending.splice(p, 1);
        }
      }
    };

    // Jump helper: every branch that leaps `i` forward must carry the newline
    // count with it, or every lineStart after a multi-line signature drifts and
    // body refs slice the wrong lines (the bug ADR-0050's own repo exposed).
    const advance = (to: number): void => {
      for (let k = i; k < to && k < text.length; k++) {
        if (text[k] === "\n") line++;
      }
      i = Math.min(Math.max(to, i), text.length);
    };

    while (i < text.length) {
      const c = text[i]!;
      if (c === "\n") {
        line++;
        i++;
        continue;
      }
      if (c === "{") {
        // Claim the brace for a pending declaration whose header just ended.
        const claimant = pending.find((pd) => !pd.opened && depth === pd.depth && !pd.braceless);
        if (claimant) {
          claimant.opened = true;
          if (claimant.sym.kind === "class") {
            classes.push({ name: claimant.sym.name, qualifiedName: claimant.sym.qualifiedName, bodyDepth: depth + 1, classSym: claimant.sym });
          }
          stack.push({ owner: claimant.sym, bodyDepth: depth + 1 });
          depth++;
          i++;
          continue;
        }
        stack.push({ owner: null, bodyDepth: depth + 1 });
        depth++;
        i++;
        continue;
      }
      if (c === "}") {
        const frame = stack.pop();
        depth = Math.max(0, depth - 1);
        if (frame?.owner && frame.owner.lineEnd === null) frame.owner.lineEnd = line;
        closePending();
        i++;
        continue;
      }

      // Declarations start where a statement can start: after a line break or one
      // of `;` `}` `{`. Everything else is single-stepped, so braces and closures
      // inside ordinary lines keep the depth tracker honest.
      if (!/[A-Za-z_$]/.test(c) || !isStatementStart()) {
        i++;
        continue;
      }

      const rest = text.slice(i, i + 400);
      const lineEndIdx = rest.indexOf("\n");
      const restLine = lineEndIdx === -1 ? rest : rest.slice(0, lineEndIdx);

      // Class declaration.
      const classM = restLine.match(new RegExp(`^(export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+(${IDENT})`));
      if (classM && depth === (classes.at(-1)?.bodyDepth ?? 0)) {
        const name = classM[2]!;
        const sym: ParsedSymbol = {
          name,
          kind: "class",
          qualifiedName: classes.length ? `${classes.at(-1)!.qualifiedName}.${name}` : name,
          signature: "",
          lineStart: line,
          lineEnd: null,
          exported: Boolean(classM[1]),
          parent: classes.at(-1)?.qualifiedName ?? null,
          refs: [],
          memberCalls: []
        };
        symbols.push(sym);
        const brace = findBodyBrace(text, i + classM[0]!.length, depth);
        const headerEnd = brace === -1 ? Math.min(text.length, i + restLine.length) : brace;
        sym.signature = src.slice(i, headerEnd).replace(/\s+/g, " ").trim().slice(0, 120);
        pending.push({ sym, depth, opened: false, braceless: false });
        i += classM[0]!.length;
        continue;
      }

      // Method at a class body's top level.
      if (classes.length && depth === classes.at(-1)!.bodyDepth) {
        // The `(` is a lookahead, not part of the match: findBodyBrace scans from
        // the end of the match, and starting inside the parameter list would hit
        // the closing paren first and bail.
        const methodM = restLine.match(new RegExp(`^(?:(?:public|private|protected|static|readonly|async|override)\\s+)*(?:get\\s+|set\\s+)?(\\*?\\s*)(${IDENT})\\s*(<[^>]*>)?\\s*(?=\\()`));
        const cls = classes.at(-1)!;
        if (methodM && !METHOD_EXCLUDE.has(methodM[2]!)) {
          const name = methodM[2]!;
          const sym: ParsedSymbol = {
            name,
            kind: "method",
            qualifiedName: `${cls.qualifiedName}.${name}`,
            signature: "",
            lineStart: line,
            lineEnd: null,
            exported: false,
            parent: cls.qualifiedName,
            refs: [],
            memberCalls: []
          };
          const headerStart = i;
      const brace = findBodyBrace(text, i + methodM[0]!.length, depth);
          const headerEnd = brace === -1 ? Math.min(text.length, i + restLine.length) : brace;
          sym.signature = src.slice(headerStart, headerEnd).replace(/\s+/g, " ").trim().slice(0, 120);
          symbols.push(sym);
          if (brace !== -1) {
            pending.push({ sym, depth, opened: false, braceless: false });
            advance(brace);
            continue;
          }
          i += methodM[0]!.length;
          continue;
        }
      }

      // Function declaration.
      const funcM = restLine.match(new RegExp(`^(export\\s+)?(default\\s+)?(async\\s+)?function\\s*\\*?\\s*(${IDENT})`));
      if (funcM) {
        const name = funcM[4]!;
        const parent = classes.length && depth >= classes.at(-1)!.bodyDepth ? classes.at(-1)!.qualifiedName : null;
        const sym: ParsedSymbol = {
          name,
          kind: "function",
          qualifiedName: parent ? `${parent}.${name}` : name,
          signature: "",
          lineStart: line,
          lineEnd: null,
          exported: Boolean(funcM[1] || funcM[2]),
          parent,
          refs: [],
          memberCalls: []
        };
        const headerStart = i;
        const brace = findBodyBrace(text, i + funcM[0]!.length, depth);
        const headerEnd = brace === -1 ? Math.min(text.length, i + restLine.length) : brace;
        sym.signature = src.slice(headerStart, headerEnd).replace(/\s+/g, " ").trim().slice(0, 120);
        symbols.push(sym);
        if (brace !== -1) {
          pending.push({ sym, depth, opened: false, braceless: false });
          advance(brace);
          continue;
        }
        i += funcM[0]!.length;
        continue;
      }

      // Interface / enum (braced) and type alias (may end with `;`).
      const ifaceM = restLine.match(new RegExp(`^(export\\s+)?interface\\s+(${IDENT})`));
      const enumM = ifaceM ? null : restLine.match(new RegExp(`^(export\\s+)?(?:const\\s+)?enum\\s+(${IDENT})`));
      const typeM = ifaceM || enumM ? null : restLine.match(new RegExp(`^(export\\s+)?type\\s+(${IDENT})\\s*([=<])`));
      if (ifaceM || enumM || typeM) {
        const m = (ifaceM ?? enumM ?? typeM)!;
        const name = (ifaceM ? ifaceM[2] : enumM ? enumM[2] : typeM![2])!;
        const kind: ParsedSymbol["kind"] = ifaceM ? "interface" : enumM ? "enum" : "type";
        const sym: ParsedSymbol = {
          name,
          kind,
          qualifiedName: classes.length && depth >= classes.at(-1)!.bodyDepth ? `${classes.at(-1)!.qualifiedName}.${name}` : name,
          signature: "",
          lineStart: line,
          lineEnd: null,
          exported: Boolean(m[1]),
          parent: null,
          refs: [],
          memberCalls: []
        };
        const headerStart = i;
        if (kind === "type") {
          const semi = text.indexOf(";", i);
          const nl = text.indexOf("\n", i);
          const end = semi !== -1 && (nl === -1 || semi < nl) ? semi : nl === -1 ? text.length : nl;
          sym.signature = src.slice(headerStart, end).replace(/\s+/g, " ").trim().slice(0, 120);
          sym.lineEnd = lineOf(text, end);
          symbols.push(sym);
          advance(end);
          continue;
        }
        const brace = findBodyBrace(text, i + m[0]!.length, depth);
        const headerEnd = brace === -1 ? Math.min(text.length, i + restLine.length) : brace;
        sym.signature = src.slice(headerStart, headerEnd).replace(/\s+/g, " ").trim().slice(0, 120);
        symbols.push(sym);
        if (brace !== -1) {
          pending.push({ sym, depth, opened: false, braceless: false });
          advance(brace);
          continue;
        }
        i += m[0]!.length;
        continue;
      }

      // Test-harness callback bodies are file-scope collection points
      // (ADR-0050): what an it/describe body does IS what the module node
      // knows. Only top-level harness calls (depth 0) qualify, and only when
      // the last argument is visibly a function; a whole describe body covers
      // its nested hooks, so nothing inside is collected twice.
      const harnessM = depth === 0 ? rest.match(HARNESS_CALL) : null;
      if (harnessM) {
        const openIdx = i + harnessM[0].length - 1;
        const closeIdx = findCallClose(text, openIdx);
        if (closeIdx !== -1) {
          const body = harnessCallbackBody(text, openIdx, closeIdx);
          if (body) {
            for (const ref of collectRefs(text, body.from, body.to, "")) {
              if (!HARNESS_CALLBACKS.has(ref)) moduleRefs.add(ref);
            }
            for (const call of collectMemberCalls(text, body.from, body.to)) {
              moduleMemberCalls.set(`${call.receiver}.${call.via ?? ""}.${call.method}`, call);
            }
          }
        }
        advance(i + harnessM[0].length);
        continue;
      }

      // Exported arrow-function / value constant.
      const constM = restLine.match(new RegExp(`^export\\s+const\\s+(${IDENT})\\s*(?::[^=]*)?=\\s*(async\\s+)?`));
      if (constM) {
        const name = constM[1]!;
        const afterEq = i + constM[0]!.length;
        const rest2 = text.slice(afterEq, afterEq + 400);
        const arrowM = rest2.match(/^\s*(?:async\s+)?(?:<[^>]*>)?\(/);
        const isArrow = Boolean(arrowM) && /^\s*(?:async\s+)?(?:<[^>]*>)?\([^)]*\)\s*(?::[^=]*)?=>/.test(rest2);
        const headerEnd = isArrow ? afterEq + rest2.indexOf("=>") : (() => {
          const semi = text.indexOf(";", afterEq);
          const nl = text.indexOf("\n", afterEq);
          return semi !== -1 && (nl === -1 || semi < nl) ? semi : nl === -1 ? text.length : nl;
        })();
        const sym: ParsedSymbol = {
          name,
          kind: isArrow ? "function" : "const",
          qualifiedName: name,
          signature: src.slice(i, headerEnd + (isArrow ? 2 : 0)).replace(/\s+/g, " ").trim().slice(0, 120),
          lineStart: line,
          lineEnd: null,
          exported: true,
          parent: null,
          refs: [],
          memberCalls: []
        };
        symbols.push(sym);
        if (isArrow) {
          const arrowPos = afterEq + rest2.indexOf("=>") + 2;
          const nl2 = text.indexOf("\n", arrowPos);
          const semi2 = text.indexOf(";", arrowPos);
          const stmtEnd = semi2 !== -1 && (nl2 === -1 || semi2 < nl2) ? semi2 : nl2;
          const braceRel = text.slice(arrowPos, stmtEnd === -1 ? arrowPos : stmtEnd).indexOf("{");
          if (braceRel !== -1) {
            pending.push({ sym, depth, opened: false, braceless: false });
            advance(arrowPos + braceRel);
            continue;
          }
          sym.lineEnd = line;
          const bodyEnd = stmtEnd === -1 ? Math.min(text.length, arrowPos + 200) : stmtEnd;
          sym.refs = collectRefs(text, arrowPos, bodyEnd, name);
          sym.memberCalls = collectMemberCalls(text, arrowPos, bodyEnd);
          advance(bodyEnd);
          continue;
        }
        sym.lineEnd = lineOf(text, headerEnd);
        advance(headerEnd);
        continue;
      }

      i++;
    }

    // Refs for braced bodies: slice the blanked text between the header end and the
    // body's closing line, which every pending declaration recorded.
    const lineStarts: number[] = [0];
    for (let k = 0; k < text.length; k++) if (text[k] === "\n") lineStarts.push(k + 1);
    const offsetOfLine = (l: number): number => lineStarts[Math.min(l - 1, lineStarts.length - 1)] ?? 0;
    for (const sym of symbols) {
      if (sym.refs.length || sym.kind === "type") continue;
      // A class's body refs are its methods' refs — a class does not "call"
      // anything by containing methods, so it never produces call edges.
      if (sym.kind === "class" || sym.kind === "interface" || sym.kind === "enum") continue;
      const from = offsetOfLine(sym.lineStart);
      const to = offsetOfLine((sym.lineEnd ?? sym.lineStart) + 1);
      sym.refs = collectRefs(text, from, to, sym.name);
      sym.memberCalls = collectMemberCalls(text, from, to);
    }

    // Field type maps (ADR-0050): one entry per interface/class that declares
    // at least one usable field, scanned from the blanked body so comments and
    // strings cannot plant fields.
    const fields: Record<string, Record<string, string>> = {};
    for (const sym of symbols) {
      if ((sym.kind !== "interface" && sym.kind !== "class") || sym.lineEnd === null) continue;
      const from = offsetOfLine(sym.lineStart);
      const to = offsetOfLine(sym.lineEnd + 1);
      const body = collectFields(text, from, to);
      if (Object.keys(body).length > 0) fields[sym.name] = body;
    }

    return { symbols, imports, reExports, bindings, moduleRefs: [...moduleRefs], moduleMemberCalls: [...moduleMemberCalls.values()], fields };
  } catch (e) {
    return { symbols: [], imports: [], reExports: [], bindings: {}, moduleRefs: [], moduleMemberCalls: [], fields: {}, parseError: e instanceof Error ? e.message : String(e) };
  }
}
