import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { curate, curateExtracted, CurationRejected, DEMOTE_IMPORTANCE, DEMOTE_KIND } from "../src/core/write/curation.js";
import { MemoryService } from "../src/core/memoryService.js";
import { Extractor } from "../src/core/extraction/extractor.js";
import { InMemoryVectorStore } from "../src/core/store/memory.js";
import { HashEmbeddingProvider } from "../src/core/embedding/hash.js";
import { buildServer } from "../src/api/server.js";
import { callTool } from "../src/mcp/tools.js";

/**
 * The verdict table is the audited store speaking: every junk fixture below is a row
 * the live store actually held (source extractor, most with judged:jev on them), and
 * every clean fixture is a row that earned its place. A rule that kills a clean row
 * here is a rule that deletes real knowledge — that is what the clean half is for.
 */
const JUNK_PROBE: Record<string, string> = {
  secret: "api_key = sk-proj-aaaaaaaaaaaaaaaaaaaa",
  "table-row": "| a | b |",
  "colon-header": "Three reasons this fails:",
  phatic: "ok",
  conversational: "I never said the deploy needs docker",
  "code-line": "export const PITCH = 48;",
  "prompt-fragment": "Task: TOOLBOX: your real tools are read, grep, find, ls, bash, write, plus graph",
  progress: "I just fixed the login bug",
  "self-narration": "I can only work with local files and the codebase here",
};

