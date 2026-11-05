import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SECRET_KEYS,
  SETTING_KEYS,
  adoptEnvKeys,
  settingsPath,
  readSettings,
  writeSettings,
  runtimeEnv,
  embeddingSource,
  keyEffect,
  maskSecret,
  settingsInventory,
} from "../src/core/settings.js";
import { readEnvFile } from "../src/core/envFile.js";
import { EMBEDDING_PRESETS, createEmbeddingProvider, previewEmbedding } from "../src/core/embedding/index.js";
import { summarize } from "../src/core/stats.js";
import type { Memory } from "../src/core/types.js";

// Every case runs against a temp dir as `home`; the real ~/.ai-memory is never read.
let home = "";

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "ai-memory-settings-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const put = (text: string) => writeFileSync(settingsPath(home), text, "utf8");

describe("settings precedence", () => {
  it("picks up a settings file on its own", () => {
    put(JSON.stringify({ EMBEDDING_PROVIDER: "nim" }));
    expect(runtimeEnv({}, home).EMBEDDING_PROVIDER).toBe("nim");
    expect(embeddingSource({}, home)).toBe("settings");
  });

  it("lets a real environment variable beat the file", () => {
    put(JSON.stringify({ EMBEDDING_PROVIDER: "nim", EMBEDDING_DIM: "1024" }));
    const merged = runtimeEnv({ EMBEDDING_PROVIDER: "openai" }, home);
    expect(merged.EMBEDDING_PROVIDER).toBe("openai");
    expect(merged.EMBEDDING_DIM).toBe("1024");
    expect(embeddingSource({ EMBEDDING_PROVIDER: "openai" }, home)).toBe("env");
  });

  it("neither file nor env means the key is absent, not empty", () => {
    expect(runtimeEnv({}, home).EMBEDDING_PROVIDER).toBeUndefined();
    expect("EMBEDDING_PROVIDER" in runtimeEnv({}, home)).toBe(false);
    expect(embeddingSource({}, home)).toBe("default");
  });

  it("an empty settings value shadows nothing", () => {
    put(JSON.stringify({ EMBEDDING_PROVIDER: "", EMBEDDING_DIM: "" }));
    expect("EMBEDDING_PROVIDER" in runtimeEnv({}, home)).toBe(false);
    expect(embeddingSource({}, home)).toBe("default");
  });

  it("an empty env value does not mask the settings file below it", () => {
    // `KEY=` in a .env is the common shape; it means "unset", not "override".
    put(JSON.stringify({ EMBEDDING_PROVIDER: "nim" }));
    expect(runtimeEnv({ EMBEDDING_PROVIDER: "" }, home).EMBEDDING_PROVIDER).toBe("nim");
    expect(embeddingSource({ EMBEDDING_PROVIDER: "" }, home)).toBe("settings");
  });
});

describe("readSettings is tolerant", () => {
  it("returns {} for a missing file", () => {
    expect(readSettings(home)).toEqual({});
    expect(readSettings(path.join(home, "nope"))).toEqual({});
  });

  it("returns {} for invalid JSON, a JSON array, and non-string values", () => {
    put("{not json");
    expect(readSettings(home)).toEqual({});
    put("[1,2,3]");
    expect(readSettings(home)).toEqual({});
    put(JSON.stringify({ EMBEDDING_PROVIDER: 5 }));
    expect(readSettings(home)).toEqual({});
    put("null");
    expect(readSettings(home)).toEqual({});
  });

  it("keeps the good entries and drops the bad ones", () => {
    put(JSON.stringify({ EMBEDDING_PROVIDER: "nim", EMBEDDING_DIM: 5, NOPE: "x" }));
    expect(readSettings(home)).toEqual({ EMBEDDING_PROVIDER: "nim" });
  });

  it("does not throw on a file that is a directory", () => {
    expect(readSettings(tmpdir())).toEqual({});
  });
});

