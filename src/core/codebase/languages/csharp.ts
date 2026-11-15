import type { LanguageGrammar, ParsedFile, ParsedImport, ParsedMemberCall, ParsedSymbol } from "./types.js";

/**
 * C# as a registry grammar (roadmap Phase 2, brace family). The blanker covers
 * the lexical forms the brace tracker must not trip over — line and block
 * comments, string and char literals, verbatim `@"..."` strings and `"""`
 * raw strings, all length-preserving with newlines kept so offset arithmetic
 * stays honest. The parser fills the same ParsedFile shapes the TS/JS scanner
 * fills, with kinds mapped onto the shared set and nothing invented (Ruling
 * 3): class, interface and enum say themselves, struct says type, record says
 * class. C# namespaces are what Java's packages are not: they nest, they come
 * in block and file-scoped forms, and several can share one file — so the
 * namespace stack rides the brace frames and every qualified name carries it
 * (`Acme.Core.Widget`). Bindings and fields stretch only to the shapes that
 * are structural in C# too (simple two-identifier declarations); everything
 * else stays empty rather than guessing. Resolution: namespaces map to
 * directories by convention, on `resolveImport`.
 */

const IDENT_RE = /^[A-Za-z_]\w*/;

/**
 * C# reserved words plus the contextual ones that never read as member names
 * in real code (var, async, await, get, set, value). Deliberately contextual
 * and legal-as-a-name keywords (record, required, file, scoped, with) stay
 * out, so a member honestly named `record` still parses.
 */
const KEYWORDS = new Set([
  "abstract", "and", "as", "async", "await", "base", "bool", "break", "byte", "case", "catch",
  "char", "checked", "class", "const", "continue", "decimal", "default", "delegate", "do",
  "double", "dynamic", "else", "enum", "event", "explicit", "extern", "false", "finally",
  "fixed", "float", "for", "foreach", "get", "global", "goto", "if", "implicit", "in", "init",
  "int", "interface", "internal", "is", "lock", "long", "nameof", "namespace", "new", "nint",
  "not", "null", "nuint", "object", "operator", "or", "out", "override", "params", "private",
  "protected", "public", "readonly", "ref", "return", "sbyte", "sealed", "set", "short",
  "sizeof", "stackalloc", "static", "string", "struct", "switch", "this", "throw", "true",
  "try", "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort", "using", "value", "var",
  "virtual", "void", "volatile", "when", "where", "while", "yield"
]);

/** BCL namespaces and static entry points that are identifier-shaped in nearly every file — never call-edge candidates (ADR-0050). */
const GLOBALS = new Set([
  "Array", "Boolean", "Byte", "Char", "Collections", "Console", "Convert", "Data", "DateTime",
  "Decimal", "Diagnostics", "Dictionary", "Double", "Encoding", "Environment", "Exception",
  "File", "Globalization", "Guid", "HashSet", "HttpClient", "IDictionary", "IList",
  "ICollection", "IEnumerable", "IQueryable", "Int32", "Int64", "IO", "Linq", "List", "Math",
  "Net", "Nullable", "Object", "Path", "Random", "Reflection", "Regex", "Runtime", "Single",
  "StringBuilder", "String", "System", "Task", "Tasks", "Text", "Thread", "Threading",
  "TimeSpan", "Timer", "Trace", "Debug", "Tuple", "Type", "Uri", "ValueTuple", "Web", "Xml"
]);

/**
 * The task's exclusion list (if/for/while/switch/catch/lock/return/new/using)
 * plus every other statement keyword — a name position before `(` can never
 * hold one, so rejecting them can only miss, never lie.
 */
const METHOD_EXCLUDE = new Set([
  "if", "for", "foreach", "while", "switch", "catch", "lock", "return", "new", "using",
  "do", "else", "try", "throw", "fixed", "checked", "unchecked", "goto", "break", "continue",
  "yield", "await", "base", "this", "operator"
]);

const METHOD_MODIFIERS = new Set([
  "public", "private", "protected", "internal", "static", "abstract", "sealed", "virtual",
  "override", "async", "partial", "extern", "unsafe", "readonly", "new"
]);

/** Primitive type keywords are identifier-shaped types a field may honestly carry (ADR-0050). */
const PRIMITIVE_TYPES = new Set(["bool", "byte", "char", "decimal", "double", "float", "int", "long", "object", "sbyte", "short", "string", "uint", "ulong", "ushort", "void"]);