describe("curation verdicts", () => {
  it("rejects the junk classes the 515-row audit measured", () => {
    // conversational — the row that named this feature: an LLM judge passed it.
    expect(curate("我没说过我在 pi-desktop。你看到的 `C:\\pi-desktop\\node_modules\\...` 是 pi 自己装在哪儿（文档路径），不是我的工作目录。", { origin: "extracted" }).junk).toBe("conversational");
    expect(curate("I never said the deploy needs docker", { origin: "explicit" }).junk).toBe("conversational");
    expect(curate("That's not what I said about the release date", { origin: "explicit" }).junk).toBe("conversational");
    // table-row — escaped the shape gate because the LLM extract path had no gate.
    expect(curate("| 网卡 | MediaTek Wi-Fi 6 MT7902LEN | ✅ 卡不差 |", { origin: "extracted" }).junk).toBe("table-row");
    // colon-header — a heading whose content went to the next line.
    expect(curate("**“不流畅”不是在渲染本身，是渲染时机**：", { origin: "extracted" }).junk).toBe("colon-header");
    expect(curate("Three reasons this fails:", { origin: "explicit" }).junk).toBe("colon-header");
    // phatic — Mem0's few-shot "Hi." → {"facts": []} as a lexicon.
    for (const filler of ["ok", "好的", "thanks!", "收到。", "👍", "哈哈哈哈"]) {
      expect(curate(filler, { origin: "explicit" }).junk).toBe("phatic");
    }
    // code-line — a diff line with a line number sat in the store as a "note".
    expect(curate("18: export const PITCH = 48;        // row height, px — every row, no adaptive height", { origin: "extracted" }).junk).toBe("code-line");
    expect(curate("export const PITCH = 48;", { origin: "explicit" }).junk).toBe("code-line");
    // prompt-fragment — the agent's own manifest and tooling instructions.
    expect(curate("Task: TOOLBOX: your real tools are read, grep, find, ls, bash, write, plus graph", { origin: "extracted" }).junk).toBe("prompt-fragment");
    expect(curate("researcher.md      tools: read, write, web_search, fetch_content, get_search_content, source_check", { origin: "extracted" }).junk).toBe("prompt-fragment");
    expect(curate("TOOLS_IMPLIED: fabric_exec → pi.bash({cmd})", { origin: "extracted" }).junk).toBe("prompt-fragment");
    expect(curate("1) The exact skill names you can load (comma separated)", { origin: "extracted" }).junk).toBe("prompt-fragment");
    // …but a numbered procedure speaking in its own voice is a procedure, not a slice.
    expect(curate("1) 先装依赖，2) 再跑测试，3) 全绿后提交。", { origin: "explicit" }).action).toBe("store");
  });

  it("rejects secrets on sight — the one class the whole field leaves to prompt advice", () => {
    expect(curate("the key is sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa", { origin: "explicit" }).junk).toBe("secret");
    expect(curate("NIM_API_KEY=nvapi-lzK8gXJl5E2oTmB5JJHV8ZHbNKRhpzpxVZdU-fedeDM", { origin: "explicit" }).junk).toBe("secret");
    expect(curate("远程访问密码: hunter2Pass", { origin: "explicit" }).junk).toBe("secret");
    expect(curate("token: ghp_9xHh2ZqW8vKk1LmNoP3qRsT4uVwX5yZ6", { origin: "explicit" }).junk).toBe("secret");
  });

  it("rejects weak classes from an extractor's slice and demotes them from a caller", () => {
    for (const junk of ["我刚做的: 修正了 C:\\Users\\frank\\remote-access.md", "I just fixed the login bug", "I can only work with local files and the codebase here"]) {
      expect(curate(junk, { origin: "extracted" }).action).toBe("reject");
      expect(curate(junk, { origin: "explicit" }).action).toBe("demote");
    }
    expect(curate("Plan 已更新（点击靶面/圆角记录 + 探针可靠性发现）", { origin: "extracted" }).junk).toBe("progress");
  });

  it("keeps the audited rows that earned their place", () => {
    for (const good of [
      "Do not start Task N+1 before Task N's tests pass",
      "The Windows sandbox bites when rmSync runs right after close",
      "读不了 RustDesk 界面 —— 它是 Flutter 应用",
      "想临时限定帧数就 $env:RSGUI_FRAMES=\"600\"（600 帧 ≈ 10 秒自动退）。",
      "格式: FINDING / EVIDENCE / CONFIDENCE，不要散文",
      "How to deploy the memory UI: npm run memory:ui then open localhost:3000",
      "F3 tablist 键盘契约 → roving tabindex + Arrow/Home/End + `aria-controls`/`tabpanel`",
      "The reader has ADHD",
      "qwen 预热每月只省 $0.6，不值得再增加配置项，也不会出问题。等哪天 qwen 变成主力（比如一天用 200 次），再开启。",
      "Repo: C:/pi-desktop (read files directly with read/grep; do not run the dev server)",
    ]) {
      const v = curate(good, { origin: "explicit" });
      expect(v.action, `${good} → ${v.junk}`).toBe("store");
      expect(curateExtracted(good).action, good).toBe("store");
    }
  });

  it("every verdict names its one next move, never a bare no", () => {
    for (const junk of ["secret", "table-row", "colon-header", "phatic", "conversational", "code-line", "prompt-fragment", "progress", "self-narration"] as const) {
      const v = curate(JUNK_PROBE[junk], { origin: "explicit" });
      expect(v.junk, JUNK_PROBE[junk]).toBe(junk);
      expect(v.advice.length, junk).toBeGreaterThan(10);
      expect(v.advice, junk).not.toMatch(/^(no|rejected|invalid)\b/i);
    }
  });
});

