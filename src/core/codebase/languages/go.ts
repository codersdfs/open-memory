import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageGrammar, ParsedFile, ParsedImport, ParsedSymbol } from "./types.js";

/**
 * Go as the first brace-family grammar after TS/JS (roadmap Phase 2): the same
 * structural-scanning bargain as `parse.ts` — one pass blanks comments and
 * strings length-preserving, a second walks declarations. Go's simplicity helps
 * (declarations only live at top level, bodies are always braced) and its traps
 * are specific:
 *   - raw strings (backquotes) span lines with no escapes — blanking must keep
 *     every newline between them or all line numbers after one drift;
 *   - string and rune delimiters stay VISIBLE in the blanked copy, because the
 *     parser reads statement extents from that copy: a statement ending in a
 *     hidden quote (`const s = "x"`) would never terminate and would swallow
 *     the next declaration. Comments hide completely — their extent IS the
 *     newline, which survives;
 *   - kinds map onto the SHARED `CodeSymbolKind` set per the Phase 2 ledger
 *     ruling: struct → `type`, interface → `interface`, other type shapes →
 *     `type`. No kinds are invented, and what this scanner cannot say honestly
 *     it leaves out rather than lying (grouped `type (...)` declarations and
 *     interface method sets produce no symbols, never guessed ones).
 */

/** Go keywords — never ref candidates (the TS scanner keeps the same rule). */
const KEYWORDS = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough",
  "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range",
  "return", "select", "struct", "switch", "type", "var"
]);

/** Predeclared identifiers and basic types — types are not calls. */
const PREDECLARED = new Set([
  "any", "append", "bool", "byte", "cap", "close", "comparable", "complex", "complex64",
  "complex128", "copy", "delete", "error", "false", "float32", "float64", "imag", "int",
  "int8", "int16", "int32", "int64", "iota", "len", "make", "new", "nil", "panic", "print",
  "println", "real", "recover", "rune", "string", "true", "uint", "uint8", "uint16", "uint32",
  "uint64", "uintptr"
]);

const REF_EXCLUDE = new Set([...KEYWORDS, ...PREDECLARED]);

/**
 * Length-preserving blanking (roadmap Phase 2). Comments hide entirely; string
 * literals hide their content but keep both delimiters visible (see the header
 * — statement extents are read from this copy). A raw newline inside an
 * interpreted string or rune (illegal Go) ends the literal instead of eating
 * the file, the same courtesy `blankSource` extends to unterminated strings.
 */
