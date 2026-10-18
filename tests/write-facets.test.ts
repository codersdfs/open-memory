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
  it("derives nothing from a plain sentence", () => {
    expect(deriveFacets("use pnpm for every install")).toEqual([]);
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
