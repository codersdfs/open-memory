import { blankSource, parseSource } from "../parse.js";
import type { LanguageGrammar } from "./types.js";

/**
 * TypeScript/JavaScript as the registry's first grammar (roadmap Phase 2):
 * the existing scanner (ADR-0050) wrapped, not rewritten — `blankSource` and
 * `parseSource` stay in `parse.ts` and the fixtures in
 * `codebase-parse.test.ts` must keep passing byte for byte. `parseSource`
 * still blanks internally; the precomputed copy sync passes becomes
 * load-bearing with the first grammar whose parser cannot cheaply re-derive
 * it, while the shared `blank` keeps every grammar's blanking contract in one
 * place.
 */
export const typescriptGrammar: LanguageGrammar = {
  id: "typescript",
  label: "TypeScript/JavaScript",
  extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"],
  blank: blankSource,
  parse: parseSource
};
