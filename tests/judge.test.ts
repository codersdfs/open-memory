import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { jevKeep, jevApiKey, jevEnabled, importanceFor } from "../src/core/judgment/judge.js";
import { writeSettings } from "../src/core/settings.js";
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const ok = (noul: number): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ model: "jev-test", answers: { keep: { type: "noul", noul } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe("jev judge", () => {
  it("returns null with no key — fail-open, never blocks a write", async () => {
    delete process.env.JEV_API_KEY_FILE;
    delete process.env.TYPESAFE_API_KEY;
    expect(jevApiKey()).toBeUndefined();
    const f = ok(0.9);
    expect(await jevKeep("anything", { fetchImpl: f })).toBeNull();
  });

  it("returns the keep probability", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    expect(await jevKeep("user lives in Berlin", { fetchImpl: ok(0.83) })).toEqual({
      keep: 0.83,
      model: "jev-test",
    });
  });

  it("clamps a nonsense probability instead of propagating it", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    expect((await jevKeep("x", { fetchImpl: ok(1.4) }))!.keep).toBe(1);
  });

  it("is disabled by MEMORY_JEV=false without touching the network", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    process.env.MEMORY_JEV = "false";
    expect(jevEnabled()).toBe(false);
    let called = false;
    const spy: typeof fetch = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
    expect(await jevKeep("x", { fetchImpl: spy })).toBeNull();
    expect(called).toBe(false);
  });

  it("fails open on a server error, after retrying", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    let n = 0;
    const boom: typeof fetch = (async () => {
      n++;
      return new Response("upstream down", { status: 500 });
    }) as typeof fetch;
    expect(await jevKeep("x", { fetchImpl: boom, retries: 1 })).toBeNull();
    expect(n).toBe(2);
  });

  it("does not retry a 401", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    let n = 0;
    const bad: typeof fetch = (async () => {
      n++;
      return new Response("unauthorized", { status: 401 });
    }) as typeof fetch;
    expect(await jevKeep("x", { fetchImpl: bad, retries: 2 })).toBeNull();
    expect(n).toBe(1);
  });

  it("returns null when the answer is not a noul", async () => {
    process.env.TYPESAFE_API_KEY = "k";
    const weird: typeof fetch = (async () =>
      new Response(JSON.stringify({ model: "m", answers: { keep: { type: "score", score: 3 } } }), {
        status: 200,
      })) as typeof fetch;
    expect(await jevKeep("x", { fetchImpl: weird, retries: 0 })).toBeNull();
  });

  it("maps keep to importance, weakly-judged memories stored weak", () => {
    expect(importanceFor(1)).toBe(0.9);
    expect(importanceFor(0.5)).toBe(0.65);
    expect(importanceFor(0)).toBe(0.4);
  });

  it("reads the key from JEV_API_KEY_FILE, not from .env", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jev-"));
    const f = path.join(dir, "key.txt");
    await fs.writeFile(f, " secret-key\n", "utf8");
    process.env.JEV_API_KEY_FILE = f;
    delete process.env.TYPESAFE_API_KEY;
    expect(jevApiKey()).toBe("secret-key");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("names an unreadable key file instead of silently storing unjudged", async () => {
    process.env.JEV_API_KEY_FILE = path.join(os.tmpdir(), "definitely-not-here", "key.txt");
    delete process.env.TYPESAFE_API_KEY;
    expect(jevApiKey()).toBeUndefined();
  });

  // The console writes credentials and knobs to settings.json, so the judge reads the
  // same merged environment the embedding factory does — at call time, so a key typed
  // into the console judges the next write without a restart.
  it("honors a key written in settings.json, not just the environment", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "jev-home-"));
    process.env.AI_MEMORY_HOME = home;
    delete process.env.JEV_API_KEY;
    await writeSettings({ JEV_API_KEY: "jev-from-file" }, home);
    let sent: Record<string, string> = {};
    const spy = (async (_u: unknown, init: RequestInit) => {
      sent = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ model: "jev-test", answers: { keep: { type: "noul", noul: 0.9 } } }), { status: 200 });
    }) as unknown as typeof fetch;
    await jevKeep("anything", { fetchImpl: spy });
    expect(Object.values(sent).join(" ")).toContain("jev-from-file");
    await fs.rm(home, { recursive: true, force: true });
  });

  it("reads MEMORY_JEV from settings.json", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "jev-home-"));
    process.env.AI_MEMORY_HOME = home;
    delete process.env.MEMORY_JEV;
    await writeSettings({ MEMORY_JEV: "false" }, home);
    expect(jevEnabled()).toBe(false);
    await fs.rm(home, { recursive: true, force: true });
  });
});
