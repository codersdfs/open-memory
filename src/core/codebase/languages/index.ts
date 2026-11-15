import type { LanguageGrammar } from "./types.js";
import { typescriptGrammar } from "./typescript.js";
import { goGrammar } from "./go.js";
import { javaGrammar } from "./java.js";
import { csharpGrammar } from "./csharp.js";
import { rustGrammar } from "./rust.js";
import { kotlinGrammar } from "./kotlin.js";

/**
 * The grammar registry (roadmap Phase 2): every language the code index can
 * scan, in the order extension lookup consults them. Adding a language is one
 * entry here — the scan's extension set and the sync's per-file parse derive
 * from this list, never the other way around.
 */
export const GRAMMARS: LanguageGrammar[] = [typescriptGrammar, goGrammar, javaGrammar, csharpGrammar, rustGrammar, kotlinGrammar];

/**
 * Case-insensitive extension lookup. First match in `GRAMMARS` order wins, so
 * the array's declaration order IS the precedence — deterministic by
 * construction, never by accident downstream.
 */
export function grammarForExtension(ext: string): LanguageGrammar | null {
  const needle = ext.toLowerCase();
  for (const grammar of GRAMMARS) {
    if (grammar.extensions.includes(needle)) return grammar;
  }
  return null;
}
