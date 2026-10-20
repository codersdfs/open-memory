import { describe, it, expect } from "vitest";
import { Extractor, resolveRelativeDate, stampRelativeDate } from "../src/core/extraction/extractor.js";
import { MemoryService } from "../src/core/memoryService.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { writeSettings } from "../src/core/settings.js";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("extraction gate", () => {
  const ex = new Extractor();

  it("keeps durable facts", async () => {
    const kept = await ex.extract("I live in Berlin. I prefer dark mode. Remember to run npm test before commit.");
    const texts = kept.map((m) => m.text);
    expect(texts).toContain("I live in Berlin");
    expect(texts).toContain("I prefer dark mode");
    expect(texts.some((t) => t.includes("run npm test before commit"))).toBe(true);
    expect(kept.find((m) => m.text.includes("Berlin"))?.type).toBe("semantic");
  });

  it("drops questions and agent instructions", async () => {
    const kept = await ex.extract("Where does the user live? Read the file first. Use the hash provider.");
    expect(kept).toEqual([]);
  });

  it("drops identifier soup", () => {
    expect(Extractor.isWorthKeeping("memoryService.ts:42")).toBe(false);
    expect(Extractor.isWorthKeeping("memoryService.ts")).toBe(false);
    expect(Extractor.isWorthKeeping("I live in Berlin.")).toBe(true);
  });

  // Measured against the real store: 180 of 335 rows were structurally not memories —
  // markdown tables, headings, bullet slices, prompt-wrapper XML, bench fixtures — and
  // the wording rules let almost all of them through. Structure is the signal a fact
  // cannot fake, so it is checked first.
  it("drops the structural shapes that made up the measured junk", () => {
    expect(Extractor.isWorthKeeping("| 层 | 位置 | 状态 |")).toBe(false);
    expect(Extractor.isWorthKeeping("## 两条会一直生效的规矩")).toBe(false);
    expect(Extractor.isWorthKeeping("- npm:pi-pretty-tui → removed")).toBe(false);
    expect(Extractor.isWorthKeeping('<skill name="context-mode" location="C:/x">')).toBe(false);
    expect(Extractor.isWorthKeeping("Session 3: refactored the retrieval pipeline.")).toBe(false);
    expect(Extractor.isWorthKeeping("```json")).toBe(false);
    // A table continuation has no leading pipe; a pipe anywhere is still the table's.
    expect(Extractor.isWorthKeeping("状态 | 已修 | 不适用 |")).toBe(false);
  });

  // The one trade-off the audit forced: 57.6% of the store has no sentence terminator and
  // most of it is a mid-sentence slice. A short line without a terminator is dropped unless
  // an exception below proves it is knowledge.
  it("drops a short line with no sentence end", () => {
    expect(Extractor.isWorthKeeping("user's cat is named Mimi")).toBe(false); // a fact, but shaped like a slice
    expect(Extractor.isWorthKeeping("frank 的机器是 Windows，路径一律反斜杠")).toBe(false);
    // A first-person fact is the one short, unpunctuated shape that survives: chat turns
    // routinely drop the period exactly there, and it is the row the store exists for.
    // The hedged form is a reaction, not a fact, and is still dropped.
    expect(Extractor.isWorthKeeping("I live in Berlin")).toBe(true);
    expect(Extractor.isWorthKeeping("I am not sure")).toBe(false);
    // Terminator, standing order, when-clause, dated line and self-contained procedure
    // survive the length rule.
    expect(Extractor.isWorthKeeping("frank 的机器是 Windows，路径一律反斜杠。")).toBe(true);
    expect(Extractor.isWorthKeeping("frank 跟 agent 说话用中文，他自己输入用英文。")).toBe(true);
  });

  it("keeps a normal Chinese sentence and drops a Chinese lead-in", () => {
    expect(Extractor.isWorthKeeping("用户偏好简体中文回复。")).toBe(true);
    expect(Extractor.isWorthKeeping("两条决定记进 ledger：")).toBe(false); // colon is a lead-in, not an end
    expect(Extractor.isWorthKeeping("今天下午三点开评审会。")).toBe(true);
  });

  // Measured against a real store: these scored 0.07-0.21 with the judge and were
  // still stored, because the judge has no key by default and the regex let them in.
  it("drops a spoken question that has no question mark", () => {
    expect(Extractor.isWorthKeeping("what next to ship this")).toBe(false);
    expect(Extractor.isWorthKeeping("how to look at it")).toBe(false);
    expect(Extractor.isWorthKeeping("now finish the task")).toBe(false); // leading adverb + verb
    expect(Extractor.isWorthKeeping("continue")).toBe(false); // a bare go-on
    expect(Extractor.isWorthKeeping("give me a compare list of this and other agent memory")).toBe(false);
    expect(Extractor.isWorthKeeping("is the memory system vector")).toBe(false);
  });

  // The exceptions carry more weight than the rule: these open with a word that
  // would otherwise drop them, and all three are exactly what the store is for.
  it("keeps a procedure, an order, and a dated decision", () => {
    expect(Extractor.isWorthKeeping("How to deploy the memory UI: npm run memory:ui")).toBe(true);
    expect(Extractor.isWorthKeeping("Do not force push to main")).toBe(true);
    expect(Extractor.isWorthKeeping("Don't commit the .env file")).toBe(true);
    expect(Extractor.isWorthKeeping("May 5 we decided to drop qdrant")).toBe(true);
  });

  // "how to X" is the hard pair: same opener, opposite meaning. The colon separates
  // a procedure carrying its steps from a question missing its answer.
  it("keeps a when-clause that continues into an instruction", () => {
    expect(Extractor.isWorthKeeping("When user says save this, call memory.save with importance 0.8")).toBe(true);
    expect(Extractor.isWorthKeeping("Whenever the daemon is stale, restart it")).toBe(true);
    expect(Extractor.isWorthKeeping("when to ship this")).toBe(false);
    expect(Extractor.isWorthKeeping("what does agent.md tell u")).toBe(false);
  });

  // Same principle on the instruction rule: an instruction that carries its own
  // how is a note worth keeping ("Start the daemon with `x`"), one that does not is
  // scaffolding. A real entry in the store was the former.
  it("keeps an instruction that carries its own how", () => {
    expect(Extractor.isWorthKeeping("Start the daemon with `ai-memory daemon start`")).toBe(true);
    expect(Extractor.isWorthKeeping("Start ai-memory with `npx tsx src/api/server.ts` in C:/memory")).toBe(true);
    expect(Extractor.isWorthKeeping("Read the file first")).toBe(false);
    expect(Extractor.isWorthKeeping("put the jev system into this repo")).toBe(false);
  });

  it("drops 'how to' with no answer attached", () => {
    expect(Extractor.isWorthKeeping("how to look at it")).toBe(false);
    expect(Extractor.isWorthKeeping("what to do when the daemon is stale")).toBe(false);
    expect(Extractor.isWorthKeeping("How to deploy the memory UI: npm run memory:ui")).toBe(true);
  });

  // The store kept 79 memories and almost no methods: the hook only saw the user's
  // half of the turn, and a reply that did arrive had its conclusion past the
  // first-six-sentences cut. Ranked scan + the conclusion pattern cover both.
  it("keeps a fix buried at the end of a long reply, as procedural", async () => {
    const chatter =
      "Let me look at the file. The daemon looks slow here. I will check the logs. " +
      "The port reads wrong. Let me read the config. Nothing obvious yet. " +
      "I will grep for the writer. The batch shows three failures. Checking the schema next.";
    const kept = await ex.extract(
      chatter +
        " The fix was to restart the daemon after editing the extractor." +
        " Root cause: the server runs tsx from src, so a dist-only edit never loads.",
    );
    const fix = kept.find((m) => m.text.includes("The fix was"));
    expect(fix?.type).toBe("procedural");
    expect(fix?.importance).toBe(0.7);
  });

  it("caps one turn at maxPerTurn", async () => {
    const many = "I like tea. I like coffee. I like water. I like juice. I like milk. I like soda.";
    expect((await ex.extract(many)).length).toBeLessThanOrEqual(3);
  });

  // Local noon on 2026-10-19: the local calendar day is the same in every timezone the
  // suite can run in, so the expected dates do not depend on the machine.
  const REF = new Date(2026, 9, 19, 12, 0, 0).getTime();

  // "昨天" never becomes a date on its own: a week later the row still says 昨天 and no
  // query can find "what happened on the 18th". The reference date has to come from the
  // caller — the hook may replay a turn — and Date.now() is only the fallback.
  it("resolves relative time against the reference date", () => {
    expect(resolveRelativeDate("昨天部署了检索管线", REF)).toBe("2026-10-18");
    expect(resolveRelativeDate("上周合并了三个 PR", REF)).toBe("2026-10-12");
    expect(resolveRelativeDate("明天开始写文档", REF)).toBe("2026-10-20");
    expect(resolveRelativeDate("下个月发版", REF)).toBe("2026-11-19");
    expect(resolveRelativeDate("yesterday we shipped v2", REF)).toBe("2026-10-18");
    expect(resolveRelativeDate("next month we ship", REF)).toBe("2026-11-19");
    expect(resolveRelativeDate("the store has 335 rows", REF)).toBe(null);
  });

  it("clamps a month shift to the last valid day", () => {
    const jan31 = new Date(2026, 0, 31, 12, 0, 0).getTime();
    expect(resolveRelativeDate("上个月发版", jan31)).toBe("2025-12-31");
  });

  it("stamps the resolved date into the text and the tag", () => {
    const stamped = stampRelativeDate("昨天部署了检索管线", REF);
    expect(stamped.text).toBe("昨天部署了检索管线 (at:2026-10-18)");
    expect(stamped.tags).toEqual(["at:2026-10-18"]);
    expect(stampRelativeDate("the store has 335 rows", REF)).toEqual({ text: "the store has 335 rows", tags: [] });
  });

  it("stamps the date into every extracted memory and defaults the reference to now", async () => {
    const kept = await ex.extract("昨天我把检索管线合并进 main 分支了。", REF);
    expect(kept).toHaveLength(1);
    expect(kept[0].text).toBe("昨天我把检索管线合并进 main 分支了。 (at:2026-10-18)");
    expect(kept[0].tags).toContain("at:2026-10-18");
    // No reference passed: the default is still a real date, not a literal "now".
    const now = await ex.extract("今天把检索管线合并进 main 分支了。");
    expect(now[0]?.text).toMatch(/\(at:\d{4}-\d{2}-\d{2}\)$/);
  });

  // The gate exists to stop the extractor from minting junk, not to police what the user
  // or a tool asked to store: an explicit save of the same shape must still land.
  it("does not gate explicit writes", async () => {
    const svc = new MemoryService({ store: new InMemoryVectorStore(), dedupThreshold: 0.99 });
    await svc.init();
    const bullet = "- 显式写入的这一行不是抽取结果。";
    const saved = await svc.save({ namespace: "claude:u", type: "semantic", text: bullet });
    expect(saved.text).toBe(bullet);
  });

  // ENABLE_EXTRACTOR is a setting the console can write, so turning it on and off in
  // the file has to win over a key still sitting in the environment. The "true" phase
  // is the proof the flag is read from the file at all: before, the path was gated on
  // the process environment and no request went out.
  it("honors ENABLE_EXTRACTOR=false from settings.json even with an env key present", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "extractor-home-"));
    const savedEnv = { ...process.env };
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    process.env.AI_MEMORY_HOME = home;
    process.env.OPENAI_API_KEY = "sk-in-the-environment";
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"memories\":[]}" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const llmCalls = () => urls.filter((u) => u.includes("api.openai.com")).length;
    try {
      await writeSettings({ ENABLE_EXTRACTOR: "true" }, home);
      expect(await ex.extract("I live in Berlin.")).toEqual([]);
      expect(llmCalls()).toBe(1);
      await writeSettings({ ENABLE_EXTRACTOR: "false" }, home);
      const kept = await ex.extract("I live in Berlin.");
      expect(kept.map((m) => m.text)).toContain("I live in Berlin");
      expect(llmCalls()).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
      process.env = { ...savedEnv };
      await rm(home, { recursive: true, force: true });
    }
  });
});
