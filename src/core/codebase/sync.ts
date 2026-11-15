import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { VectorStore } from "../store/interface.js";
import { normalizeProject, projectSlug, resolveProject } from "../project.js";
import type { ParsedFile, ParsedMemberCall } from "./parse.js";
import { grammarForExtension } from "./languages/index.js";
import { MAX_FILE_BYTES, scanRoot } from "./scan.js";
import { aliasMappedPaths, loadAliasConfig, resolveImportedName, resolveSpecifier, specifierCandidates, type FileEntry } from "./resolve.js";
import { codeFileId, codeSymbolId } from "./ids.js";
import type { CodeEdgeEvidence, CodeEdgeRow, CodeFileChange, CodeSymbolRow, CodebaseSyncReport } from "./types.js";

/**
 * The only writer of the code index (ADR-0050), the way `knowledge/sync.ts` is the
 * only writer of knowledge rows.
 *
 *  - **Idempotent.** A file whose content hash did not change writes nothing.
 *  - **Incremental.** Only changed files are re-parsed; only their symbols and the
 *    edges they own are rebuilt. Re-export statements and type-field maps are
 *    persisted on the file row, so a chain pointing into an *unchanged* file
 *    still resolves.
 *  - **Honest edges.** Import statements produce `import`/`re-export` edges; same-file
 *    references produce `local`; a name with exactly one exported owner anywhere in
 *    the project produces `name-match`. Ambiguous names build nothing — the graph
 *    would rather miss a link than invent one.
 *  - **Atomic.** All of one sync lands in one store transaction; `fan_in` is
 *    recomputed over the live edges inside it.
 */

export interface SyncCodebaseDeps {
  store: VectorStore;
}

export interface SyncCodebaseOptions {
  /** Repository root; defaults to the git root of the current directory. */
  root?: string;
  /** Project slug; defaults to the git root's basename, slugged (ADR-0020). */
  project?: string | null;
  /** Report what would change without writing anything. */
  dryRun?: boolean;
}

interface ParsedChange {
  change: CodeFileChange;
  parsed: ParsedFile;
}