const TYPE_MODS = "(?:(?:public|private|protected|internal|static|abstract|sealed|partial|unsafe|readonly|new|required)\\s+)*";
const FIELD_MODS = "(?:(?:public|private|protected|internal|static|readonly|const|volatile|new|required)\\s+)*";
const TYPE_DECL_RE = new RegExp(`^(${TYPE_MODS})(class|interface|enum|struct|record)(?:\\s+(?:class|struct))?\\s+([A-Za-z_]\\w*)`);
const FIELD_RE = new RegExp(`^${FIELD_MODS}([A-Za-z_]\\w*)\\s+([A-Za-z_]\\w*)\\s*(?=[;=])`);
const IMPORT_RE = /\busing\s+(?!var\b)(static\s+)?([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*;/g;
const NEW_SOURCE = "\\b([A-Za-z_]\\w*)\\s*=\\s*new\\s+([A-Za-z_]\\w*)\\s*\\(";
const PARAM_MODS = new Set(["ref", "out", "in", "this", "params"]);

/**
 * Replace comments, string literals (regular, verbatim, raw) and char literals
 * with spaces, preserving length and newlines, so offsets into the blanked
 * text index the original. Verbatim `""` escapes and raw strings span lines —
 * their newlines stay put precisely because every lineStart after one must
 * survive.
 */
function blankCSharp(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < src.length; k++) {
      out[k] = src[k] === "\n" ? "\n" : " ";
    }
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const to = end === -1 ? src.length : end + 2;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      // C# 11 raw string: no escapes; the closer is the next `"""` run.
      let j = i + 3;
      let close = -1;
      while (j < src.length) {
        if (src[j] === '"' && src[j + 1] === '"' && src[j + 2] === '"') { close = j; break; }
        j++;
      }
      const to = close === -1 ? src.length : close + 3;
      blank(i, to);
      i = to;
      continue;
    }
    if (c === "@" && src[i + 1] === '"') {
      // Verbatim string: `""` is an escaped quote and backslashes are literal.
      let j = i + 2;
      while (j < src.length) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { j += 2; continue; }
          break;
        }
        j++;
      }
      const to = j < src.length ? j + 1 : j;
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
      const to = j < src.length && src[j] === c ? j + 1 : j;
      blank(i, to);
      i = to;
      continue;
    }
    i++;
  }
  return out.join("");
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

/** First `;` at the declaration's own depth — a positional record's or expression-bodied member's end. */
const stmtEndAfter = (text: string, from: number): number => {
  let d = 0;
  for (let k = from; k < text.length; k++) {
    const c = text[k]!;
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") {
      d--;
      if (d < 0) return -1;
    } else if (c === ";" && d === 0) return k;
  }
  return -1;
};

/** Attribute lists are statement-carried, so a balanced `[...]` skip never eats an indexer. */
const skipAttribute = (text: string, open: number): number => {
  let d = 0;
  for (let k = open; k < text.length; k++) {
    const c = text[k]!;
    if (c === "[") d++;
    else if (c === "]") {
      d--;
      if (d === 0) return k + 1;
    }
  }
  return text.length;
};

const findMatchingParen = (text: string, open: number): number => {
  let d = 0;
  for (let k = open; k < text.length; k++) {
    const c = text[k]!;
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") {
      d--;
      if (d === 0 && c === ")") return k;
    }
  }
  return -1;
};

/**
 * Header walk for one candidate method/constructor at a type-body statement
 * position: modifiers and type-shaped tokens (generics, arrays, nullables,
 * dotted and tuple types) may precede the name, and the name is the identifier
 * right before the first `(` — so a signature may wrap lines freely and the
 * line count never drifts. An `=`, `;`, `{`, `}` or keyword name bails, so
 * properties, expression-bodied members and control statements never
 * masquerade as methods (ADR-0050).
 */