describe("writeSettings", () => {
  it("merges rather than replaces", async () => {
    await writeSettings({ EMBEDDING_PROVIDER: "nim" }, home);
    const merged = await writeSettings({ NIM_DIM: "1024" }, home);
    expect(merged).toEqual({ EMBEDDING_PROVIDER: "nim", NIM_DIM: "1024" });
    expect(readSettings(home)).toEqual(merged);
    // and the file on disk is valid JSON
    expect(JSON.parse(readFileSync(settingsPath(home), "utf8"))).toEqual(merged);
    expect(existsSync(`${settingsPath(home)}.tmp`)).toBe(false);
  });

  it("creates the home dir when it is missing", async () => {
    const nested = path.join(home, "deep", "home");
    await writeSettings({ EMBEDDING_PROVIDER: "openai" }, nested);
    expect(readSettings(nested).EMBEDDING_PROVIDER).toBe("openai");
  });

  it("rejects an unknown key and writes nothing", async () => {
    await expect(writeSettings({ BOGUS: "x" } as never, home)).rejects.toThrow(/unknown setting "BOGUS"/);
    expect(existsSync(settingsPath(home))).toBe(false);
  });

  it("names every variable it accepts, and no key-shaped one is among them", () => {
    // The non-secret list holds knobs only; every credential lives in SECRET_KEYS.
    for (const key of SETTING_KEYS) {
      expect(key).toMatch(/^(EMBEDDING_|NIM_|OPENAI_(EMBED_MODEL|BASE_URL)|JEV_|MEMORY_(JEV|WRITE_GATE)|ENABLE_EXTRACTOR|EXTRACTOR_MODEL)/);
    }
    expect(SETTING_KEYS.some((k) => /API_KEY|_KEY|TOKEN|SECRET/i.test(k))).toBe(false);
  });
});

describe("previewEmbedding", () => {
  it("reports hash at 384 with no model for an empty env", () => {
    expect(previewEmbedding({})).toEqual({ ok: true, provider: "hash", model: null, dim: 384 });
  });

  it("refuses openai with no key, quoting the factory's own message", () => {
    const p = previewEmbedding({ EMBEDDING_PROVIDER: "openai" });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toMatch(/OPENAI_API_KEY/);
  });

  it("accepts nim with NIM_API_KEY at 2048, and resolves EMBEDDING_DIM like the factory", () => {
    expect(previewEmbedding({ EMBEDDING_PROVIDER: "nim", NIM_API_KEY: "nvapi-x" })).toEqual({
      ok: true,
      provider: "nim",
      model: "nvidia/nemotron-3-embed-1b",
      dim: 2048,
    });
    expect(previewEmbedding({ EMBEDDING_PROVIDER: "nim", NIM_API_KEY: "k", NIM_DIM: "1024" })).toMatchObject({ dim: 1024 });
    expect(previewEmbedding({ EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "k", EMBEDDING_DIM: "512" })).toMatchObject({
      dim: 512,
      model: "text-embedding-3-small",
    });
  });

  it("agrees with the factory it previews", () => {
    const env = { EMBEDDING_PROVIDER: "nim", NIM_API_KEY: "k", NIM_DIM: "1024" };
    const built = createEmbeddingProvider(env);
    expect(previewEmbedding(env)).toMatchObject({ provider: built.name, dim: built.dim });
  });
});

describe("EMBEDDING_PRESETS", () => {
  it("lists hash, openai, nim in that order, from the factory's own defaults", () => {
    expect(EMBEDDING_PRESETS.map((p) => p.provider)).toEqual(["hash", "openai", "nim"]);
    expect(EMBEDDING_PRESETS.map((p) => p.dim)).toEqual([384, 1536, 2048]);
    expect(EMBEDDING_PRESETS[0]!.keyEnv).toBeNull();
    expect(EMBEDDING_PRESETS[1]!.keyEnv).toBe("OPENAI_API_KEY");
    expect(EMBEDDING_PRESETS[2]!.keyEnv).toBe("NVIDIA_API_KEY");
    // A preset with its key in the environment builds exactly what the preset claims.
    expect(previewEmbedding({ EMBEDDING_PROVIDER: "openai", OPENAI_API_KEY: "k" })).toMatchObject({
      provider: "openai",
      model: EMBEDDING_PRESETS[1]!.model,
      dim: EMBEDDING_PRESETS[1]!.dim,
    });
  });
});

describe("byVectorDim", () => {
  const row = (embedding: number[]): Memory => ({
    id: Math.random().toString(36).slice(2),
    namespace: "t:1",
    project: null,
    kind: "note",
    knowledgeId: null,
    knowledgeSection: null,
    type: "semantic",
    text: "x",
    embedding,
    importance: 0.5,
    strength: 0.5,
    lastUsedAt: null,
    isDeleted: 0,
    visibility: "private",
    status: "active",
    pin: 0,
    createdAt: 0,
    updatedAt: 0,
  });

  it("counts every row by its width, tombstones and empty vectors included", () => {
    const s = summarize([row([1, 2, 3]), row([1, 2, 3]), row([1, 2, 3, 4]), row([])], 0);
    expect(s.byVectorDim).toEqual({ "3": 2, "4": 1, "0": 1 });
    expect(s.total).toBe(4);
  });
});

