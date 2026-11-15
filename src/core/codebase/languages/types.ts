import type { CodeSymbolKind } from "../types.js";

/**
 * The parsed shapes every language grammar fills (roadmap Phase 2). They were
 * the TS/JS scanner's output types (ADR-0050); they become the registry's
 * contract unchanged, because the sync builds rows and edges from exactly this
 * vocabulary — a new language lands by filling the same shapes, never by
 * growing a second writer beside `sync.ts`.
 */

export interface ParsedImport {
  /** Import specifier as written (`./utils.js`), not resolved. */
  spec: string;
  names: string[];
  namespace: string | null;
  defaultName: string | null;
  sideEffect: boolean;
  /** True when this is `export { x } from "..."` / `export * from "..."`. */
  isExport: boolean;
  /** True for `import("./x")` and `require("./x")` call forms (ADR-0050). */
  dynamic?: boolean;
}

export interface ParsedMemberCall {
  receiver: string;
  method: string;
  /** For two-level chains `receiver.field.method(`: the field name hopped through (ADR-0050). */
  via?: string;
}

export interface ParsedSymbol {
  name: string;
  kind: Exclude<CodeSymbolKind, "module">;
  /** `Class.method` for members, plain name otherwise. */
  qualifiedName: string;
  signature: string;
  lineStart: number;
  lineEnd: number | null;
  exported: boolean;
  parent: string | null;
  /** Identifiers referenced in the body — the raw material for call edges. */
  refs: string[];
  /** `<receiver>.<method>(` occurrences in the body — the raw material for member-call edges (ADR-0050). */
  memberCalls: ParsedMemberCall[];
}

export interface ParsedFile {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  reExports: ParsedImport[];
  /** File-scope identifier → simple type name, read from parameter/const annotations and `new` (ADR-0050). */
  bindings: Record<string, string>;
  /** Bare identifiers inside test-harness callback bodies — the raw material for the module node's call edges (ADR-0050). */
  moduleRefs: string[];
  /** Member calls inside those bodies — resolved with the module node as the edge source (ADR-0050). */
  moduleMemberCalls: ParsedMemberCall[];
  /** typeName → fieldName → simple identifier type, from interface and class bodies (ADR-0050). */
  fields: Record<string, Record<string, string>>;
  parseError?: string;
}

/**
 * One language's structural scanner behind the registry (roadmap Phase 2):
 * the extensions it claims, a length-preserving blanker (comments, strings and
 * the language's regex/comment forms), and a parser that fills the shared
 * parsed shapes above. A grammar ships as code in this repo or it does not
 * ship — no runtime dependency may hide behind this interface (ADR-0050).
 */
export interface LanguageGrammar {
  id: string;
  label: string;
  extensions: string[];
  /** Blanked copy of `src`, same length, ready for offset arithmetic. */
  blank(src: string): string;
  /**
   * Parse into the shared shapes. Sync precomputes `blank(src)` once per
   * changed file and hands BOTH copies in, so a parser that needs raw literals
   * (import specifiers) alongside blanked offsets never blanks twice.
   */
  parse(src: string, blanked: string): ParsedFile;
  /**
   * WHY optional: absent means "resolve through the default machinery only" —
   * the TS/JS relative-path + tsconfig-`paths` rules the resolver already
   * implements (ADR-0050). Languages whose module system those rules cannot
   * know — go.mod module prefixes, Java packages, Rust crate paths (roadmap
   * Phase 2) — implement this hook: return candidate repo-relative paths IN
   * ORDER and sync tries them before the default machinery; null or an empty
   * list falls back to the default rules untouched.
   */
  resolveImport?(spec: string, fromFile: string, ctx: { repoRoot: string }): string[] | null;
}
