import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { looksLikeJsonc, parseJsonc, removeJsoncPath, setJsoncPath, stripComments, stripTrailingCommas } from "../src/adapters/jsonc.js";
import { GenericAdapter } from "../src/adapters/generic.js";

/**
 * JSONC editing has to be *lossless outside the edited key*, because these files are
 * hand-written: Zed's settings open with a commented header, and every key the user
 * wrote sits beside comments that explain it. A round-trip test is therefore not
 * enough on its own — these assert on the exact bytes.
 */

const ZED_STYLE = `// Zed settings
//
// For information on how to configure Zed, see the Zed
// documentation: https://zed.dev/docs/configuring-zed
{
  "theme": "Ayu Dark",
  "context_servers": {
    "mcp-server-github": {
      "enabled": true
    }
  },
  "agent": {
    "dock": "right"
  }
}
`;

describe("JSONC text handling", () => {
  it("strips line and block comments but not comment-like text inside strings", () => {
    const src = `{
  // a comment
  "url": "https://example.com/a//b",
  /* block */
  "note": "not // a comment",
  "n": 1
}`;
    const parsed = parseJsonc<Record<string, unknown>>(src);
    expect(parsed).toEqual({ url: "https://example.com/a//b", note: "not // a comment", n: 1 });
    const stripped = stripComments(src);
    expect(stripped).not.toContain("// a comment\n");
    expect(stripped).not.toContain("/* block */");
    // The same text inside string literals must survive untouched.
    expect(stripped).toContain("https://example.com/a//b");
    expect(stripped).toContain(`"not // a comment"`);
  });

  it("drops trailing commas from objects and arrays", () => {
    const parsed = parseJsonc<Record<string, unknown>>(`{ "a": [1, 2, ], "b": { "c": 3, }, }`);
    expect(parsed).toEqual({ a: [1, 2], b: { c: 3 } });
    expect(stripTrailingCommas(`{"a":[1,]}`)).toBe(`{"a":[1]}`);
  });

  it("distinguishes strict JSON from JSONC", () => {
    expect(looksLikeJsonc(`{"a":1}`)).toBe(false);
    expect(looksLikeJsonc(`{ // c\n "a": 1 }`)).toBe(true);
    expect(looksLikeJsonc(`{ "a": `)).toBe(false);
  });
});

describe("setJsoncPath", () => {
  it("inserts a nested member and keeps every comment", () => {
    const edit = setJsoncPath(ZED_STYLE, ["context_servers", "ai-memory"], { type: "stdio" });
    expect(edit.changed).toBe(true);
    expect(edit.text).toContain("// Zed settings");
    expect(edit.text).toContain("// documentation:");
    expect(parseJsonc<Record<string, unknown>>(edit.text)).toEqual({
      theme: "Ayu Dark",
      context_servers: { "mcp-server-github": { enabled: true }, "ai-memory": { type: "stdio" } },
      agent: { dock: "right" }
    });
  });

  it("indents a newly inserted object one level deeper than its key", () => {
    const edit = setJsoncPath(ZED_STYLE, ["context_servers", "ai-memory"], { a: 1 });
    expect(edit.text).toContain(`    "ai-memory": {\n      "a": 1\n    }`);
  });

  it("is idempotent", () => {
    const once = setJsoncPath(ZED_STYLE, ["context_servers", "ai-memory"], { type: "stdio" });
    const twice = setJsoncPath(once.text, ["context_servers", "ai-memory"], { type: "stdio" });
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once.text);
  });

  it("replaces an existing value in place, leaving siblings and comments alone", () => {
    const first = setJsoncPath(ZED_STYLE, ["context_servers", "ai-memory"], { v: 1 });
    const second = setJsoncPath(first.text, ["context_servers", "ai-memory"], { v: 2 });
    expect(second.changed).toBe(true);
    expect(second.text).toContain("// Zed settings");
    expect(second.text).toContain(`"mcp-server-github"`);
    expect(parseJsonc<Record<string, unknown>>(second.text)).toMatchObject({ context_servers: { "ai-memory": { v: 2 } } });
  });

  it("creates a missing parent chain", () => {
    const edit = setJsoncPath(`{\n  "a": 1\n}\n`, ["deep", "nested", "key"], { x: true });
    expect(parseJsonc<Record<string, unknown>>(edit.text)).toEqual({ a: 1, deep: { nested: { key: { x: true } } } });
  });

  it("refuses to edit a document that is not an object", () => {
    expect(() => setJsoncPath(`[1, 2]`, ["a"], 1)).toThrow(/not a JSON object/);
  });
});

describe("removeJsoncPath", () => {
  it("removes the inserted member and restores the original bytes", () => {
    const added = setJsoncPath(ZED_STYLE, ["context_servers", "ai-memory"], { type: "stdio" });
    const removed = removeJsoncPath(added.text, ["context_servers", "ai-memory"]);
    expect(removed.changed).toBe(true);
    expect(removed.text).toBe(ZED_STYLE);
  });

  it("removes a middle member without disturbing the others", () => {
    const src = `{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n`;
    const edit = removeJsoncPath(src, ["b"]);
    expect(edit.text).toBe(`{\n  "a": 1,\n  "c": 3\n}\n`);
    expect(parseJsonc<Record<string, unknown>>(edit.text)).toEqual({ a: 1, c: 3 });
  });

  it("removes the only member of an object", () => {
    const src = `{\n  "outer": {\n    "only": 1\n  }\n}\n`;
    const edit = removeJsoncPath(src, ["outer", "only"]);
    expect(parseJsonc<Record<string, unknown>>(edit.text)).toEqual({ outer: {} });
  });

  it("reports no change for an absent path", () => {
    const edit = removeJsoncPath(ZED_STYLE, ["context_servers", "nope"]);
    expect(edit.changed).toBe(false);
    expect(edit.text).toBe(ZED_STYLE);
  });
});

describe("GenericAdapter with a JSONC config", () => {
  const withTemp = (name: string, content: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "ai-memory-jsonc-"));
    const file = path.join(dir, name);
    writeFileSync(file, content, "utf8");
    return { dir, file };
  };

  it("links, reports status and unlinks a commented settings file", async () => {
    const { dir, file } = withTemp("settings.json", ZED_STYLE);
    const adapter = new GenericAdapter("zed", { mcpFile: file, jsonPath: "context_servers", format: "jsonc" }, "Zed");
    try {
      const link = await adapter.link({ write: true });
      expect(link[0]!.changed).toBe(true);
      const after = readFileSync(file, "utf8");
      expect(after).toContain("// Zed settings");

      // Preview must not write.
      const beforePreview = readFileSync(file, "utf8");
      await adapter.link({ write: false });
      expect(readFileSync(file, "utf8")).toBe(beforePreview);

      expect((await adapter.status()).linked).toBe(true);

      const unlink = await adapter.unlink({ write: true });
      expect(unlink[0]!.changed).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(ZED_STYLE);
      expect((await adapter.status()).linked).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("creates the server map when the file has none", async () => {
    const { dir, file } = withTemp("mcp.json", `{\n  // no servers yet\n}\n`);
    const adapter = new GenericAdapter("vscode", { mcpFile: file, jsonPath: "servers", format: "jsonc" }, "VS Code");
    try {
      await adapter.link({ write: true });
      const text = readFileSync(file, "utf8");
      expect(text).toContain("// no servers yet");
      const parsed = parseJsonc<{ servers: Record<string, { args: string[] }> }>(text);
      expect(Object.keys(parsed.servers)).toEqual(["ai-memory"]);
      expect(parsed.servers["ai-memory"]!.args).toContain("mcp");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