const matchMethodHeader = (text: string, start: number): { name: string; openParen: number } | null => {
  let k = start;
  let lastWord: string | null = null;
  let sawPrefix = false;
  while (k < text.length) {
    const c = text[k]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { k++; continue; }
    if (c === "=" || c === ";" || c === "{" || c === "}" || c === ")") return null;
    if (c === "(") {
      if (lastWord !== null && !KEYWORDS.has(lastWord) && !METHOD_EXCLUDE.has(lastWord)) {
        if (!sawPrefix) return null;
        return { name: lastWord, openParen: k };
      }
      // A tuple return type leads the header; skip it balanced and walk on.
      let d = 0;
      let closed = false;
      for (; k < text.length; k++) {
        const inner = text[k]!;
        if (inner === "(" || inner === "[" || inner === "{") d++;
        else if (inner === ")" || inner === "]" || inner === "}") {
          d--;
          if (d === 0) { k++; closed = true; break; }
        }
      }
      if (!closed) return null;
      sawPrefix = true;
      continue;
    }
    if (c === "<") {
      let ang = 0;
      let closed = false;
      while (k < text.length) {
        const d = text[k]!;
        if (d === "<") ang++;
        else if (d === ">") { ang--; if (ang === 0) { k++; closed = true; break; } }
        else if (d === ";" || d === "=" || d === "{") return null;
        k++;
      }
      if (!closed) return null;
      continue;
    }
    if (c === "[" || c === "]" || c === "?" || c === "," || c === "." || c === "&" || c === ":" || c === "*") { k++; continue; }
    const wordM = IDENT_RE.exec(text.slice(k, k + 120));
    if (!wordM) return null;
    const word = wordM[0];
    if (word === "operator") return null;
    if (METHOD_MODIFIERS.has(word)) { k += word.length; sawPrefix = true; continue; }
    let p = k + word.length;
    while (p < text.length && /\s/.test(text[p]!)) p++;
    if (text[p] === "(") {
      if (KEYWORDS.has(word) || METHOD_EXCLUDE.has(word)) return null;
      if (!sawPrefix) return null;
      return { name: word, openParen: p };
    }
    lastWord = word;
    sawPrefix = true;
    k = p;
  }
  return null;
};

