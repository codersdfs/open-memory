import type { LanguageGrammar, ParsedFile, ParsedImport, ParsedMemberCall, ParsedSymbol } from "./types.js";

/**
 * Java as a registry grammar (roadmap Phase 2, brace family). The blanker
 * covers the lexical forms the brace tracker must not trip over — line and
 * block comments, string and char literals, and Java 15+ text blocks, which
 * span lines and keep their newlines so offset arithmetic stays honest. The
 * parser fills the same ParsedFile shapes the TS/JS scanner fills, with kinds
 * mapped onto the shared set and nothing invented (Ruling 3): class,
 * interface and enum say themselves, record says class, and a construct that
 * cannot say a kind honestly stays out. Packages map to directories; the
 * import-resolution rule lives on `resolveImport`.
 */

const IDENT_RE = /^[A-Za-z_$][\w$]*/;

/**
 * JLS reserved words plus the boolean literals — the only identifiers a
 * declaration's name position can never hold. Contextual keywords (record,
 * sealed, var, yield) are legal method and field names, so they stay out.
 */
const KEYWORDS = new Set([
  "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
  "continue", "default", "do", "double", "else", "enum", "extends", "false", "final", "finally",
  "float", "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long",
  "native", "new", "null", "package", "private", "protected", "public", "return", "short", "static",
  "strictfp", "super", "switch", "synchronized", "this", "throw", "throws", "transient", "true",
  "try", "void", "volatile", "while"
]);

/** java.lang basics that are identifier-shaped receivers in nearly every file — never call-edge candidates (ADR-0050). */
const GLOBALS = new Set([
  "Boolean", "Byte", "Character", "Class", "Double", "Error", "Exception", "Float", "Integer",
  "Iterable", "Long", "Math", "Number", "Object", "Package", "Process", "ProcessBuilder",
  "Runnable", "Runtime", "RuntimeException", "Short", "StackTraceElement", "StrictMath", "String",
  "StringBuffer", "StringBuilder", "System", "Thread", "ThreadLocal", "Throwable", "Void"
]);

const METHOD_MODIFIERS = new Set([
  "public", "private", "protected", "static", "final", "abstract", "synchronized", "native",
  "strictfp", "default", "transient", "volatile"
]);

/** Primitive type keywords are identifier-shaped types a field may honestly carry (ADR-0050). */
const PRIMITIVE_TYPES = new Set(["boolean", "byte", "char", "double", "float", "int", "long", "short", "void"]);

const ANNOTATION = "@[A-Za-z_$][\\w$]*(?:\\.[\\w$]+)*(?:\\s*\\((?:[^()]|\\([^()]*\\))*\\))?";
const TYPE_MODS = `(?:(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\\s+)|(?:${ANNOTATION}\\s+))*`;
const FIELD_MODS = `(?:(?:(?:public|private|protected|static|final|transient|volatile|strictfp)\\s+)|(?:${ANNOTATION}\\s+))*`;
const TYPE_DECL_RE = new RegExp(`^(${TYPE_MODS})(?:@\\s*)?(class|interface|enum|record)\\s+([A-Za-z_$][\\w$]*)`);
const FIELD_RE = new RegExp(`^${FIELD_MODS}([A-Za-z_$][\\w$]*)\\s+([A-Za-z_$][\\w$]*)\\s*(?=[;=])`);

const IMPORT_SOURCE = "\\bimport\\s+(static\\s+)?([^;]+);";
const IMPORT_SPEC_RE = /^[A-Za-z_$][\w$]*(?:\s*\.\s*(?:[\w$]+|\*))*$/;
const NEW_BINDING_SOURCE = "\\b([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+([A-Za-z_$][\\w$]*)\\s*\\(";
const FOR_EACH_SOURCE = "\\bfor\\s*\\(\\s*(?:final\\s+)?([A-Za-z_$][\\w$]*)\\s+([A-Za-z_$][\\w$]*)\\s*:";

