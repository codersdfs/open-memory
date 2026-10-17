import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commentOutEnvKeys, envFilePath, readEnvFile } from "../src/core/envFile.js";

// One temp dir per case: the real .env of whoever runs the suite is never touched.
let dir = "";
let file = "";

const savedEnvFile = process.env.MEMORY_ENV_FILE;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ai-memory-env-"));
  file = path.join(dir, ".env");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedEnvFile === undefined) delete process.env.MEMORY_ENV_FILE;
  else process.env.MEMORY_ENV_FILE = savedEnvFile;
});

const put = (text: string) => writeFileSync(file, text, "utf8");

describe("envFilePath", () => {
  it("defaults to .env in the given cwd", () => {
    delete process.env.MEMORY_ENV_FILE;
    expect(envFilePath(dir)).toBe(path.join(dir, ".env"));
  });
  it("prefers MEMORY_ENV_FILE", () => {
    process.env.MEMORY_ENV_FILE = `  ${path.join(dir, "override.env")}  `;
    expect(envFilePath(dir)).toBe(path.join(dir, "override.env"));
  });
});

describe("readEnvFile", () => {
  it("reads a plain assignment", () => {
    put("A=1\n");
    expect(readEnvFile(file)).toMatchObject([{ name: "A", value: "1", enabled: true, line: 1 }]);
  });

  it("reads an export line", () => {
    put("export A=1\n");
    expect(readEnvFile(file)[0]).toMatchObject({ name: "A", value: "1", enabled: true });
  });

  it("strips quotes on read", () => {
    put('A="1 2"\nB=\'3 4\'\n');
    expect(readEnvFile(file).map((e) => e.value)).toEqual(["1 2", "3 4"]);
  });

  it("drops an inline comment after a value", () => {
    put("A=1 # note\nB=2#3\n");
    expect(readEnvFile(file).map((e) => e.value)).toEqual(["1", "2#3"]);
  });

  it("reports a commented line as present but disabled, and ignores blank lines", () => {
    put("#A=1\n\n   \n");
    expect(readEnvFile(file)).toMatchObject([{ name: "A", value: "1", enabled: false, line: 1 }]);
  });

  it("parses a CRLF file with no trailing newline the same way", () => {
    put("A=1\r\nB=2");
    expect(readEnvFile(file).map((e) => [e.name, e.value, e.line])).toEqual([
      ["A", "1", 1],
      ["B", "2", 2],
    ]);
  });

  it("returns two entries when the same name appears twice", () => {
    put("A=1\nB=2\nA=3\n");
    expect(readEnvFile(file).filter((e) => e.name === "A").map((e) => e.line)).toEqual([1, 3]);
  });

  it("reads a file that does not exist as empty", () => {
    expect(readEnvFile(file)).toEqual([]);
  });
});

describe("commentOutEnvKeys", () => {
  it("comments every occurrence and leaves the rest byte-for-byte", async () => {
    put("OTHER=keep\nJEV_API_KEY=abc\nANOTHER=also\n");
    const { commented, backupPath } = await commentOutEnvKeys(file, ["JEV_API_KEY"]);
    expect(commented).toEqual(["JEV_API_KEY"]);
    expect(readFileSync(backupPath!, "utf8")).toContain("JEV_API_KEY=");
    expect(readFileSync(file, "utf8")).toContain("#JEV_API_KEY=");
    expect(readFileSync(file, "utf8")).toContain("OTHER=keep");
  });

  it("a name that is absent from the file comments nothing and writes no backup", async () => {
    put("OTHER=keep\n");
    expect(await commentOutEnvKeys(file, ["NOPE"])).toEqual({ commented: [], backupPath: null });
    expect(readFileSync(file, "utf8")).toBe("OTHER=keep\n");
  });

  it("comments an export line at its own start, so re-enabling is one uncomment", async () => {
    put("export JEV_API_KEY=abc\n");
    await commentOutEnvKeys(file, ["JEV_API_KEY"]);
    expect(readFileSync(file, "utf8")).toBe("#export JEV_API_KEY=abc\n");
  });

  it("comments quoted values without rewriting them", async () => {
    put('JEV_API_KEY="a b"  \nexport OTHER=1\n');
    await commentOutEnvKeys(file, ["JEV_API_KEY"]);
    expect(readFileSync(file, "utf8")).toBe('#JEV_API_KEY="a b"  \nexport OTHER=1\n');
  });

  it("comments both occurrences of a repeated name and reports it once", async () => {
    put("A=1\nJEV_API_KEY=first\nJEV_API_KEY=second\n");
    expect(await commentOutEnvKeys(file, ["JEV_API_KEY"])).toMatchObject({ commented: ["JEV_API_KEY"] });
    expect(readFileSync(file, "utf8")).toBe("A=1\n#JEV_API_KEY=first\n#JEV_API_KEY=second\n");
  });

  it("keeps CRLF and a missing trailing newline", async () => {
    put("JEV_API_KEY=abc\r\nOTHER=keep");
    await commentOutEnvKeys(file, ["JEV_API_KEY"]);
    expect(readFileSync(file, "utf8")).toBe("#JEV_API_KEY=abc\r\nOTHER=keep");
  });

  it("does not double-comment a line that is already commented", async () => {
    put("#JEV_API_KEY=abc\n");
    expect(await commentOutEnvKeys(file, ["JEV_API_KEY"])).toEqual({ commented: [], backupPath: null });
    expect(readFileSync(file, "utf8")).toBe("#JEV_API_KEY=abc\n");
  });

  it("leaves .env byte-for-byte and no tmp behind when the write is interrupted", async () => {
    const original = "JEV_API_KEY=abc\r\nOTHER=keep";
    put(original);
    await expect(
      commentOutEnvKeys(file, ["JEV_API_KEY"], {
        rename: async () => {
          throw new Error("interrupted");
        },
      }),
    ).rejects.toThrow(/interrupted/);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(readFileSync(`${file}.bak`, "utf8")).toBe(original);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});