const bindParam = (part: string, bind: (name: string, type: string) => void): void => {
  // Conservative simple-identifier types only: generics, arrays, tuples,
  // nullable and qualified types never bind (ADR-0050's rule).
  if (/[<[(.?=:]/.test(part)) return;
  const tokens: string[] = [];
  for (let k = 0; k < part.length; ) {
    if (/\s/.test(part[k]!)) { k++; continue; }
    const w = IDENT_RE.exec(part.slice(k));
    if (!w) { k++; continue; }
    tokens.push(w[0]);
    k += w[0].length;
  }
  const kept = tokens.filter((t) => !PARAM_MODS.has(t));
  if (kept.length === 2) {
    const type = kept[0]!;
    const name = kept[1]!;
    if (!KEYWORDS.has(type) && !KEYWORDS.has(name)) bind(name, type);
  }
};

const collectParams = (text: string, openParen: number, closeParen: number, bind: (name: string, type: string) => void): void => {
  const inner = text.slice(openParen + 1, closeParen);
  const parts: string[] = [];
  let cur = "";
  let d = 0;
  for (let k = 0; k < inner.length; k++) {
    const c = inner[k]!;
    if (c === "[") { cur += " "; k = skipAttribute(inner, k) - 1; continue; }
    if (c === "(" || c === "[" || c === "{" || c === "<") d++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") d--;
    else if (c === "," && d === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim().length > 0) parts.push(cur);
  for (const part of parts) bindParam(part, bind);
};

/**
 * Identifiers referenced in one body, read from the blanked text so comments
 * and strings cannot plant refs. Identifiers after `.` are deliberately
 * skipped — those pairs are member calls, not bare names (ADR-0050).
 */
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

/** `<receiver>.<method>(` pairs inside one body — the raw material that lets sync resolve service-layer methods (ADR-0050). */
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

interface BraceFrame {
  kind: "namespace" | "type" | "block";
  /** namespace frames: nsStack length before this block pushed its segments */
  nsLen?: number;
  /** type frames: the declared type and the fields collected in its body */
  type?: { sym: ParsedSymbol; fields: Record<string, string> };
  bodyDepth: number;
}

interface PendingDecl {
  sym: ParsedSymbol | null;
  nsSegments: string[] | null;
  depth: number;
  opened: boolean;
}

/**
 * Parse one C# source file. Never throws for parseable-looking code — a
 * structural surprise surfaces as `parseError` and the sync moves on
 * (ADR-0050).
 *
 * The namespace stack is the one piece of file-level state C# adds over Java:
 * a file-scoped `namespace X.Y;` resets it, a block `namespace X.Y {` pushes
 * onto it through the pending/claim machinery, and the closing brace
 * truncates it — so qualified names carry the namespace exactly, and two
 * same-name classes in two namespaces stay two symbols.
 */
function parseCSharp(src: string, blanked: string): ParsedFile {
  try {
    const text = blanked;
    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    const bindings: Record<string, string> = {};
    const fields: Record<string, Record<string, string>> = {};
    const nsStack: string[] = [];

    const bind = (name: string, type: string): void => {
      if (KEYWORDS.has(name) || KEYWORDS.has(type)) return;
      bindings[name] = type;
    };

    // Usings are a whole-text scan on the blanked copy (comments and strings
    // cannot plant one); the strict identifier-dot shape keeps `using var`
    // declarations and `using (...)` statements out. The `static` keyword
    // rides in the spec — the as-written form — because namespaces and static
    // classes share the dotted shape and resolveImport must tell them apart.
    const pushImport = (p: ParsedImport): void => {
      const dup = imports.find((q) => q.spec === p.spec && q.names.length === p.names.length && q.names.every((n, idx) => n === p.names[idx]));
      if (dup) return;
      imports.push(p);
    };
    IMPORT_RE.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = IMPORT_RE.exec(text))) {
      const path = im[2]!.replace(/\s+/g, "");
      pushImport({
        spec: im[1] ? `static ${path}` : path,
        names: im[1] ? [path.split(".").at(-1)!] : [],
        namespace: null,
        defaultName: null,
        sideEffect: false,
        isExport: false
      });
    }

    const stack: BraceFrame[] = [];
    const pending: PendingDecl[] = [];
    let depth = 0;
    let line = 1;
    let i = 0;
    let attributeJustEnded = false;

    // Jump helper: every branch that leaps `i` forward must carry the newline
    // count with it, or every lineStart after a multi-line signature drifts
    // (the bug ADR-0050's own repo exposed).
    const advance = (to: number): void => {
      for (let k = i; k < to && k < text.length; k++) {
        if (text[k] === "\n") line++;
      }
      i = Math.min(Math.max(to, i), text.length);
    };

    const closePending = (): void => {
      for (let p = pending.length - 1; p >= 0; p--) {
        const pd = pending[p]!;
        if (pd.opened && depth < pd.depth + 1) {
          if (pd.sym) pd.sym.lineEnd = line;
          pending.splice(p, 1);
        }
      }
    };

    // `Widget w = expr;` and `Widget w;` — the two-identifier statement shape
    // is a local declaration and nothing else at statement position, so it
    // binds conservatively (simple identifier types only).
    const tryLocalDecl = (): boolean => {
      let k = i;
      while (k < text.length && /\s/.test(text[k]!)) k++;
      const w1 = IDENT_RE.exec(text.slice(k, k + 120));
      if (!w1 || KEYWORDS.has(w1[0])) return false;
      let p = k + w1[0].length;
      while (p < text.length && /\s/.test(text[p]!)) p++;
      const w2 = IDENT_RE.exec(text.slice(p, p + 120));
      if (!w2 || KEYWORDS.has(w2[0])) return false;
      let q = p + w2[0].length;
      while (q < text.length && /\s/.test(text[q]!)) q++;
      const next = text[q];
      if (next === ";" || next === "=") {
        bind(w2[0], w1[0]);
        advance(q);
        return true;
      }
      return false;
    };

    while (i < text.length) {
      const c = text[i]!;
      if (c === "\n") { line++; i++; continue; }
      if (c === " " || c === "\t" || c === "\r") { i++; continue; }
      if (c === "{") {
        attributeJustEnded = false;
        const claimant = pending.find((p) => !p.opened && depth === p.depth);
        if (claimant) {
          claimant.opened = true;
          if (claimant.nsSegments) {
            const nsLen = nsStack.length;
            nsStack.push(...claimant.nsSegments);
            stack.push({ kind: "namespace", nsLen, bodyDepth: depth + 1 });
          } else if (claimant.sym && claimant.sym.kind !== "method") {
            stack.push({ kind: "type", type: { sym: claimant.sym, fields: {} }, bodyDepth: depth + 1 });
          } else {
            stack.push({ kind: "block", bodyDepth: depth + 1 });
          }
          depth++;
          i++;
          continue;
        }
        stack.push({ kind: "block", bodyDepth: depth + 1 });
        depth++;
        i++;
        continue;
      }
      if (c === "}") {
        attributeJustEnded = false;
        const frame = stack.pop();
        depth = Math.max(0, depth - 1);
        closePending();
        if (frame) {
          if (frame.kind === "namespace" && frame.nsLen !== undefined) nsStack.length = frame.nsLen;
          if (frame.kind === "type" && frame.type && Object.keys(frame.type.fields).length > 0) {
            fields[frame.type.sym.name] = frame.type.fields;
          }
        }
        i++;
        continue;
      }
      if (c === ";") { attributeJustEnded = false; i++; continue; }

      const atStmtStart = attributeJustEnded || (() => {
        let j = i - 1;
        while (j >= 0 && /[ \t\r\n]/.test(text[j]!)) j--;
        return j < 0 || ";}{".includes(text[j]!);
      })();
      if ((c === "[" || /[A-Za-z_]/.test(c)) && atStmtStart) {
        if (c === "[") {
          // Attribute list — only a declaration can carry one, so indexing
          // inside a body is never mistaken for it. The declaration after it
          // is a statement start again.
          advance(skipAttribute(text, i));
          attributeJustEnded = true;
          continue;
        }
        const rest = text.slice(i, i + 400);
        const lineEndIdx = rest.indexOf("\n");
        const restLine = lineEndIdx === -1 ? rest : rest.slice(0, lineEndIdx);

        if (depth === 0 || stack.at(-1)?.kind === "namespace") {
          // The `{` of a block namespace usually sits on the next line, so the
          // match runs on `rest` (which spans lines) — `advance` carries the
          // newline count, keeping every lineStart after it honest.
          const nsM = rest.match(/^namespace\s+([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*(?=[;{])/);
          if (nsM) {
            const segments = nsM[1]!.split(/\s*\.\s*/);
            const next = rest.slice(nsM[0].length).trimStart()[0];
            if (next === ";") {
              // File-scoped: the namespace context for the rest of the file.
              nsStack.length = 0;
              nsStack.push(...segments);
            } else {
              pending.push({ sym: null, nsSegments: segments, depth, opened: false });
            }
            advance(i + nsM[0].length);
            attributeJustEnded = false;
            continue;
          }
        }

        const top = stack.at(-1);
        const typeBodyOk = top?.kind === "type" && top.bodyDepth === depth;
        const declOk = depth === 0 || top?.kind === "namespace" || typeBodyOk;
        if (declOk) {
          const typeM = restLine.match(TYPE_DECL_RE);
          if (typeM) {
            const keyword = typeM[2]!;
            const kind = keyword === "interface" ? "interface" : keyword === "enum" ? "enum" : keyword === "struct" ? "type" : "class";
            const name = typeM[3]!;
            const parent = typeBodyOk ? top!.type!.sym.qualifiedName : null;
            const ns = nsStack.join(".");
            const sym: ParsedSymbol = {
              name,
              kind,
              qualifiedName: parent ? `${parent}.${name}` : ns ? `${ns}.${name}` : name,
              signature: "",
              lineStart: line,
              lineEnd: null,
              exported: /(?:^|\s)public(?=\s)/.test(typeM[1]!),
              parent,
              refs: [],
              memberCalls: []
            };
            symbols.push(sym);
            const brace = findBodyBrace(text, i + typeM[0].length, depth);
            const headerEnd = brace === -1 ? stmtEndAfter(text, i + typeM[0].length) : brace;
            sym.signature = src.slice(i, headerEnd === -1 ? Math.min(text.length, i + restLine.length) : headerEnd).replace(/\s+/g, " ").trim().slice(0, 120);
            if (brace === -1) {
              sym.lineEnd = headerEnd === -1 ? line : lineOf(text, headerEnd);
              advance(headerEnd === -1 ? Math.min(text.length, i + restLine.length) : headerEnd + 1);
            } else {
              pending.push({ sym, nsSegments: null, depth, opened: false });
              advance(brace);
            }
            attributeJustEnded = false;
            continue;
          }
        }

        if (typeBodyOk) {
          const topType = top!.type!;
          const method = matchMethodHeader(text, i);
          if (method) {
            const closeParen = findMatchingParen(text, method.openParen);
            const sym: ParsedSymbol = {
              name: method.name,
              kind: "method",
              qualifiedName: `${topType.sym.qualifiedName}.${method.name}`,
              signature: "",
              lineStart: line,
              lineEnd: null,
              exported: false,
              parent: topType.sym.qualifiedName,
              refs: [],
              memberCalls: []
            };
            if (closeParen !== -1) collectParams(text, method.openParen, closeParen, bind);
            const brace = findBodyBrace(text, method.openParen, depth);
            const headerEnd = brace !== -1 ? brace : closeParen === -1 ? -1 : stmtEndAfter(text, closeParen + 1);
            sym.signature = src.slice(i, headerEnd === -1 ? Math.min(text.length, i + restLine.length) : headerEnd).replace(/\s+/g, " ").trim().slice(0, 120);
            symbols.push(sym);
            if (brace !== -1) {
              pending.push({ sym, nsSegments: null, depth, opened: false });
              advance(brace);
            } else {
              sym.lineEnd = headerEnd === -1 ? line : lineOf(text, headerEnd);
              advance(headerEnd === -1 ? Math.min(text.length, i + restLine.length) : headerEnd + 1);
            }
            attributeJustEnded = false;
            continue;
          }
          const fieldM = restLine.match(FIELD_RE);
          if (fieldM) {
            const type = fieldM[1]!;
            const fieldName = fieldM[2]!;
            const termIdx = i + fieldM[0].length;
            // `=>` after the name is an expression-bodied property, not a
            // field — the graph would rather miss it than mislabel it.
            if (!(text[termIdx] === "=" && text[termIdx + 1] === ">") && !KEYWORDS.has(fieldName) && (!KEYWORDS.has(type) || PRIMITIVE_TYPES.has(type))) {
              topType.fields[fieldName] = type;
              bind(fieldName, type);
            }
            advance(termIdx);
            attributeJustEnded = false;
            continue;
          }
        }
        if (tryLocalDecl()) {
          attributeJustEnded = false;
          continue;
        }
      }

      attributeJustEnded = false;
      i++;
    }

    // Refs for method bodies: slice the blanked text between the header line
    // and the body's closing line, which every pending declaration recorded.
    const lineStarts: number[] = [0];
    for (let k = 0; k < text.length; k++) if (text[k] === "\n") lineStarts.push(k + 1);
    const offsetOfLine = (l: number): number => lineStarts[Math.min(l - 1, lineStarts.length - 1)] ?? 0;
    for (const sym of symbols) {
      if (sym.kind !== "method") continue;
      const from = offsetOfLine(sym.lineStart);
      const to = offsetOfLine((sym.lineEnd ?? sym.lineStart) + 1);
      sym.refs = collectRefs(text, from, to, sym.name);
      sym.memberCalls = collectMemberCalls(text, from, to);
    }

    // Bindings that ride expressions rather than declarations:
    // `x = new T(...)` and `var x = new T(...)` — both shapes are unambiguous
    // in C# and both stay conservative (simple identifier types only).
    let bm: RegExpExecArray | null;
    const newRe = new RegExp(NEW_SOURCE, "g");
    while ((bm = newRe.exec(text))) bind(bm[1]!, bm[2]!);

    // C# has no statement-position harness bodies and no re-export form, so
    // moduleRefs, moduleMemberCalls and reExports stay empty by construction.
    return { symbols, imports, reExports: [], bindings, moduleRefs: [], moduleMemberCalls: [], fields };
  } catch (e) {
    return { symbols: [], imports: [], reExports: [], bindings: {}, moduleRefs: [], moduleMemberCalls: [], fields: {}, parseError: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * C# namespaces map to directories by convention (roadmap Phase 2):
 * `using X.Y;` resolves through the `X/Y/` directory prefix — a "/"-suffixed
 * candidate is a directory prefix the sync expands against indexed files
 * (types.ts). `using static X.Y.Z;` keeps the `static` keyword in the spec
 * (the as-written form — the one way the hook can tell the namespace form
 * from the static-class form, which share the dotted shape), so it ALSO tries
 * `X/Y/Z.cs`, the static class's conventional home file. Everything is
 * repo-relative and the mapping is purely lexical, so `fromFile` plays no
 * part. A spec that is not identifier-dot text returns null and falls back to
 * the default machinery untouched.
 */
function resolveCSharpImport(spec: string, _fromFile: string, _ctx: { repoRoot: string }): string[] | null {
  const staticForm = /^static\s+/.exec(spec);
  const path = (staticForm ? spec.slice(staticForm[0].length) : spec).trim();
  // Validate the raw shape — internal whitespace is prose, never a namespace,
  // so "not a namespace" stays null instead of collapsing into a path.
  if (!/^[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*$/.test(path)) return null;
  const segments = path.split(/\s*\.\s*/);
  const prefix = `${segments.join("/")}/`;
  return staticForm ? [prefix, `${segments.join("/")}.cs`] : [prefix];
}

export const csharpGrammar: LanguageGrammar = {
  id: "csharp",
  label: "C#",
  extensions: [".cs"],
  blank: blankCSharp,
  parse: parseCSharp,
  resolveImport: resolveCSharpImport
};
