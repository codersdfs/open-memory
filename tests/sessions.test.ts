import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { listSessions, readSession, SessionError } from "../src/core/sessions.js";
import { buildServer } from "../src/api/server.js";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";

/** pi's session format is not ours to own — the fixtures are deliberately odd. */
const line = (o: unknown) => JSON.stringify(o) + "\n";
const TURNS = [
  line({ type: "message", role: "user", timestamp: 1000, message: { content: "where does the user live?" } }),
  line({ type: "message", role: "assistant", tool: "fabric_exec", timestamp: 2000, content: "calling memory_search" }),
  line({ type: "toolResult", role: "toolResult", tool: "memory_search", timestamp: 3000, isError: false, text: "Berlin" }),
  "not json at all\n",
  line({ type: "message", role: "assistant", timestamp: 4000, text: "x".repeat(1200) }),
].join("");

let root = "";
let base = "";
let close = () => {};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ai-memory-sessions-"));
  await writeFile(join(root, "older.jsonl"), TURNS);
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub", "newer.jsonl"), line({ type: "message", role: "user", timestamp: 5000, text: "hi" }));
  await writeFile(join(root, "notes.txt"), "not a session\n");
  // distinct mtimes, so "newest first" is a fact and not an accident of write order
  const { utimes } = await import("node:fs/promises");
  await utimes(join(root, "older.jsonl"), 1e9, 1e9);
  await utimes(join(root, "sub", "newer.jsonl"), 2e9, 2e9);

  const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
  const { app } = await buildServer({ service: svc });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  close = () => new Promise<void>((r) => app.close(() => r()));
});

afterAll(async () => {
  await close();
  await rm(root, { recursive: true, force: true });
});

describe("sessions: core", () => {
  it("lists only .jsonl, newest first", async () => {
    const { sessions } = await listSessions({ root });
    expect(sessions.map((s) => s.id)).toEqual(["sub/newer.jsonl", "older.jsonl"]);
    expect(sessions.every((s) => s.file.endsWith(".jsonl"))).toBe(true);
  });

  it("pages the list", async () => {
    const page = await listSessions({ root, limit: 1, offset: 1 });
    expect(page.total).toBe(2);
    expect(page.sessions.map((s) => s.id)).toEqual(["older.jsonl"]);
  });

  it("reads turns with index, role, tool, timestamp and clipped text", async () => {
    const s = await readSession("older.jsonl", { root });
    expect(s.turns.length).toBe(5);
    expect(s.turns[0]).toMatchObject({ index: 0, role: "user", tool: null, timestamp: 1000 });
    expect(s.turns[1]!.tool).toBe("fabric_exec");
    expect(s.turns[2]!.text).toBe("Berlin");
    // a malformed line is data, not an exception
    expect(s.turns[3]!.text).toContain("not json");
    expect(s.turns[3]!.isError).toBe(true);
    // clipped by default
    expect(s.turns[4]!.text.length).toBeLessThan(1200);
    expect(s.turns[4]!.text.endsWith("…")).toBe(true);
  });

  it("full=1 bypasses the clip", async () => {
    const s = await readSession("older.jsonl", { root, maxChars: Number.POSITIVE_INFINITY });
    expect(s.turns[4]!.text.length).toBe(1200);
  });

  it("pages turns by offset/limit", async () => {
    const s = await readSession("older.jsonl", { root, offset: 1, limit: 2 });
    expect(s.total).toBe(5);
    expect(s.turns.map((t) => t.index)).toEqual([1, 2]);
  });

  it("reports truncated when the byte cap cuts the file", async () => {
    const s = await readSession("older.jsonl", { root, maxBytes: 120 });
    expect(s.truncated).toBe(true);
    expect(s.turns.length).toBeLessThan(5);
  });

  it("refuses ids that escape the root", async () => {
    for (const bad of ["../secrets.jsonl", "..\\secrets.jsonl", "sub/../../etc/passwd", "/etc/passwd", "C:/Windows/win.ini", "sub", "notes.txt"]) {
      await expect(readSession(bad, { root })).rejects.toBeInstanceOf(SessionError);
    }
  });

  it("does not exist is not-found, not a read", async () => {
    await expect(readSession("ghost.jsonl", { root })).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("sessions: http", () => {
  const prev = process.env.PI_SESSIONS;
  beforeAll(() => { process.env.PI_SESSIONS = root; });
  afterAll(() => { if (prev === undefined) delete process.env.PI_SESSIONS; else process.env.PI_SESSIONS = prev; });

  it("GET /sessions lists the timeline", async () => {
    const res = await fetch(`${base}/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: { id: string }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.sessions[0]!.id).toBe("sub/newer.jsonl");
  });

  it("GET /sessions/:id returns paged turns", async () => {
    const res = await fetch(`${base}/sessions/${encodeURIComponent("older.jsonl")}?offset=0&limit=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; turns: unknown[] };
    expect(body.total).toBe(5);
    expect(body.turns.length).toBe(2);
  });

  it("GET /sessions/:id answers 400 on a traversal id and 404 on a miss", async () => {
    expect((await fetch(`${base}/sessions/${encodeURIComponent("../secret.jsonl")}`)).status).toBe(400);
    expect((await fetch(`${base}/sessions/ghost.jsonl`)).status).toBe(404);
  });
});
