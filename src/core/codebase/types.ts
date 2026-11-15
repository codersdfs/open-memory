/**
 * Codebase memory (ADR-0050): the code index and its wire shapes.
 *
 * The repository's files are the truth; `code_files`, `code_symbols` and
 * `code_edges` are derived state, rebuilt by `sync.ts` the way `knowledge/sync.ts`
 * rebuilds the vault index. Every row carries the project slug (ADR-0020), because
 * one store holds several repositories and a symbol name alone answers nothing.
 */

export type CodeSymbolKind = "module" | "function" | "method" | "class" | "interface" | "type" | "enum" | "const";

/** `imports` is a module node reaching a target; `calls` is symbol to symbol. */
export type CodeEdgeKind = "imports" | "calls";

/**
 * How an edge earned its existence. The graph never lies about confidence:
 * `import`/`re-export` follow statements (exact), `alias` follows tsconfig
 * `paths` to the file the specifier lands on (exact at the file level),
 * `local` is same-file (exact), and `name-match` is the honest "same name
 * somewhere in the project" heuristic.
 */
export type CodeEdgeEvidence = "import" | "re-export" | "alias" | "local" | "name-match";

export interface CodeFileInfo {
  id: string;
  project: string | null;
  path: string;
  hash: string | null;
  mtime: number | null;
  lines: number | null;
  parseError: string | null;
  /**
   * `export ... from` statements, persisted beside the file: a re-export chain
   * pointing INTO an unchanged file has to resolve without re-parsing it.
   */
  reExports: { spec: string; names: string[] }[];
  /**
   * Type fields (`typeName.fieldName → typeName`), persisted beside the file
   * like reExports: a two-level member call through an interface or class whose
   * file was NOT re-parsed this run still has to resolve.
   */
  fields: Record<string, Record<string, string>>;
  /**
   * The grammar id that parsed this file ("typescript", "go", ...), persisted
   * beside it: an index built by several grammars has to say which one wrote
   * each row, or a mixed index could never be audited (roadmap Phase 2).
   */
  language: string | null;
}

export interface CodeSymbolRow {
  id: string;
  project: string | null;
  fileId: string;
  path: string;
  name: string;
  qualifiedName: string;
  kind: CodeSymbolKind;
  signature: string;
  lineStart: number | null;
  lineEnd: number | null;
  exported: boolean;
  parentId: string | null;
  /** Live `calls` edges pointing at this symbol — recomputed on every sync. */
  fanIn: number;
  /** Inherited from the file's grammar — see CodeFileInfo.language. */
  language: string | null;
}

export interface CodeEdgeRow {
  kind: CodeEdgeKind;
  fromId: string;
  toId: string;
  evidence: CodeEdgeEvidence;
}

/** One file's worth of derived state, applied in one transaction with its siblings. */
export interface CodeFileChange {
  path: string;
  /** null = the file is gone; the sync deletes its rows and their edges. */
  hash: string | null;
  mtime: number | null;
  lines: number | null;
  parseError: string | null;
  symbols: CodeSymbolRow[];
  edges: CodeEdgeRow[];
  reExports: { spec: string; names: string[] }[];
  fields: Record<string, Record<string, string>>;
  language: string | null;
}

export interface CodebaseSyncReport {
  root: string;
  project: string | null;
  dryRun: boolean;
  /** Source files seen on disk. */
  files: number;
  indexed: number;
  skipped: number;
  removed: number;
  parseErrors: number;
  symbols: number;
  edges: number;
  durationMs: number;
}

export interface CodebaseSearchItem extends CodeSymbolRow {
  score: number;
}

export interface CodebaseSearchResult {
  project: string | null;
  symbols: CodebaseSearchItem[];
  tokensUsed: number;
  truncated: boolean;
}

export interface CodebaseSymbolDetail {
  symbol: CodeSymbolRow;
  /** Files importing this symbol (via their module node's `imports` edges). */
  importers: CodeSymbolRow[];
  callers: CodeSymbolRow[];
  callees: CodeSymbolRow[];
}

export interface CodebaseStats {
  files: number;
  parseErrors: number;
  symbols: number;
  edges: number;
}

/**
 * The codebase capability (ADR-0050), optional like `knowledge` so a store written
 * against an earlier version keeps compiling. Primitive persistence only: scanning,
 * parsing and edge resolution live in `codebase/sync.ts`, so the two built-in stores
 * cannot drift apart on what an edge means.
 */
export interface CodebaseCapability {
  codeFiles(project: string): Promise<CodeFileInfo[]>;
  codeSymbols(project: string, opts?: { includeModules?: boolean }): Promise<CodeSymbolRow[]>;
  codeSymbolsByIds(project: string, ids: string[]): Promise<CodeSymbolRow[]>;
  codeSymbolsMatching(project: string, substr: string, limit: number): Promise<CodeSymbolRow[]>;
  codeSymbolById(project: string, id: string): Promise<CodeSymbolRow | null>;
  codeEdges(project: string, symbolId: string, dir: "in" | "out"): Promise<CodeEdgeRow[]>;
  codeStats(project: string): Promise<CodebaseStats>;
  codeApplyChanges(project: string, changes: CodeFileChange[]): Promise<void>;
  codeForget(project: string): Promise<number>;
}
