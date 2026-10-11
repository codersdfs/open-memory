import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SETTING_KEYS,
  settingsPath,
  readSettings,
  writeSettings,
  embedEnv,
  embeddingSource,
} from "../src/core/settings.js";
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
    expect(embedEnv({}, home).EMBEDDING_PROVIDER).toBe("nim");
    expect(embeddingSource({}, home)).toBe("settings");
  });

  it("lets a real environment variable beat the file", () => {
    put(JSON.stringify({ EMBEDDING_PROVIDER: "nim", EMBEDDING_DIM: "1024" }));
    const merged = embedEnv({ EMBEDDING_PROVIDER: "openai" }, home);
    expect(merged.EMBEDDING_PROVIDER).toBe("openai");
    expect(merged.EMBEDDING_DIM).toBe("1024");
    expect(embeddingSource({ EMBEDDING_PROVIDER: "openai" }, home)).toBe("env");
  });

  it("neither file nor env means the key is absent, not empty", () => {
    expect(embedEnv({}, home).EMBEDDING_PROVIDER).toBeUndefined();
    expect("EMBEDDING_PROVIDER" in embedEnv({}, home)).toBe(false);
    expect(embeddingSource({}, home)).toBe("default");
  });

  it("an empty settings value shadows nothing", () => {
    put(JSON.stringify({ EMBEDDING_PROVIDER: "", EMBEDDING_DIM: "" }));
    expect("EMBEDDING_PROVIDER" in embedEnv({}, home)).toBe(false);
    expect(embeddingSource({}, home)).toBe("default");
  });

  it("an empty env value does not mask the settings file below it", () => {
    // `KEY=` in a .env is the common shape; it means "unset", not "override".
    put(JSON.stringify({ EMBEDDING_PROVIDER: "nim" }));
    expect(embedEnv({ EMBEDDING_PROVIDER: "" }, home).EMBEDDING_PROVIDER).toBe("nim");
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

  it("rejects a key-shaped key, naming the variable and the environment", async () => {
    await expect(writeSettings({ OPENAI_API_KEY: "sk-x" } as never, home)).rejects.toThrow(/OPENAI_API_KEY.*environment/);
    await expect(writeSettings({ MY_TOKEN: "t" } as never, home)).rejects.toThrow(/MY_TOKEN.*environment/);
    expect(existsSync(settingsPath(home))).toBe(false);
  });

  it("names every variable it accepts, and no key-shaped one is among them", () => {
    for (const key of SETTING_KEYS) expect(key).toMatch(/^(EMBEDDING_|NIM_|OPENAI_(EMBED_MODEL|BASE_URL))/);
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