export async function syncCodebase(deps: SyncCodebaseDeps, opts: SyncCodebaseOptions = {}): Promise<CodebaseSyncReport> {
  const cap = deps.store.codebase;
  if (!cap) throw new Error("codebase memory: this store does not implement the codebase capability");

  const started = Date.now();
  const resolution = resolveProject(undefined, { cwd: opts.root });
  const root = opts.root ? path.resolve(opts.root) : (resolution.root ?? process.cwd());
  const project = normalizeProject(opts.project) ?? projectSlug(path.basename(root));
  if (!project) {
    throw new Error(`codebase index: no project could be resolved for ${root} — pass --project or run inside a git checkout`);
  }
  // tsconfig `paths` are file-level state like the extension candidates
  // (ADR-0050): read once per sync, threaded through specifier resolution, so
  // no per-file parsing ever depends on them.
  const aliases = await loadAliasConfig(root);

  const scanned = await scanRoot(root);
  const existingFiles = await cap.codeFiles(project);
  const existingByPath = new Map(existingFiles.map((f) => [f.path, f]));
  const scannedPaths = new Set(scanned.map((f) => f.path));

  const changes: CodeFileChange[] = [];
  const parsed: ParsedChange[] = [];
  let indexed = 0;
  let skipped = 0;
  let parseErrors = 0;
  let newSymbols = 0;
  let newEdges = 0;

  for (const file of scanned) {
    // A file whose extension no grammar claims cannot become rows — skipped,
    // never guessed at (roadmap Phase 2). Unreachable while scanRoot filters
    // on the same registry, but the sync stays honest about it on its own.
    const grammar = grammarForExtension(path.extname(file.path).toLowerCase());
    if (!grammar) {
      skipped++;
      continue;
    }
    const prior = existingByPath.get(file.path);
    if (file.size > MAX_FILE_BYTES) {
      skipped++;
      continue;
    }
    let content: string;
    try {
      content = await fs.readFile(file.absPath, "utf8");
    } catch {
      skipped++;
      continue;
    }
    const hash = createHash("sha256").update(content).digest("hex");
    if (prior && prior.hash === hash) {
      skipped++;
      continue;
    }
    const result = grammar.parse(content, grammar.blank(content));
    if (result.parseError) parseErrors++;
    const lines = content.split("\n").length;
    const info = {
      id: codeFileId(project, file.path),
      project,
      path: file.path,
      hash,
      mtime: file.mtime,
      lines,
      parseError: result.parseError ?? null,
      reExports: result.reExports.map((r) => ({ spec: r.spec, names: [...r.names] })),
      language: grammar?.id ?? null
    };
    const rows: CodeSymbolRow[] = [
      {
        id: codeSymbolId(project, file.path, file.path),
        project,
        fileId: info.id,
        path: file.path,
        name: file.path,
        qualifiedName: file.path,
        kind: "module",
        signature: "",
        lineStart: 1,
        lineEnd: lines,
        exported: false,
        parentId: null,
        fanIn: 0,
        language: grammar?.id ?? null
      }
    ];
    const idByQualifiedName = new Map(rows.map((r) => [r.qualifiedName, r.id] as const));
    for (const sym of result.symbols) {
      const id = codeSymbolId(project, file.path, sym.qualifiedName);
      idByQualifiedName.set(sym.qualifiedName, id);
      rows.push({
        id,
        project,
        fileId: info.id,
        path: file.path,
        name: sym.name,
        qualifiedName: sym.qualifiedName,
        kind: sym.kind,
        signature: sym.signature,
        lineStart: sym.lineStart,
        lineEnd: sym.lineEnd,
        exported: sym.exported,
        parentId: sym.parent ? (idByQualifiedName.get(sym.parent) ?? null) : null,
        fanIn: 0,
        language: grammar?.id ?? null
      });
    }
    const change: CodeFileChange = {
      path: file.path,
      hash,
      mtime: file.mtime,
      lines,
      parseError: result.parseError ?? null,
      symbols: rows,
      edges: [],
      reExports: info.reExports,
      fields: result.fields,
      language: grammar?.id ?? null
    };
    changes.push(change);
    parsed.push({ change, parsed: result });
    indexed++;
    newSymbols += rows.length;
  }

  for (const prior of existingFiles) {
    if (!scannedPaths.has(prior.path)) {
      changes.push({
        path: prior.path,
        hash: null,
        mtime: null,
        lines: null,
        parseError: null,
        symbols: [],
        edges: [],
        reExports: [],
        fields: {},
        language: null
      });
      indexed++;
    }
  }
  const removed = changes.filter((c) => c.hash === null).length;

  // Resolution index: every file the project currently holds — unchanged files from
  // the store, changed files from this run — so edges can land on either kind.
  const allSymbols = await cap.codeSymbols(project, { includeModules: true });
  const changedPaths = new Set(changes.map((c) => c.path));
  const unchangedSymbols = allSymbols.filter((r) => !changedPaths.has(r.path));
  const files = new Map<string, FileEntry>();
  const byName = new Map<string, Set<string>>();
  // Member-call targets resolve through qualified names (`Class.method`), so the
  // index must cover every symbol — methods are rarely exported, and uniqueness
  // across the project is what keeps the edge honest (ADR-0050).
  const byQualifiedName = new Map<string, Set<string>>();
  const indexQualifiedName = (qualifiedName: string, id: string): void => {
    let ids = byQualifiedName.get(qualifiedName);
    if (!ids) {
      ids = new Set();
      byQualifiedName.set(qualifiedName, ids);
    }
    ids.add(id);
  };
  const seedEntry = (filePath: string, rows: CodeSymbolRow[], reExports: { spec: string; names: string[] }[]): void => {
    const entry: FileEntry = {
      exportedNames: new Set(),
      exportedIds: new Map(),
      reExports,
      moduleNodeId: rows.find((r) => r.kind === "module")?.id ?? ""
    };
    for (const row of rows) {
      if (row.kind === "module") continue;
      indexQualifiedName(row.qualifiedName, row.id);
      if (row.exported) {
        entry.exportedNames.add(row.name);
        entry.exportedIds.set(row.name, row.id);
        let ids = byName.get(row.name);
        if (!ids) {
          ids = new Set();
          byName.set(row.name, ids);
        }
        ids.add(row.id);
      }
    }
    files.set(filePath, entry);
  };
  for (const row of unchangedSymbols) {
    if (!changedPaths.has(row.path)) {
      let entry = files.get(row.path);
      if (!entry) {
        entry = { exportedNames: new Set(), exportedIds: new Map(), reExports: [], moduleNodeId: "" };
        files.set(row.path, entry);
      }
      if (row.kind === "module") {
        entry.moduleNodeId = row.id;
        continue;
      }
      indexQualifiedName(row.qualifiedName, row.id);
      if (row.exported) {
        entry.exportedNames.add(row.name);
        entry.exportedIds.set(row.name, row.id);
        let ids = byName.get(row.name);
        if (!ids) {
          ids = new Set();
          byName.set(row.name, ids);
        }
        ids.add(row.id);
      }
    }
  }
  // Unchanged files' persisted re-exports come from their `code_files` rows.
  for (const prior of existingFiles) {
    if (!changedPaths.has(prior.path)) {
      const entry = files.get(prior.path);
      if (entry) entry.reExports = prior.reExports.map((r) => ({ spec: r.spec, names: [...r.names] }));
    }
  }
  for (const { change } of parsed) {
    seedEntry(change.path, change.symbols, change.reExports);
  }

  // Field maps travel with the file that declares the type (ADR-0050): they are
  // derived state persisted on the code_files row like re-exports, so an
  // imported type whose file was NOT re-parsed this run still contributes its
  // fields -- re-parsed files override with this run's parse, unchanged files
  // read their persisted map back.
  const fieldsBySymbolId = new Map<string, Record<string, Record<string, string>>>();
  const unchangedRowsByPath = new Map<string, CodeSymbolRow[]>();
  for (const row of unchangedSymbols) {
    if (row.kind === "module") continue;
    let rows = unchangedRowsByPath.get(row.path);
    if (!rows) {
      rows = [];
      unchangedRowsByPath.set(row.path, rows);
    }
    rows.push(row);
  }
  for (const prior of existingFiles) {
    const rows = unchangedRowsByPath.get(prior.path);
    if (rows) for (const row of rows) fieldsBySymbolId.set(row.id, prior.fields);
  }
  for (const { change, parsed: parsedFields } of parsed) {
    for (const row of change.symbols) {
      if (row.kind !== "module") fieldsBySymbolId.set(row.id, parsedFields.fields);
    }
  }

  for (const { change, parsed: file } of parsed) {
    const moduleId = change.symbols.find((r) => r.kind === "module")?.id;
    if (!moduleId) continue;
    const importMap = new Map<string, string>();
    let landed: string | null = null;
    let viaAlias = false;
    const hook = grammarForExtension(path.extname(change.path).toLowerCase())?.resolveImport;
    for (const imp of [...file.imports, ...file.reExports]) {
      landed = null;
      viaAlias = false;
      // Grammar `resolveImport` hook (roadmap Phase 2): a language with its own
      // module system (go.mod prefixes, Java packages, Rust crate paths) lands
      // its imports FIRST — exact candidate paths, then "/"-suffixed candidates
      // read as directory prefixes over the known files, first in sorted order.
      // Only a hook that yields nothing falls through to the default machinery.
      if (hook) {
        for (const candidate of hook(imp.spec, change.path, { repoRoot: root }) ?? []) {
          if (files.has(candidate)) {
            landed = candidate;
            break;
          }
          if (candidate.endsWith("/")) {
            const prefixed = [...files.keys()].filter((f) => f.startsWith(candidate)).sort((a, b) => a.localeCompare(b))[0];
            if (prefixed) {
              landed = prefixed;
              break;
            }
          }
        }
      }
      // Alias targets flow through the SAME specifierCandidates search as
      // relative paths (ADR-0050): every target pattern is tried in tsconfig
      // order, and an alias that matches but lands on no indexed file builds
      // nothing — the graph would rather miss than invent a path.
      const landOn = (resolved: string): string | null => {
        for (const candidate of specifierCandidates(resolved)) {
          if (files.has(candidate)) return candidate;
        }
        return null;
      };
      // The default machinery runs only when the grammar hook landed nothing.
      if (!landed) {
        const mapped = aliasMappedPaths(imp.spec, aliases);
        if (mapped) {
          for (const target of mapped) {
            landed = landOn(target);
            if (landed) {
              viaAlias = true;
              break;
            }
          }
        } else {
          const resolved = resolveSpecifier(change.path, imp.spec);
          if (resolved) landed = landOn(resolved);
        }
      }
      if (!landed) continue;
      if (imp.dynamic) {
        // Dynamic import() / require() edges run module node → target module
        // node (ADR-0050): the bindings only exist at runtime, so the module
        // link is the exact part. Bare specifiers never land in the repo and
        // build nothing, the same rule as static bare imports.
        const targetModule = files.get(landed)?.moduleNodeId;
        if (targetModule && !change.edges.some((edge) => edge.fromId === moduleId && edge.toId === targetModule)) {
          change.edges.push({ kind: "imports", fromId: moduleId, toId: targetModule, evidence: viaAlias ? "alias" : "import" });
        }
        continue;
      }
      // Evidence precedence, kept deterministic (ADR-0050): re-export wins —
      // the barrel hop is the deeper resolution step; then alias — the
      // specifier needed tsconfig paths to land at all; then plain import.
      if (imp.names.length === 0 && (imp.namespace || imp.sideEffect || imp.isExport)) {
        const targetModule = files.get(landed)?.moduleNodeId;
        if (targetModule && !change.edges.some((e) => e.fromId === moduleId && e.toId === targetModule)) {
          change.edges.push({ kind: "imports", fromId: moduleId, toId: targetModule, evidence: viaAlias ? "alias" : "import" });
        }
      }
      for (const name of imp.names) {
        const target = resolveImportedName(files, landed, name, aliases);
        if (target) {
          const entry = files.get(target.path);
          const targetId = entry?.exportedIds.get(name);
          if (targetId) {
            change.edges.push({
              kind: "imports",
              fromId: moduleId,
              toId: targetId,
              evidence: target.viaReExport ? "re-export" : viaAlias ? "alias" : "import"
            });
            importMap.set(name, targetId);
          }
        } else {
          const targetModule = files.get(landed)?.moduleNodeId;
          if (targetModule && !change.edges.some((e) => e.fromId === moduleId && e.toId === targetModule)) {
            change.edges.push({ kind: "imports", fromId: moduleId, toId: targetModule, evidence: viaAlias ? "alias" : "import" });
          }
        }
      }
    }

    const parsedByQualifiedName = new Map(file.symbols.map((s) => [s.qualifiedName, s] as const));
    const idByQualifiedName = new Map(change.symbols.map((s) => [s.qualifiedName, s.id] as const));
    const bindings = file.bindings;
    const ownIds = new Map<string, Set<string>>();
    for (const row of change.symbols) {
      if (row.kind === "module") continue;
      let ids = ownIds.get(row.name);
      if (!ids) {
        ids = new Set();
        ownIds.set(row.name, ids);
      }
      ids.add(row.id);
    }
    // Member-call resolution, shared by symbol bodies and harness-callback
    // bodies (ADR-0050). A two-level chain walks one field of the receiver's
    // type first; the final method must be a unique qualified symbol anywhere
    // in the project -- a miss builds nothing, never a bare-name guess.
    const pushCallEdge = (fromId: string, toId: string, evidence: CodeEdgeEvidence): void => {
      if (toId !== fromId) change.edges.push({ kind: "calls", fromId, toId, evidence });
    };
    const uniqueQualifiedTarget = (qualifiedName: string): string | null => {
      const candidates = byQualifiedName.get(qualifiedName);
      if (candidates?.size !== 1) return null;
      return [...candidates][0]!;
    };
    const resolveFieldType = (typeName: string, field: string): { fieldType: string; evidence: CodeEdgeEvidence } | null => {
      // Same-file types read the calling file's own fields; imported ones read
      // the defining file's persisted map (re-parsed this run or read back from
      // its code_files row) -- else no edge rather than a guess.
      if (ownIds.has(typeName)) {
        const fieldType = file.fields[typeName]?.[field];
        return fieldType ? { fieldType, evidence: "local" } : null;
      }
      const importedTypeId = importMap.get(typeName);
      if (!importedTypeId) return null;
      const fieldType = fieldsBySymbolId.get(importedTypeId)?.[typeName]?.[field];
      return fieldType ? { fieldType, evidence: "import" } : null;
    };
    const pushMemberCallEdge = (sourceId: string, call: ParsedMemberCall, parentQualifiedName: string | null): void => {
      // `this` is the one receiver whose type the file itself states (ADR-0050).
      if (call.receiver === "this") {
        if (!parentQualifiedName) return;
        if (call.via) {
          // `this.field.method()`: the enclosing class's own field map states
          // the field's type; the parent is same-file by construction.
          const parentName = parentQualifiedName.split(".").pop()!;
          const fieldType = file.fields[parentName]?.[call.via];
          if (!fieldType) return;
          const targetId = uniqueQualifiedTarget(`${fieldType}.${call.method}`);
          if (targetId) pushCallEdge(sourceId, targetId, "local");
          return;
        }
        const targetId = idByQualifiedName.get(`${parentQualifiedName}.${call.method}`);
        if (targetId) pushCallEdge(sourceId, targetId, "local");
        return;
      }
      // A bound receiver resolves through its annotation's type: same-file
      // types are exact (local), imported ones ride the import statement
      // (import). Two-level chains walk one field of that type first.
      const boundType = bindings[call.receiver];
      if (boundType) {
        if (call.via) {
          const resolved = resolveFieldType(boundType, call.via);
          if (!resolved) return;
          const targetId = uniqueQualifiedTarget(`${resolved.fieldType}.${call.method}`);
          if (targetId) pushCallEdge(sourceId, targetId, resolved.evidence);
          return;
        }
        const sameFileType = ownIds.has(boundType);
        const importedType = importMap.get(boundType);
        if (sameFileType || importedType) {
          const targetId = uniqueQualifiedTarget(`${boundType}.${call.method}`);
          if (targetId) pushCallEdge(sourceId, targetId, sameFileType ? "local" : "import");
        }
        return;
      }
      if (call.via) return; // a class's static-field chain is out of scope (ADR-0050)
      // The receiver itself may be the class — same-file (static-style local)
      // or imported (static-style import); same uniqueness rule as above.
      const sameFileReceiver = ownIds.has(call.receiver);
      const importedReceiver = importMap.get(call.receiver);
      if (sameFileReceiver || importedReceiver) {
        const targetId = uniqueQualifiedTarget(`${call.receiver}.${call.method}`);
        if (targetId) pushCallEdge(sourceId, targetId, sameFileReceiver ? "local" : "import");
      }
    };
    for (const sym of change.symbols) {
      if (sym.kind === "module") continue;
      const parsedSym = parsedByQualifiedName.get(sym.qualifiedName);
      if (!parsedSym) continue;
      for (const ref of parsedSym.refs) {
        const viaImport = importMap.get(ref);
        if (viaImport && viaImport !== sym.id) {
          pushCallEdge(sym.id, viaImport, "import");
          continue;
        }
        const localIds = ownIds.get(ref);
        if (localIds && localIds.size === 1) {
          const localId = [...localIds][0]!;
          pushCallEdge(sym.id, localId, "local");
          continue;
        }
        const candidates = byName.get(ref);
        if (candidates && candidates.size === 1) {
          const only = [...candidates][0]!;
          pushCallEdge(sym.id, only, "name-match");
        }
      }
      for (const call of parsedSym.memberCalls) {
        pushMemberCallEdge(sym.id, call, parsedSym.parent);
      }
    }
    // Harness-callback bodies resolve with the module node as their edge source
    // (ADR-0050): bare refs ride the ordinary refs cascade -- exact import/local
    // evidence when available, the honest name-match heuristic otherwise -- and
    // member calls use the same resolver as symbols. A module node has no
    // enclosing class, so `this` resolves to nothing.
    for (const ref of new Set(file.moduleRefs)) {
      const viaImport = importMap.get(ref);
      if (viaImport) {
        pushCallEdge(moduleId, viaImport, "import");
        continue;
      }
      const localIds = ownIds.get(ref);
      if (localIds && localIds.size === 1) {
        pushCallEdge(moduleId, [...localIds][0]!, "local");
        continue;
      }
      const candidates = byName.get(ref);
      if (candidates && candidates.size === 1) {
        pushCallEdge(moduleId, [...candidates][0]!, "name-match");
      }
    }
    for (const call of file.moduleMemberCalls) {
      pushMemberCallEdge(moduleId, call, null);
    }
    const seen = new Set<string>();
    change.edges = change.edges.filter((e) => {
      const key = `${e.kind}\u0000${e.fromId}\u0000${e.toId}\u0000${e.evidence}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    newEdges += change.edges.length;
  }

  if (!opts.dryRun && changes.length > 0) {
    await cap.codeApplyChanges(project, changes);
  }

  return {
    root,
    project,
    dryRun: Boolean(opts.dryRun),
    files: scanned.length,
    indexed,
    skipped,
    removed,
    parseErrors,
    /** Run facts, not store totals: the rows and edges THIS sync wrote (or would write). */
    symbols: newSymbols,
    edges: newEdges,
    durationMs: Date.now() - started
  };
}