describe("curation in the service", () => {
  const makeSvc = () => {
    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider(), dedupThreshold: 0.99 });
    return svc.init().then(() => svc);
  };

  it("an explicit weak write lands demoted, tagged, and confessing", async () => {
    const svc = await makeSvc();
    const { memory, curation } = await svc.saveDetailed({ namespace: "claude:u", type: "semantic", text: "我刚修好了登录的 bug" });
    expect(memory.kind).toBe(DEMOTE_KIND);
    expect(memory.importance).toBeCloseTo(DEMOTE_IMPORTANCE);
    expect(memory.tags).toContain("curation:progress");
    expect(curation?.tag).toBe("curation:progress");
    svc.close();
  });

  it("a caller who named a kind or an importance outranks the demotion", async () => {
    const svc = await makeSvc();
    const { memory, curation } = await svc.saveDetailed({ namespace: "claude:u", type: "semantic", text: "我刚修好了登录的 bug", kind: "task", importance: 0.9 });
    expect(memory.kind).toBe("task");
    expect(memory.importance).toBe(0.9);
    expect(memory.tags ?? []).not.toContain("curation:progress");
    expect(curation).toBeUndefined();
    svc.close();
  });

  it("hard junk is refused on every path and stores nothing", async () => {
    const svc = await makeSvc();
    for (const junk of ["我没说过我在 pi-desktop。", "| a | b |", "ok", "api_key = sk-proj-aaaaaaaaaaaaaaaaaaaa"]) {
      await expect(svc.save({ namespace: "claude:u", type: "semantic", text: junk })).rejects.toBeInstanceOf(CurationRejected);
      await expect(svc.save({ namespace: "claude:u", type: "semantic", text: junk, source: "extractor" })).rejects.toBeInstanceOf(CurationRejected);
    }
    expect((await svc.list({ namespace: "claude:u" })).total).toBe(0);
    svc.close();
  });

  it("MEMORY_CURATE=off restores the un-gated store", async () => {
    const saved = process.env.MEMORY_CURATE;
    process.env.MEMORY_CURATE = "off";
    try {
      const svc = await makeSvc();
      const bullet = "- 显式写入的这一行不是抽取结果。";
      const mem = await svc.save({ namespace: "claude:u", type: "semantic", text: bullet });
      expect(mem.text).toBe(bullet);
      svc.close();
    } finally {
      if (saved === undefined) delete process.env.MEMORY_CURATE;
      else process.env.MEMORY_CURATE = saved;
    }
  });

  it("extractAndSave reports what it refused alongside what it kept", async () => {
    const svc = await makeSvc();
    // The real correction row, whole: the repair frame is refused and counted, while
    // the fact it carried — what that path IS — survives as its own sentence.
    const { memories, rejected } = await svc.extractAndSave(
      "我没说过我在 pi-desktop。你看到的 `C:\\pi-desktop\\node_modules\\...` 是 pi 自己装在哪儿（文档路径），不是我的工作目录。",
      "claude:u"
    );
    expect(rejected).toBe(1);
    expect(memories).toHaveLength(1);
    expect(memories[0].text).toContain("文档路径");
    svc.close();
  });

  it("a CJK turn splits at its terminators, so a dialogue opener stops welding onto the fact", async () => {
    const svc = await makeSvc();
    const ex = new Extractor();
    // "在。" is a conversational token under 12 chars — the split is what frees the
    // fact behind it; before, one row held both.
    const kept = await ex.extract("在。它就是那个 MCP 服务里的第三个项目，本机 WSL 里存着，不是远端。");
    expect(kept).toHaveLength(1);
    expect(kept[0].text.startsWith("它就是那个")).toBe(true);
    svc.close();
  });
});

describe("curation at the surfaces", () => {
  let base = "";
  let close = () => {};
  beforeAll(async () => {
    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
    const { app } = await buildServer({ service: svc });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => app.close(() => r()));
  });
  afterAll(async () => {
    await close();
  });
  const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("POST /memories answers 422 with the verdict and the advice", async () => {
    const res = await post("/memories", { namespace: "test:cur", type: "semantic", text: "| a | b |" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; curation: { junk: string; advice: string } };
    expect(body.curation.junk).toBe("table-row");
    expect(body.curation.advice).toContain("store the fact");
    const ok = await post("/memories", { namespace: "test:cur", type: "semantic", text: "a clean fact lands as always" });
    expect(ok.status).toBe(201);
  });

  it("POST /extract reports the rejected count", async () => {
    const res = await post("/extract", { namespace: "test:cur", text: "我没说过我在 pi-desktop。我们决定用 pnpm 管理依赖。" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { extracted: number; rejected: number };
    expect(body.rejected).toBe(1);
    expect(body.extracted).toBe(1);
  });

  it("memory_remember answers a rejection as a decision the model can act on", async () => {
    const svc = new MemoryService({ store: new InMemoryVectorStore(), embedder: new HashEmbeddingProvider() });
    await svc.init();
    const res: any = await callTool(
      { service: svc, defaultAgent: "claude" },
      "memory_remember",
      { text: "我没说过我在 pi-desktop。" }
    );
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("not stored (conversational)");
    expect(res.structured.stored).toBe(false);
    expect(res.structured.curation.junk).toBe("conversational");
    svc.close();
  });
});