describe("two whitelists", () => {
  it("accepts a whitelisted secret", async () => {
    await writeSettings({ OPENAI_API_KEY: "sk-test" }, home);
    expect(readSettings(home).OPENAI_API_KEY).toBe("sk-test");
  });

  it("still rejects a credential-shaped name outside the whitelists", async () => {
    await expect(writeSettings({ TYPESAFE_API_KEY: "x" } as never, home)).rejects.toThrow(/unknown setting/);
    await expect(writeSettings({ JEV_API_KEY_FILE: "x" } as never, home)).rejects.toThrow(/unknown setting/);
  });

  it("reads a secret back through runtimeEnv", async () => {
    await writeSettings({ JEV_API_KEY: "jev-1" }, home);
    expect(runtimeEnv({}, home).JEV_API_KEY).toBe("jev-1");
  });

  it("lists the judge and extractor knobs", () => {
    for (const k of ["JEV_ENDPOINT", "JEV_MODEL", "MEMORY_JEV", "MEMORY_JEV_MIN", "MEMORY_WRITE_GATE", "MEMORY_WRITE_GATE_MIN", "ENABLE_EXTRACTOR", "EXTRACTOR_MODEL"]) {
      expect(SETTING_KEYS).toContain(k);
    }
  });

  it.skipIf(process.platform === "win32")("creates the file 0600 on POSIX", async () => {
    await writeSettings({ OPENAI_API_KEY: "sk-test" }, home);
    expect(statSync(settingsPath(home)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("replaces a stale 0644 tmp file instead of inheriting its mode", async () => {
    // `writeFile`'s mode applies only when it creates the file, so a tmp left behind by an
    // interrupted write is the case that decides whether settings.json really ends up 0600.
    const tmp = `${settingsPath(home)}.tmp`;
    writeFileSync(tmp, "{}", "utf8");
    chmodSync(tmp, 0o644);
    await writeSettings({ OPENAI_API_KEY: "sk-test" }, home);
    // Only the mode is asserted: the rename consumes the tmp either way, so "the tmp is
    // gone" holds with or without the fix and would never fail.
    expect(statSync(settingsPath(home)).mode & 0o777).toBe(0o600);
  });
});

describe("settings inventory", () => {
  it("masks a secret to its last four characters, and a short one to nothing at all", () => {
    expect(maskSecret("sk-abcdefgh1234")).toBe("…1234");
    // A value no longer than the tail would come back whole, which is the one thing a
    // masked read must never do.
    expect(maskSecret("abcd")).toBe("…");
    expect(maskSecret("k")).toBe("…");
  });

  it("names where each value comes from and what applying it costs", () => {
    put(JSON.stringify({ JEV_API_KEY: "jev-file-secret-7734", EMBEDDING_DIM: "1024" }));

    const entries = settingsInventory(
      { OPENAI_API_KEY: "sk-env-secret-4821", TYPESAFE_API_KEY: "typesafe-env-only-3310" },
      home,
    );
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));

    // The environment wins the merge, so that is the tail a masked read has to show.
    expect(byName.OPENAI_API_KEY).toEqual({
      name: "OPENAI_API_KEY", kind: "secret", source: "env", masked: "…4821", effect: "immediate", writable: true,
    });
    expect(byName.JEV_API_KEY).toEqual({
      name: "JEV_API_KEY", kind: "secret", source: "file", masked: "…7734", effect: "immediate", writable: true,
    });
    expect(byName.EMBEDDING_DIM).toMatchObject({ kind: "plain", source: "file", masked: null, effect: "restart" });
    expect(byName.EMBEDDING_PROVIDER).toMatchObject({ source: "default", effect: "restart", masked: null });
    expect(byName.EXTRACTOR_MODEL).toMatchObject({ source: "default", effect: "immediate" });
    // An unset credential has no value to mask and no built-in default to fall back on.
    expect(byName.NIM_API_KEY).toMatchObject({ source: "absent", masked: null });
    // Read from the environment but outside both whitelists: reported, because a blank
    // field would let the user believe nothing is set while the judge is using this key.
    expect(byName.TYPESAFE_API_KEY).toEqual({
      name: "TYPESAFE_API_KEY", kind: "secret", source: "env", masked: "…3310", effect: "immediate", writable: false,
    });
    // Not set, so not noise in the inventory.
    expect(byName.JEV_API_KEY_FILE).toBeUndefined();
  });

  it("splits the whitelists into a restart group and an immediate group", () => {
    // ADR-0009: one process, one vector space — the embedder is frozen at construction.
    // The judge and extractor knobs are read through runtimeEnv per call, so they never
    // need one.
    expect(SETTING_KEYS.filter((key) => keyEffect(key) === "restart")).toEqual([
      "EMBEDDING_PROVIDER", "EMBEDDING_DIM", "NIM_DIM",
      "OPENAI_EMBED_MODEL", "NIM_EMBED_MODEL",
      "OPENAI_BASE_URL", "NIM_BASE_URL",
      "NIM_INPUT_TYPE", "NIM_TRUNCATE",
    ]);
    for (const key of SECRET_KEYS) expect(keyEffect(key)).toBe("immediate");
    expect(keyEffect("EXTRACTOR_MODEL")).toBe("immediate");
  });
});

// One temp `home` and one temp `.env` per case: neither the real ~/.ai-memory nor the
// repo's own .env is ever in reach.
describe("adoptEnvKeys", () => {
  const envFile = () => path.join(home, ".env");
  const putEnv = (text: string) => writeFileSync(envFile(), text, "utf8");

  it("adopts the whitelisted lines and leaves every other name in .env", async () => {
    putEnv("JEV_API_KEY=abc\nMEMORY_JEV=true\nTYPESAFE_API_KEY=legacy\nHOME_THING=x\n");

    const result = await adoptEnvKeys({ home, envFile: envFile() });

    expect(result).toEqual({
      adopted: ["JEV_API_KEY", "MEMORY_JEV"],
      notAdopted: [],
      backupPath: `${envFile()}.bak`,
      restartRequired: true,
    });
    expect(readSettings(home)).toEqual({ JEV_API_KEY: "abc", MEMORY_JEV: "true" });

    const lines = readFileSync(envFile(), "utf8").split("\n");
    expect(lines).toContain("#JEV_API_KEY=abc");
    expect(lines).toContain("#MEMORY_JEV=true");
    // The whitelist boundary is the point: a credential-shaped name on neither list stays
    // enabled in .env and never reaches settings.json.
    expect(lines).toContain("TYPESAFE_API_KEY=legacy");
    expect(readEnvFile(envFile()).filter((e) => e.enabled).map((e) => e.name)).toEqual(["TYPESAFE_API_KEY", "HOME_THING"]);
    expect(readSettings(home)).not.toHaveProperty("TYPESAFE_API_KEY");
    expect(existsSync(`${envFile()}.bak`)).toBe(true);
  });

  it("does nothing, and writes nothing, when no whitelisted key is present", async () => {
    putEnv("TYPESAFE_API_KEY=legacy\nHOME_THING=x\n");
    const before = readFileSync(envFile());

    const result = await adoptEnvKeys({ home, envFile: envFile() });

    expect(result).toEqual({ adopted: [], notAdopted: [], backupPath: null, restartRequired: true });
    expect(readFileSync(envFile()).equals(before)).toBe(true);
    expect(existsSync(settingsPath(home))).toBe(false);
    expect(existsSync(`${envFile()}.bak`)).toBe(false);
  });

  it("writes settings before it touches .env, so a failed write leaves the key enabled", async () => {
    // A `home` whose parent is a regular file: mkdir/writeSettings cannot succeed, so this is
    // where the order of the two writes becomes visible. With them swapped, `.env` would be
    // commented, .env.bak written, and the value the line held would exist nowhere —
    // settings.json never got it.
    const blocker = path.join(home, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    const blockedHome = path.join(blocker, "home");
    putEnv("JEV_API_KEY=abc\n");

    await expect(adoptEnvKeys({ home: blockedHome, envFile: envFile() })).rejects.toThrow();

    expect(readFileSync(envFile(), "utf8")).toBe("JEV_API_KEY=abc\n");
    expect(readEnvFile(envFile()).filter((e) => e.enabled).map((e) => e.name)).toEqual(["JEV_API_KEY"]);
    expect(existsSync(settingsPath(blockedHome))).toBe(false);
    expect(existsSync(`${envFile()}.bak`)).toBe(false);
  });

  it("leaves a line .env cannot read back exactly enabled, and reports it", async () => {
    // `parseValue` does not interpret escapes, so this reads as `ab\` — adopting it would
    // persist the wrong key and comment the real line out.
    putEnv('JEV_API_KEY="ab\\"cd"\nMEMORY_JEV=true\n');

    const result = await adoptEnvKeys({ home, envFile: envFile() });

    expect(result).toEqual({
      adopted: ["MEMORY_JEV"],
      notAdopted: ["JEV_API_KEY"],
      backupPath: `${envFile()}.bak`,
      restartRequired: true,
    });
    expect(readSettings(home)).toEqual({ MEMORY_JEV: "true" });
    expect(readSettings(home)).not.toHaveProperty("JEV_API_KEY");

    const lines = readFileSync(envFile(), "utf8").split("\n");
    expect(lines).toContain('JEV_API_KEY="ab\\"cd"');
    expect(lines).toContain("#MEMORY_JEV=true");
    expect(readEnvFile(envFile()).filter((e) => e.enabled).map((e) => e.name)).toEqual(["JEV_API_KEY"]);
  });

  it("leaves a line whose quote is never closed enabled, and reports it", async () => {
    // `parseValue` finds no closing quote and falls through to the unquoted branch, so this
    // reads `'sk-1` — the opener glued onto the value. Adopting that would persist the quote
    // and comment the one line that still has the real key.
    putEnv("JEV_API_KEY='sk-1\nMEMORY_JEV=true\n");

    const result = await adoptEnvKeys({ home, envFile: envFile() });

    expect(result).toEqual({
      adopted: ["MEMORY_JEV"],
      notAdopted: ["JEV_API_KEY"],
      backupPath: `${envFile()}.bak`,
      restartRequired: true,
    });
    expect(readSettings(home)).toEqual({ MEMORY_JEV: "true" });
    expect(readFileSync(envFile(), "utf8")).toContain("JEV_API_KEY='sk-1\n");
    expect(readEnvFile(envFile()).filter((e) => e.enabled).map((e) => e.name)).toEqual(["JEV_API_KEY"]);
  });

  it("leaves a line with text after the closing quote enabled, and reports it", async () => {
    // `parseValue` stops at the closing quote, so this reads `abc` while the line says more:
    // the value that moved would be a truncation of what the user wrote.
    putEnv('JEV_API_KEY="abc"def\nMEMORY_JEV=true\n');

    const result = await adoptEnvKeys({ home, envFile: envFile() });

    expect(result).toEqual({
      adopted: ["MEMORY_JEV"],
      notAdopted: ["JEV_API_KEY"],
      backupPath: `${envFile()}.bak`,
      restartRequired: true,
    });
    expect(readSettings(home)).not.toHaveProperty("JEV_API_KEY");
    expect(readFileSync(envFile(), "utf8")).toContain('JEV_API_KEY="abc"def\n');
    expect(readEnvFile(envFile()).filter((e) => e.enabled).map((e) => e.name)).toEqual(["JEV_API_KEY"]);
  });

  it("still refuses a double-quoted \\n, which the loader expands and parseValue does not", async () => {
    // The raw text does reconstruct `line1\nline2`, so exactness alone would let it through;
    // `process.loadEnvFile` turns that `\n` into a newline, so the value that landed in
    // settings.json would differ from what .env gives. This is the backslash rule's job.
    putEnv('JEV_API_KEY="line1\\nline2"\n');

    const result = await adoptEnvKeys({ home, envFile: envFile() });

    expect(result).toEqual({ adopted: [], notAdopted: ["JEV_API_KEY"], backupPath: null, restartRequired: true });
    expect(existsSync(settingsPath(home))).toBe(false);
    expect(readEnvFile(envFile()).filter((e) => e.enabled).map((e) => e.name)).toEqual(["JEV_API_KEY"]);
  });

  it("adopts properly quoted values, both quote shapes, and comments them out", async () => {
    putEnv('JEV_API_KEY="a b c"\nOPENAI_API_KEY=\'d e\'\n');

    const result = await adoptEnvKeys({ home, envFile: envFile() });

    expect(result).toEqual({
      adopted: ["JEV_API_KEY", "OPENAI_API_KEY"],
      notAdopted: [],
      backupPath: `${envFile()}.bak`,
      restartRequired: true,
    });
    expect(readSettings(home)).toEqual({ JEV_API_KEY: "a b c", OPENAI_API_KEY: "d e" });
    expect(readFileSync(envFile(), "utf8")).toBe('#JEV_API_KEY="a b c"\n#OPENAI_API_KEY=\'d e\'\n');
  });

  it("adopts an unquoted value with a trailing space and # comment", async () => {
    putEnv("NIM_DIM=1024 # from an older setup\n");

    const result = await adoptEnvKeys({ home, envFile: envFile() });

    expect(result).toEqual({
      adopted: ["NIM_DIM"],
      notAdopted: [],
      backupPath: `${envFile()}.bak`,
      restartRequired: true,
    });
    expect(readSettings(home)).toEqual({ NIM_DIM: "1024" });
    expect(readFileSync(envFile(), "utf8")).toBe("#NIM_DIM=1024 # from an older setup\n");
  });
});
