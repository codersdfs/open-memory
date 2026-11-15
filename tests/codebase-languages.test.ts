import { describe, it, expect } from "vitest";
import { GRAMMARS, grammarForExtension } from "../src/core/codebase/languages/index.js";
import { typescriptGrammar } from "../src/core/codebase/languages/typescript.js";

/**
 * The language registry (roadmap Phase 2): extension lookup is deterministic
 * and case-insensitive, unknown extensions build nothing, and the registry
 * starts with exactly the TS/JS grammar the structural scanner shipped
 * (ADR-0050) — no second entry, no behaviour change.
 */

describe("codebase language registry", () => {
  it("resolves every TS/JS extension to the typescript grammar", () => {
    for (const ext of typescriptGrammar.extensions) {
      expect(grammarForExtension(ext)).toBe(typescriptGrammar);
      expect(grammarForExtension(ext.toUpperCase())).toBe(typescriptGrammar);
    }
  });

  it("returns null for extensions no grammar claims", () => {
    expect(grammarForExtension(".py")).toBeNull();
    expect(grammarForExtension(".go")!.id).toBe("go"); // claimed since Phase 2
    expect(grammarForExtension("")).toBeNull();
  });

  it("starts with the TS/JS grammar first, covering the six TS/JS extensions", () => {
    expect(GRAMMARS[0]).toBe(typescriptGrammar);
    expect(GRAMMARS[0]!.extensions).toEqual([".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"]);
    // Phase 2: the brace family rides the same registry — each grammar owns
    // its extensions, and no two grammars may claim the same one.
    const claimed = GRAMMARS.flatMap((g) => g.extensions);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(grammarForExtension(".go")!.id).toBe("go");
    expect(grammarForExtension(".java")!.id).toBe("java");
    expect(grammarForExtension(".cs")!.id).toBe("csharp");
    expect(grammarForExtension(".rs")!.id).toBe("rust");
    expect(grammarForExtension(".kt")!.id).toBe("kotlin");
  });
});