function blankGo(src: string): string {
  const out = src.split("");
  let i = 0;
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
      // Interpreted string / rune literal: escapes hide their next char.
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        j++;
      }
      const terminated = j < src.length && src[j] === c;
      blank(i + 1, j);
      i = terminated ? j + 1 : j;
      continue;
    }
    if (c === "`") {
      // Raw string: no escapes, may span lines. The interior blanks to spaces
      // with every newline preserved; both backquotes stay visible.
      const end = src.indexOf("`", i + 1);
      blank(i + 1, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    out[i] = c;
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
 * First `{` at bracket-depth zero — the body brace of a func/method/struct/
 * interface. Braces inside parens or brackets (a `struct{...}` parameter type)
 * belong to the signature, never the body.
 */
const findBodyBrace = (text: string, from: number): number => {
  let depth = 0;
  for (let k = from; k < text.length; k++) {
    const c = text[k]!;
    if (c === "{" && depth === 0) return k;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
  }
  return -1;
};

/**
 * End of a braceless declaration (`const A = 1`, `var x int`, `type ID int`):
 * the first newline or `;` at bracket-depth zero — unless the value is still
 * open inside `(`/`[`/`{` (composite literals and wrapped expressions span
 * lines) or the line ends in an operator (`=` at the wrap), or the scan is
 * inside a raw string, whose visible backquotes are parity-tracked the way the
 * blanker leaves them visible.
 */
const stmtEnd = (text: string, from: number): number => {
  let depth = 0;
  let lastSig = "";
  let inRaw = false;
  for (let k = from; k < text.length; k++) {
    const c = text[k]!;
    if (c === "`") {
      inRaw = !inRaw;
      lastSig = c;
      continue;
    }
    if (depth === 0 && !inRaw && (c === "\n" || c === ";")) {
      if ("+-*/%=<>&|^,:!".includes(lastSig)) continue;
      return k;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (!/\s/.test(c)) lastSig = c;
  }
  return text.length;
};

/**
 * End of one grouped const/var spec: the first newline or `;` at bracket-depth
 * zero that is not inside a raw string, or the group's closing paren. The same
 * extent rules as `stmtEnd`, bounded by the group.
 */
const specEnd = (text: string, from: number, limit: number): number => {
  let depth = 0;
  let inRaw = false;
  for (let k = from; k < limit; k++) {
    const c = text[k]!;
    if (c === "`") {
      inRaw = !inRaw;
      continue;
    }
    if (depth === 0 && !inRaw && (c === "\n" || c === ";")) return k;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return k;
      depth--;
    }
  }
  return limit;
};

/**
 * Names of one const/var spec: the identifiers left of the first `=`, or the
 * first word of each comma-separated chunk when there is no value (`var x int`,
 * group-`iota` continuations). The blanked slice drives this, so comments and
 * string contents cannot plant names.
 */
const specNames = (spec: string): string[] => {
  const eq = spec.indexOf("=");
  const lhs = eq === -1 ? spec : spec.slice(0, eq);
  const names: string[] = [];
  for (const chunk of lhs.split(",")) {
    const m = /^\s*([A-Za-z_]\w*)/.exec(chunk);
    if (m) names.push(m[1]!);
  }
  return names;
};

/**
 * Identifiers inside one body — INCLUDING selector tails. This is the Go half
 * of the bare-ref name-match cascade: every call is bare (`helper(x)`) or
 * selector-based (`util.Helper(x)`, `recv.Method(x)`), and with no receiver
 * types to bind there are no memberCalls — the tail name is the only candidate
 * the shared cascade can match. The one-exported-owner rule caps the heuristic:
 * two packages exporting `Helper` build no edge (sync's ambiguity rule).
 */
const collectRefs = (slice: string, exclude: ReadonlySet<string>): string[] => {
  const refs = new Set<string>();
  for (const m of slice.matchAll(/[A-Za-z_]\w*/g)) {
    const name = m[0];
    if (exclude.has(name) || REF_EXCLUDE.has(name) || name.length < 2) continue;
    refs.add(name);
  }
  return [...refs];
};

/**
 * Receiver type from a method's receiver clause: the last token of
 * `(r *List[T])` is the type; strip the pointer star and the generic
 * instantiation so the parent is the plain declared name (`List`), matching
 * `qualifiedName` "Receiver.Name" against how the struct itself is recorded.
 * A receiver that is not `T` or `*T` yields null — the method is left out
 * rather than misfiled.
 */
const receiverType = (inner: string): string | null => {
  const tokens = inner.trim().split(/\s+/);
  if (!tokens[tokens.length - 1]) return null;
  let type = tokens[tokens.length - 1]!;
  type = type.replace(/^\*/, "");
  const generic = type.indexOf("[");
  if (generic !== -1) type = type.slice(0, generic);
  return /^[A-Za-z_]\w*$/.test(type) ? type : null;
};

/** Go visibility is the name's case: capital first letter = exported. */
const isExported = (name: string): boolean => /^[A-Z]/.test(name);

/**
 * The identifier `import "net/http"` binds: Go names the package after the
 * path's last segment. Only identifier-shaped segments bind honestly —
 * `yaml.v2` rides a major-suffix convention the path cannot reveal, so it
 * binds nothing rather than guessing.
 */
const defaultPackageName = (spec: string): string | null => {
  const last = spec.split("/").pop() ?? "";
  return /^[A-Za-z_]\w*$/.test(last) ? last : null;
};

/**
 * One import statement/spec line → ParsedImport. Go imports bind the whole
 * package under one identifier, so `names` stays empty and `namespace` carries
 * the binding: an explicit alias when one is written, otherwise the path's
 * default package name (what lets the sync build the module→module edge for a
 * plain in-repo import). `_ "path"` is the side-effect form; `. "path"` binds
 * every name and reveals none, so it records the statement but no binding that
 * could resolve. The alias token is read from the BLANKED slice (same offsets),
 * so a trailing comment cannot pose as one.
 */
const importEntry = (entrySrc: string, entryBlanked: string): ParsedImport | null => {
  const specM = /"([^"]*)"/.exec(entrySrc);
  if (!specM || !specM[1]) return null;
  const spec = specM[1];
  const before = entryBlanked.slice(0, specM.index).trim();
  if (before === "_") {
    return { spec, names: [], namespace: null, defaultName: null, sideEffect: true, isExport: false };
  }
  if (before === "") {
    return { spec, names: [], namespace: defaultPackageName(spec), defaultName: null, sideEffect: false, isExport: false };
  }
  if (before === ".") {
    return { spec, names: [], namespace: null, defaultName: null, sideEffect: false, isExport: false };
  }
  if (!/^[A-Za-z_]\w*$/.test(before)) return null;
  return { spec, names: [], namespace: before, defaultName: null, sideEffect: false, isExport: false };
};

