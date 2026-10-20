import { describe, it, expect } from "vitest";
import { normalizeTags, deriveFacets, buildTags, inheritFacets, MAX_TAGS } from "../src/core/write/facets.js";

describe("normalizeTags", () => {
  it("slugifies facet values and leaves unknown tags alone", () => {
    expect(normalizeTags(["Entity:Foo Bar", "Deploy Notes"]))
      .toEqual(["entity:foo-bar", "Deploy Notes"]);
  });
  it("drops empties, dedupes, and caps", () => {
    const many = Array.from({ length: 20 }, (_, i) => `topic:t${i}`);
    expect(normalizeTags(["  ", ...many, "TOPIC:t0"])).toHaveLength(MAX_TAGS);
  });
  it("returns [] for undefined", () => {
    expect(normalizeTags(undefined)).toEqual([]);
  });
});

describe("deriveFacets", () => {
  it("turns backticked identifiers into entity facets", () => {
    expect(deriveFacets("the `memoryService` writes rows")).toContain("entity:memoryservice");
  });
  it("turns paths into path facets", () => {
    const winPath = String.raw`C:\memory\src\core\types.ts`;
    expect(deriveFacets(`edited ${winPath}`)).toContain(`path:${winPath.toLowerCase()}`);
    expect(deriveFacets("edited C:/memory/src/core/types.ts")).toContain("path:c:/memory/src/core/types.ts");
  });
  it("does not read dates or slash words as paths", () => {
    expect(deriveFacets("shipped on 2026/10/18 with and/or CI/CD")).toEqual([]);
  });

  it("derives an entity from a Chinese title", () => {
    expect(deriveFacets("读了《深入理解计算机系统》第三章")).toContain("entity:深入理解计算机系统");
  });

  it("derives entities from CamelCase and acronyms, and ignores a shouted line", () => {
    expect(deriveFacets("RustDesk connects to the box")).toContain("entity:rustdesk");
    expect(deriveFacets("the MCP server starts on boot")).toContain("entity:mcp");
    // All-caps English is words before it is an acronym; a shouting line would otherwise
    // mint one entity per word.
    expect(deriveFacets("I WANT TO SHIP THIS")).toEqual([]);
  });

  it("derives a topic from a known domain noun", () => {
    expect(deriveFacets("sqlite stores the vectors as JSON")).toContain("topic:sqlite");
  });

  it("derives a topic from a word the sentence repeats", () => {
    expect(deriveFacets("rustdesk is installed, and rustdesk starts on boot")).toEqual(["topic:rustdesk"]);
  });

  it("does not reuse an entity value as a topic", () => {
    // `memoryService` is the name of the thing; it is not also its subject.
    expect(deriveFacets("the `memoryService` writes rows").filter((t) => t.startsWith("topic:"))).toEqual([]);
  });

  it("keeps the inherited facet even when the new row fills the tag list", () => {
    const many = Array.from({ length: MAX_TAGS }, (_, i) => `unofficial${i}`);
    expect(inheritFacets(["entity:pnpm"], many)).toContain("entity:pnpm");
  });

  it("derives nothing from a plain sentence", () => {
    expect(deriveFacets("edited the file")).toEqual([]);
  });

  it("is deterministic", () => {
    const text = "frank prefers pnpm; RustDesk 连着《设计文档》";
    expect(deriveFacets(text)).toEqual(deriveFacets(text));
    expect(deriveFacets(text)).toEqual(["entity:设计文档", "entity:rustdesk", "topic:pnpm"]);
  });
});

describe("buildTags / inheritFacets", () => {
  it("merges caller tags with derived facets", () => {
    expect(buildTags("`memoryService`", ["topic:deploy"]))
      .toEqual(["topic:deploy", "entity:memoryservice"]);
  });
  it("inherits entity and topic but not path", () => {
    const old = ["entity:pnpm", "topic:tooling", "path:c:/x/y.ts"];
    expect(inheritFacets(old, ["entity:pnpm"])).toEqual(["entity:pnpm", "topic:tooling"]);
  });
});