/**
 * Replace comments, string and char literals and text blocks with spaces,
 * preserving length and newlines, so offsets into the blanked text index the
 * original. Text-block newlines stay put precisely because a text block may
 * span lines — line counts and every lineStart after one must survive.
 */
function blankJava(src: string): string {
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
      let j = i + 3;
      let close = -1;
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === '"' && src[j + 1] === '"' && src[j + 2] === '"') { close = j; break; }
        j++;
      }
      const to = close === -1 ? src.length : close + 3;
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

const skipAnnotation = (text: string, at: number): number => {
  let k = at + 1;
  const nameM = IDENT_RE.exec(text.slice(k, k + 120));
  if (!nameM) return at + 1;
  k += nameM[0].length;
  while (k < text.length && text[k] === ".") {
    const seg = IDENT_RE.exec(text.slice(k + 1, k + 121));
    if (!seg) break;
    k += 1 + seg[0].length;
  }
  while (k < text.length && /\s/.test(text[k]!)) k++;
  if (text[k] === "(") {
    let d = 0;
    for (; k < text.length; k++) {
      const c = text[k]!;
      if (c === "(" || c === "[" || c === "{") d++;
      else if (c === ")" || c === "]" || c === "}") {
        d--;
        if (d === 0) { k++; break; }
      }
    }
  }
  return k;
};

const findMatchingParen = (text: string, open: number): number => {
  let d = 0;
  for (let k = open; k < text.length; k++) {
    const c = text[k]!;
    if (c === "@") { k = skipAnnotation(text, k) - 1; continue; }
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") {
      d--;
      if (d === 0 && c === ")") return k;
    }
  }
  return -1;
};

const stmtEndAfter = (text: string, from: number): number => {
  let d = 0;
  for (let k = from + 1; k < text.length; k++) {
    const c = text[k]!;
    if (c === "(" || c === "[" || c === "{" || c === "<") d++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") d--;
    else if (c === ";" && d === 0) return k;
    else if ((c === "{" || c === "}") && d === 0) return -1;
  }
  return -1;
};

/**
 * Header walk for one candidate method/constructor at a class-body statement
 * position: modifiers, inline annotations and type-params/return-type tokens
 * may precede the name, and the name is whatever identifier sits right before
 * the first `(`. Anything else a statement can start with — an `=`, `;`, `{`
 * or a keyword name — bails, so fields, initializers and control statements
 * never masquerade as methods (ADR-0050).
 */
const matchMethodHeader = (text: string, start: number): { name: string; openParen: number } | null => {
  let k = start;
  while (k < text.length) {
    const c = text[k]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { k++; continue; }
    if (c === "=" || c === ";" || c === "{" || c === "}") return null;
    if (c === "@") { k = skipAnnotation(text, k); continue; }
    if (c === "<") {
      let ang = 0;
      while (k < text.length) {
        const d = text[k]!;
        if (d === "<") ang++;
        else if (d === ">") { ang--; if (ang === 0) { k++; break; } }
        else if (d === "(" || d === ";" || d === "=" || d === "{") return null;
        k++;
      }
      if (ang !== 0) return null;
      continue;
    }
    if (c === "[" || c === "]" || c === "?" || c === "," || c === "." || c === "&") { k++; continue; }
    const wordM = IDENT_RE.exec(text.slice(k, k + 120));
    if (!wordM) return null;
    const word = wordM[0];
    if (METHOD_MODIFIERS.has(word)) { k += word.length; continue; }
    let p = k + word.length;
    while (p < text.length && /\s/.test(text[p]!)) p++;
    if (text[p] === "(") {
      if (KEYWORDS.has(word)) return null;
      return { name: word, openParen: p };
    }
    k = p;
  }
  return null;
};