/**
 * Parse one Go source file into the shared shapes. `blanked` is sync's
 * precomputed `blank(src)`; raw literals (import specifiers, signatures) are
 * read from `src` at the same offsets, the established pattern (ADR-0050).
 * Never throws for parseable-looking code — a structural surprise surfaces as
 * `parseError` and the sync moves on.
 */
function parseGo(src: string, blanked: string): ParsedFile {
  try {
    const text = blanked;
    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    let line = 1;
    let i = 0;

    // Jump helper: every branch that leaps `i` forward must carry the newline
    // count with it, or every lineStart after a multi-line signature drifts
    // and body refs slice the wrong lines (the bug ADR-0050's own repo exposed).
    const advance = (to: number): void => {
      for (let k = i; k < to && k < text.length; k++) {
        if (text[k] === "\n") line++;
      }
      i = Math.min(Math.max(to, i), text.length);
    };

    const endOfLine = (from: number): number => {
      const nl = text.indexOf("\n", from);
      return nl === -1 ? text.length : nl;
    };

    while (i < text.length) {
      const c = text[i]!;
      if (c === "\n") {
        line++;
        i++;
        continue;
      }
      if (!/[A-Za-z_]/.test(c)) {
        i++;
        continue;
      }

      const rest = text.slice(i, i + 400);

      // Package clause: the file's package is already carried by its path plus
      // the go.mod module prefix; a `package` pseudo-symbol would duplicate it.
      if (/^package\b/.test(rest)) {
        advance(endOfLine(i));
        continue;
      }

      if (/^import\b/.test(rest)) {
        let k = i + 6;
        while (k < text.length && /\s/.test(text[k]!)) k++;
        if (text[k] === "(") {
          const closeParen = matchBracket(text, k, "(", ")");
          if (closeParen === -1) {
            advance(endOfLine(i));
            continue;
          }
          advance(k + 1);
          while (i < closeParen) {
            if (/[\s;]/.test(text[i]!)) {
              advance(i + 1);
              continue;
            }
            let end = closeParen;
            for (let q = i; q < closeParen; q++) {
              if (text[q] === "\n" || text[q] === ";") {
                end = q;
                break;
              }
            }
            const entry = importEntry(src.slice(i, end), text.slice(i, end));
            if (entry) imports.push(entry);
            advance(end);
          }
          advance(closeParen + 1);
          continue;
        }
        const end = stmtEnd(text, i);
        const entry = importEntry(src.slice(k, end), text.slice(k, end));
        if (entry) imports.push(entry);
        advance(end);
        continue;
      }

      if (/^func\b/.test(rest)) {
        const startLine = line;
        let k = i + 4;
        while (k < text.length && /\s/.test(text[k]!)) k++;
        let isMethod = false;
        let name = "";
        let parent: string | null = null;
        if (text[k] === "(") {
          const closeParen = matchBracket(text, k, "(", ")");
          if (closeParen === -1) {
            advance(endOfLine(i));
            continue;
          }
          parent = receiverType(text.slice(k + 1, closeParen));
          let after = closeParen + 1;
          while (after < text.length && /\s/.test(text[after]!)) after++;
          const nameM = /^[A-Za-z_]\w*/.exec(text.slice(after));
          if (!nameM || !parent) {
            advance(endOfLine(i));
            continue;
          }
          isMethod = true;
          name = nameM[0];
          k = after + nameM[0].length;
        } else {
          const nameM = /^[A-Za-z_]\w*/.exec(text.slice(k));
          if (!nameM) {
            advance(endOfLine(i));
            continue;
          }
          name = nameM[0];
          k += nameM[0].length;
        }
        // Type-parameter bracket straight after the name (`func Map[T any](...)`).
        if (text[k] === "[") {
          const closeBracket = matchBracket(text, k, "[", "]");
          if (closeBracket === -1) {
            advance(endOfLine(i));
            continue;
          }
          k = closeBracket + 1;
        }
        const bodyBrace = findBodyBrace(text, k);
        const sym: ParsedSymbol = {
          name,
          kind: isMethod ? "method" : "function",
          qualifiedName: isMethod ? `${parent}.${name}` : name,
          signature: src
            .slice(i, bodyBrace === -1 ? endOfLine(i) : bodyBrace)
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120),
          lineStart: startLine,
          lineEnd: null,
          exported: isExported(name),
          parent: isMethod ? parent : null,
          refs: [],
          memberCalls: []
        };
        symbols.push(sym);
        if (bodyBrace === -1) {
          advance(endOfLine(i));
          continue;
        }
        const closeBrace = matchBracket(text, bodyBrace, "{", "}");
        if (closeBrace === -1) {
          // Unterminated body: the symbol stays open (lineEnd null) and the
          // walk resumes after the header — malformed Go is not our brief.
          advance(endOfLine(bodyBrace));
          continue;
        }
        sym.refs = collectRefs(text.slice(bodyBrace + 1, closeBrace), new Set([name]));
        advance(closeBrace + 1);
        sym.lineEnd = line;
        continue;
      }

      if (/^type\b/.test(rest)) {
        const startLine = line;
        const typeM = /^type\s+([A-Za-z_]\w*)/.exec(rest);
        if (!typeM) {
          // `type (` grouped declarations are not extracted at v1 — the group's
          // lines produce no symbols, never guessed ones (see the header).
          advance(endOfLine(i));
          continue;
        }
        const name = typeM[1]!;
        let k = i + typeM[0].length;
        while (k < text.length && /\s/.test(text[k]!)) k++;
        if (text[k] === "=") {
          k++;
          while (k < text.length && /\s/.test(text[k]!)) k++;
        }
        if (text[k] === "[") {
          const closeBracket = matchBracket(text, k, "[", "]");
          if (closeBracket === -1) {
            advance(endOfLine(i));
            continue;
          }
          k = closeBracket + 1;
        }
        const kwM = /^(struct|interface)\b/.exec(text.slice(k));
        const kind: ParsedSymbol["kind"] = kwM?.[1] === "interface" ? "interface" : "type";
        const sym: ParsedSymbol = {
          name,
          kind,
          qualifiedName: name,
          signature: "",
          lineStart: startLine,
          lineEnd: null,
          exported: isExported(name),
          parent: null,
          refs: [],
          memberCalls: []
        };
        symbols.push(sym);
        if (kwM) {
          const bodyBrace = findBodyBrace(text, k);
          sym.signature = src
            .slice(i, bodyBrace === -1 ? endOfLine(i) : bodyBrace)
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
          if (bodyBrace === -1) {
            advance(endOfLine(i));
            continue;
          }
          const closeBrace = matchBracket(text, bodyBrace, "{", "}");
          if (closeBrace === -1) {
            advance(endOfLine(bodyBrace));
            continue;
          }
          advance(closeBrace + 1);
          sym.lineEnd = line;
          continue;
        }
        // Alias or defined type: braceless, extent = statement end.
        const end = stmtEnd(text, i);
        sym.signature = src.slice(i, end).replace(/\s+/g, " ").trim().slice(0, 120);
        advance(end);
        sym.lineEnd = line;
        continue;
      }

      const kwM = /^(const|var)\b/.exec(rest);
      if (kwM) {
        const startLine = line;
        const keyword = kwM[1]!;
        let k = i + keyword.length;
        while (k < text.length && /\s/.test(text[k]!)) k++;
        if (text[k] === "(") {
          const closeParen = matchBracket(text, k, "(", ")");
          if (closeParen === -1) {
            advance(endOfLine(i));
            continue;
          }
          advance(k + 1);
          while (i < closeParen) {
            if (/[\s;]/.test(text[i]!)) {
              advance(i + 1);
              continue;
            }
            const specLine = line;
            const end = specEnd(text, i, closeParen);
            const specSlice = text.slice(i, end);
            const names = specNames(specSlice).filter((n) => n !== "_");
            advance(end);
            if (names.length > 0) {
              const signature = src.slice(i, end).replace(/\s+/g, " ").trim().slice(0, 120);
              const exclude = new Set(names);
              for (const specName of names) {
                symbols.push({
                  name: specName,
                  kind: "const",
                  qualifiedName: specName,
                  signature,
                  lineStart: specLine,
                  lineEnd: line,
                  exported: isExported(specName),
                  parent: null,
                  refs: collectRefs(specSlice, exclude),
                  memberCalls: []
                });
              }
            }
          }
          advance(closeParen + 1);
          continue;
        }
        const end = stmtEnd(text, i);
        const specSlice = text.slice(k, end);
        const names = specNames(specSlice).filter((n) => n !== "_");
        advance(end);
        if (names.length > 0) {
          const signature = src.slice(i, end).replace(/\s+/g, " ").trim().slice(0, 120);
          const exclude = new Set(names);
          for (const specName of names) {
            symbols.push({
              name: specName,
              kind: "const",
              qualifiedName: specName,
              signature,
              lineStart: startLine,
              lineEnd: line,
              exported: isExported(specName),
              parent: null,
              refs: collectRefs(specSlice, exclude),
              memberCalls: []
            });
          }
        }
        continue;
      }

      // Not a declaration keyword — skip the whole identifier.
      const wordM = /^[A-Za-z_]\w*/.exec(text.slice(i));
      advance(i + (wordM ? wordM[0].length : 1));
    }

    // `bindings`/`fields`/`moduleRefs`/`moduleMemberCalls` stay empty BY DESIGN:
    // Go has no structural type annotations, so there are no file-scope
    // identifier→type bindings to read, no receiver types to resolve member
    // calls through, and no test-harness callback shape to harvest. Every call
    // — bare or selector-based — rides the bare-ref name-match cascade via the
    // `refs` each symbol carries; the shared one-owner ambiguity rule caps it.
    return { symbols, imports, reExports: [], bindings: {}, moduleRefs: [], moduleMemberCalls: [], fields: {} };
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
 * Specifier → candidate repo-relative paths (roadmap Phase 2). Go import paths
 * are module-absolute, so this reads `go.mod` at the repo root for the
 * `module X` line — line comments tolerated — and maps an in-repo spec to its
 * package DIRECTORY prefix (`example.com/proj/pkg/util` → `pkg/util/`): a
 * candidate ending in `/` means directory prefix, and the sync matches the
 * package's files against it. The module root itself returns null — `["/"]`
 * would prefix-match every file in the repo and invent an edge to all of them.
 * Dot-relative and non-repo specs (standard library, other modules) return null
 * and fall through to the default machinery, which builds nothing for them.
 * The importing file plays no part: Go paths are module-absolute, not relative.
 *
 * COST, stated honestly: this reads `go.mod` once per import statement — a few
 * bytes off the OS page cache each time. At v1 scale (whole-repo indexes,
 * thousands of imports) that is noise; a per-repoRoot memo is the obvious later
 * optimization and is deliberately not pre-built here.
 */
function resolveGoImport(spec: string, fromFile: string, ctx: { repoRoot: string }): string[] | null {
  void fromFile;
  let goMod: string;
  try {
    goMod = readFileSync(join(ctx.repoRoot, "go.mod"), "utf8");
  } catch {
    return null;
  }
  const cleaned = goMod.replace(/^\uFEFF/, "").replace(/\/\/[^\n]*/g, "");
  const moduleM = /^\s*module\s+(\S+)/m.exec(cleaned);
  if (!moduleM) return null;
  let modulePath = moduleM[1]!;
  if (modulePath.startsWith('"') && modulePath.endsWith('"') && modulePath.length >= 2) {
    modulePath = modulePath.slice(1, -1);
  }
  if (spec.startsWith(modulePath + "/")) {
    const remainder = spec.slice(modulePath.length + 1);
    return remainder ? [remainder + "/"] : null;
  }
  return null;
}

export const goGrammar: LanguageGrammar = {
  id: "go",
  label: "Go",
  extensions: [".go"],
  blank: blankGo,
  parse: parseGo,
  resolveImport: resolveGoImport
};
