import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { jevKeep, jevRelation, jevApiKey, jevEnabled, importanceFor, validateJevKey } from "../src/core/judgment/judge.js";
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

// Key precedence is JEV_API_KEY, then JEV_API_KEY_FILE, then TYPESAFE_API_KEY, and a
// judgement switched off is not one either. A case that exercises a fallback has to clear
// all four names, or it only passes while the developer's shell happens not to set them:
// `MEMORY_JEV=false` in a shell makes every `jevKeep` below answer null without a call.
function useTypesafeKey(): void {
  delete process.env.JEV_API_KEY;
  delete process.env.JEV_API_KEY_FILE;
  delete process.env.MEMORY_JEV;
  process.env.TYPESAFE_API_KEY = "k";
}

describe("jev judge", () => {
  it("returns null with no key — fail-open, never blocks a write", async () => {
    delete process.env.JEV_API_KEY;
    delete process.env.JEV_API_KEY_FILE;
    delete process.env.TYPESAFE_API_KEY;
    expect(jevApiKey()).toBeUndefined();
    const f = ok(0.9);
    expect(await jevKeep("anything", { fetchImpl: f })).toBeNull();
  });

  it("returns the keep probability", async () => {
    useTypesafeKey();
    expect(await jevKeep("user lives in Berlin", { fetchImpl: ok(0.83) })).toEqual({
      keep: 0.83,
      model: "jev-test",
    });
  });

  it("clamps a nonsense probability instead of propagating it", async () => {
    useTypesafeKey();
    expect((await jevKeep("x", { fetchImpl: ok(1.4) }))!.keep).toBe(1);
  });

  it("is disabled by MEMORY_JEV=false without touching the network", async () => {
    useTypesafeKey();
    // After the helper, which deletes it: setting this first would be undone there.
    process.env.MEMORY_JEV = "false";
    expect(jevEnabled()).toBe(false);
    let called = false;
    const spy: typeof fetch = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
    expect(await jevKeep("x", { fetchImpl: spy })).toBeNull();
    expect(called).toBe(false);
  });

  it("fails open on a server error, after retrying", async () => {
    useTypesafeKey();
    let n = 0;
    const boom: typeof fetch = (async () => {
      n++;
      return new Response("upstream down", { status: 500 });
    }) as typeof fetch;
    expect(await jevKeep("x", { fetchImpl: boom, retries: 1 })).toBeNull();
    expect(n).toBe(2);
  });

  it("does not retry a 401", async () => {
    useTypesafeKey();
    let n = 0;
    const bad: typeof fetch = (async () => {
      n++;
      return new Response("unauthorized", { status: 401 });
    }) as typeof fetch;
    expect(await jevKeep("x", { fetchImpl: bad, retries: 2 })).toBeNull();
    expect(n).toBe(1);
  });

  it("returns null when the answer is not a noul", async () => {
    useTypesafeKey();
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
    delete process.env.JEV_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    expect(jevApiKey()).toBe("secret-key");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("names an unreadable key file instead of silently storing unjudged", async () => {
    process.env.JEV_API_KEY_FILE = path.join(os.tmpdir(), "definitely-not-here", "key.txt");
    delete process.env.JEV_API_KEY;
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
    // The environment wins the merge, so MEMORY_JEV has to be unset for the file to answer.
    delete process.env.MEMORY_JEV;
    await writeSettings({ MEMORY_JEV: "false" }, home);
    expect(jevEnabled()).toBe(false);
    await fs.rm(home, { recursive: true, force: true });
  });
});

// The console validates a candidate key before it stores it: the judge fails open, so a
// stored-but-wrong key would silently store every memory unjudged.
describe("validateJevKey", () => {
  it("makes exactly one call, carrying the candidate key", async () => {
    let calls = 0;
    let auth = "";
    const spy = (async (_url: unknown, init: RequestInit) => {
      calls++;
      auth = String((init.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ model: "jev-test", answers: { keep: { type: "noul", noul: 0.9 } } }), { status: 200 });
    }) as unknown as typeof fetch;

    expect(await validateJevKey("jev-candidate-9001", { fetchImpl: spy })).toEqual({ ok: true });
    expect(calls).toBe(1);
    expect(auth).toBe("Bearer jev-candidate-9001");
  });

  it("answers instead of throwing when the key is rejected, and never echoes it", async () => {
    const rejected = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

    const verdict = await validateJevKey("jev-candidate-9001", { fetchImpl: rejected });

    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("401");
    // This string can reach an HTTP response body, so the key must not be in it.
    expect(verdict.error).not.toContain("jev-candidate-9001");
  });

  it("treats an unreachable endpoint as a failed validation", async () => {
    const offline = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.typesafe.ai");
    }) as unknown as typeof fetch;

    const verdict = await validateJevKey("jev-candidate-9001", { fetchImpl: offline });

    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain("ENOTFOUND");
  });
});

// The write path asks one question per pair, and the three labels are probabilities in
// the same batch: three HTTP calls to answer one question would cost more than the memory
// is worth.
const noulAnswers = (scores: Record<string, number>): typeof fetch =>
  (async () =>
    new Response(
      JSON.stringify({
        model: "jev-test",
        answers: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { type: "noul", noul: v }])),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

describe("jevRelation", () => {
  it("picks the confident relation", async () => {
    useTypesafeKey();
    const r = await jevRelation("use pnpm", "we moved to npm", { fetchImpl: noulAnswers({ duplicate: 0.05, refines: 0.1, contradicts: 0.85 }) });
    expect(r?.relation).toBe("contradicts");
    expect(r?.scores.contradicts).toBe(0.85);
  });

  it("returns a null relation when two labels tie", async () => {
    useTypesafeKey();
    const r = await jevRelation("use pnpm", "we moved to npm", { fetchImpl: noulAnswers({ duplicate: 0.6, refines: 0.5, contradicts: 0.1 }) });
    expect(r?.relation).toBeNull();
  });

  it("sends all three labels in one call, with the pair in the state", async () => {
    useTypesafeKey();
    let body: { state?: string; questions?: Record<string, unknown> } = {};
    const spy = (async (_u: unknown, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as typeof body;
      return new Response(JSON.stringify({ answers: { duplicate: { type: "noul", noul: 0.1 }, refines: { type: "noul", noul: 0.1 }, contradicts: { type: "noul", noul: 0.9 } } }), { status: 200 });
    }) as unknown as typeof fetch;
    await jevRelation("old sentence", "new sentence", { fetchImpl: spy });
    expect(Object.keys(body.questions ?? {}).sort()).toEqual(["contradicts", "duplicate", "refines"]);
    expect(String(body.state)).toContain("OLD: old sentence");
    expect(String(body.state)).toContain("NEW: new sentence");
  });

  it("is disabled by MEMORY_JEV=false without touching the network", async () => {
    useTypesafeKey();
    process.env.MEMORY_JEV = "false";
    let called = false;
    const spy = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    expect(await jevRelation("a", "b", { fetchImpl: spy })).toBeNull();
    expect(called).toBe(false);
  });
});