const bindParam = (part: string, bind: (name: string, type: string) => void): void => {
  // Conservative simple-identifier types only: generics, qualified names,
  // arrays and varargs never bind (ADR-0050's rule).
  if (part.includes("<") || part.includes("[") || part.includes(".")) return;
  const tokens: string[] = [];
  for (let k = 0; k < part.length; ) {
    const c = part[k]!;
    if (/\s/.test(c)) { k++; continue; }
    if (c === "@") { k = skipAnnotation(part, k); continue; }
    if (/^final(?![\w$])/.test(part.slice(k))) { k += 5; continue; }
    const w = IDENT_RE.exec(part.slice(k));
    if (!w) { k++; continue; }
    tokens.push(w[0]);
    k += w[0].length;
  }
  if (tokens.length === 2) {
    const type = tokens[0]!;
    const name = tokens[1]!;
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
    if (c === "@") { cur += " "; k = skipAnnotation(inner, k) - 1; continue; }
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

interface TypeFrame {
  sym: ParsedSymbol;
  bodyDepth: number;
  /** Between `enum E {` and the constants' closing `;`, bare identifiers are constants, not methods. */
  constantList: boolean;
}

interface PendingDecl {
  sym: ParsedSymbol;
  depth: number;
  opened: boolean;
}

interface BraceFrame {
  owner: ParsedSymbol | null;
}

/**
 * Parse one Java source file. Never throws for parseable-looking code — a
 * structural surprise surfaces as `parseError` and the sync moves on (ADR-0050).
 *
 * The package clause is the one piece of file-level state Java adds, and it is
 * the resolution base for every import this file writes: imports are
 * package-absolute, so `resolveImport` maps a dotted spec straight onto
 * directory paths and the importing file's own directory plays no part.
 * ParsedFile carries no package field (the Phase 2 shapes are fixed), so the
 * clause is deliberately kept out of every derived collection — qualified
 * names stay nesting-only (`Outer.Inner`) and the module row derives from the
 * file path, which already encodes the package.
 */
function parseJava(src: string, blanked: string): ParsedFile {
  try {
    const text = blanked;
    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    const bindings: Record<string, string> = {};
    const fields: Record<string, Record<string, string>> = {};

    const bind = (name: string, type: string): void => {
      if (KEYWORDS.has(name) || KEYWORDS.has(type)) return;
      bindings[name] = type;
    };

    // Imports are statement scans on the blanked text (comments, strings and
    // text blocks cannot plant one). The specifier is identifier-and-dot text,
    // so unlike the TS scanner no original-slice read is needed. Static
    // imports keep the class path as the spec and the member as the name;
    // wildcards keep their `.*` and name `*` (resolveImport maps them).
    const pushImport = (p: ParsedImport): void => {
      const dup = imports.find((q) => q.spec === p.spec && q.names.length === p.names.length && q.names.every((n, idx) => n === p.names[idx]));
      if (dup) return;
      imports.push(p);
    };
    const importRe = new RegExp(IMPORT_SOURCE, "g");
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(text))) {
      const isStatic = Boolean(m[1]);
      const raw = m[2]!.replace(/\s+/g, "");
      if (!IMPORT_SPEC_RE.test(raw)) continue;
      const dot = raw.lastIndexOf(".");
      if (raw.endsWith(".*")) {
        pushImport({ spec: isStatic ? raw.slice(0, -2) : raw, names: ["*"], namespace: null, defaultName: null, sideEffect: false, isExport: false });
      } else if (isStatic) {
        if (dot === -1) continue;
        pushImport({ spec: raw.slice(0, dot), names: [raw.slice(dot + 1)], namespace: null, defaultName: null, sideEffect: false, isExport: false });
      } else {
        pushImport({ spec: raw, names: [raw.slice(dot + 1)], namespace: null, defaultName: null, sideEffect: false, isExport: false });
      }
    }

    const stack: BraceFrame[] = [];
    const pending: PendingDecl[] = [];
    const types: TypeFrame[] = [];
    let depth = 0;
    let line = 1;
    let i = 0;
    let annoJustEnded = false;

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
          pd.sym.lineEnd = line;
          const idx = types.findIndex((t) => t.sym === pd.sym);
          if (idx !== -1) types.splice(idx, 1);
          pending.splice(p, 1);
        }
      }
    };

    // `Foo bar = baz;` and `Foo bar;` — the two-identifier statement shape is
    // a declaration and nothing else in Java, so it binds conservatively.
    const tryLocalDecl = (): boolean => {
      let k = i;
      while (k < text.length && /\s/.test(text[k]!)) k++;
      if (/^final(?![\w$])/.test(text.slice(k))) k += 5;
      while (k < text.length && /\s/.test(text[k]!)) k++;
      const w1 = IDENT_RE.exec(text.slice(k, k + 120));
      if (!w1 || KEYWORDS.has(w1[0])) return false;
      let p = k + w1[0].length;
      while (p < text.length && /\s/.test(text[p]!)) p++;
      const w2 = IDENT_RE.exec(text.slice(p, p + 120));
      if (!w2 || KEYWORDS.has(w2[0])) return false;
      let q = p + w2[0].length;
      while (q < text.length && /\s/.test(text[q]!)) q++;
      const nc = text[q];
      if (nc === ";" || nc === "=") {
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
        annoJustEnded = false;
        const claimant = pending.find((pd) => !pd.opened && depth === pd.depth);
        if (claimant) {
          claimant.opened = true;
          stack.push({ owner: claimant.sym });
          if (claimant.sym.kind !== "method") {
            types.push({ sym: claimant.sym, bodyDepth: depth + 1, constantList: claimant.sym.kind === "enum" });
          }
          depth++;
          i++;
          continue;
        }
        stack.push({ owner: null });
        depth++;
        i++;
        continue;
      }
      if (c === "}") {
        annoJustEnded = false;
        const frame = stack.pop();
        depth = Math.max(0, depth - 1);
        if (frame?.owner && frame.owner.lineEnd === null) frame.owner.lineEnd = line;
        closePending();
        i++;
        continue;
      }
      if (c === ";") {
        annoJustEnded = false;
        const top = types.at(-1);
        if (top && depth === top.bodyDepth) top.constantList = false;
        i++;
        continue;
      }
      if (c === "@" && !/^\s*interface\b/.test(text.slice(i + 1, i + 60))) {
        advance(skipAnnotation(text, i));
        annoJustEnded = true;
        continue;
      }

      const atStmtStart = annoJustEnded || (() => {
        let j = i - 1;
        while (j >= 0 && /[ \t\r\n]/.test(text[j]!)) j--;
        return j < 0 || ";}{".includes(text[j]!);
      })();
      if ((c === "@" || /[A-Za-z_$]/.test(c)) && atStmtStart) {
        const rest = text.slice(i, i + 400);
        const lineEndIdx = rest.indexOf("\n");
        const restLine = lineEndIdx === -1 ? rest : rest.slice(0, lineEndIdx);

        const typeM = restLine.match(TYPE_DECL_RE);
        if (typeM && depth === (types.at(-1)?.bodyDepth ?? 0)) {
          const kind = typeM[2] === "interface" ? "interface" : typeM[2] === "enum" ? "enum" : "class";
          const name = typeM[3]!;
          const parent = types.at(-1)?.sym.qualifiedName ?? null;
          const sym: ParsedSymbol = {
            name,
            kind,
            qualifiedName: parent ? `${parent}.${name}` : name,
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
          const headerEnd = brace === -1 ? Math.min(text.length, i + restLine.length) : brace;
          sym.signature = src.slice(i, headerEnd).replace(/\s+/g, " ").trim().slice(0, 120);
          if (brace === -1) {
            sym.lineEnd = line;
            advance(headerEnd);
          } else {
            pending.push({ sym, depth, opened: false });
            advance(brace);
          }
          annoJustEnded = false;
          continue;
        }

        if (types.length && depth === types.at(-1)!.bodyDepth) {
          const top = types.at(-1)!;
          if (top.constantList) {
            const wordM = IDENT_RE.exec(restLine);
            if (wordM) {
              advance(i + wordM[0].length);
              annoJustEnded = false;
              continue;
            }
          }
          const method = matchMethodHeader(text, i);
          if (method) {
            const name = method.name;
            const closeParen = findMatchingParen(text, method.openParen);
            const sym: ParsedSymbol = {
              name,
              kind: "method",
              qualifiedName: `${top.sym.qualifiedName}.${name}`,
              signature: "",
              lineStart: line,
              lineEnd: null,
              exported: false,
              parent: top.sym.qualifiedName,
              refs: [],
              memberCalls: []
            };
            if (closeParen !== -1) collectParams(text, method.openParen, closeParen, bind);
            const brace = closeParen === -1 ? -1 : findBodyBrace(text, method.openParen, depth);
            let headerEnd = Math.min(text.length, i + restLine.length);
            if (brace !== -1) headerEnd = brace;
            else if (closeParen !== -1) {
              const semi = stmtEndAfter(text, closeParen);
              if (semi !== -1) headerEnd = semi;
              else {
                const nl = text.indexOf("\n", closeParen);
                headerEnd = nl === -1 ? text.length : nl;
              }
            }
            sym.signature = src.slice(i, headerEnd).replace(/\s+/g, " ").trim().slice(0, 120);
            symbols.push(sym);
            if (brace !== -1) {
              pending.push({ sym, depth, opened: false });
              advance(brace);
            } else {
              sym.lineEnd = lineOf(text, headerEnd);
              advance(Math.min(text.length, headerEnd + 1));
            }
            annoJustEnded = false;
            continue;
          }
          const fieldM = restLine.match(FIELD_RE);
          if (fieldM) {
            const type = fieldM[1]!;
            const fieldName = fieldM[2]!;
            if (!KEYWORDS.has(fieldName) && (!KEYWORDS.has(type) || PRIMITIVE_TYPES.has(type))) {
              (fields[top.sym.name] ??= {})[fieldName] = type;
              bind(fieldName, type);
            }
            advance(i + fieldM[0].length);
            annoJustEnded = false;
            continue;
          }
        }
        if (tryLocalDecl()) {
          annoJustEnded = false;
          continue;
        }
      }

      annoJustEnded = false;
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

    // Bindings that ride expressions rather than declarations: `x = new T(...)`
    // and the enhanced-for's `for (T x : ...)` — both shapes are unambiguous
    // in Java and both stay conservative (simple identifier types only).
    let bm: RegExpExecArray | null;
    const newRe = new RegExp(NEW_BINDING_SOURCE, "g");
    while ((bm = newRe.exec(text))) bind(bm[1]!, bm[2]!);
    const forEachRe = new RegExp(FOR_EACH_SOURCE, "g");
    while ((bm = forEachRe.exec(text))) bind(bm[2]!, bm[1]!);

    // Java's top level holds only the package clause and declarations — there
    // is no statement-position body a module node could collect, and Java has
    // no re-export form, so both collections stay empty by construction.
    return { symbols, imports, reExports: [], bindings, moduleRefs: [], moduleMemberCalls: [], fields };
  } catch (e) {
    return { symbols: [], imports: [], reExports: [], bindings: {}, moduleRefs: [], moduleMemberCalls: [], fields: {}, parseError: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Java packages map to directories: `com.x.Util` lives at `com/x/Util.java`
 * relative to the repo root. The package clause — not the importing file's
 * directory — is the resolution base, so the mapping is purely lexical and
 * `fromFile` plays no part. A trailing `.*` is a wildcard member import; its
 * candidate is the package's directory prefix, which the sync treats as a
 * prefix (types.ts: a candidate ending "/" is a directory prefix).
 */
function resolveJavaImport(spec: string, _fromFile: string, _ctx: { repoRoot: string }): string[] | null {
  const segments = spec.split(".");
  const wildcard = segments.at(-1) === "*";
  const real = wildcard ? segments.slice(0, -1) : segments;
  if (real.length === 0) return null;
  if (!real.every((s) => /^[A-Za-z_$][\w$]*$/.test(s))) return null;
  if (wildcard) return [`${real.join("/")}/`];
  return [`${real.join("/")}.java`];
}

export const javaGrammar: LanguageGrammar = {
  id: "java",
  label: "Java",
  extensions: [".java"],
  blank: blankJava,
  parse: parseJava,
  resolveImport: resolveJavaImport
};
