import { describe, expect, it } from "vitest";
import type { Memory } from "./api";
import { chainOf } from "./supersede";

const mem = (id: string, supersedesId: string | null = null): Memory => ({
  id,
  namespace: "default:default",
  type: "semantic",
  text: id,
  embedding: [],
  importance: 0.5,
  strength: 0.5,
  lastUsedAt: null,
  supersedesId,
  isDeleted: 0,
  visibility: "private",
  status: "active",
  pin: 0,
  createdAt: 0,
  updatedAt: 0,
});

const ids = (rows: Memory[]) => rows.map((r) => r.id);

describe("chainOf", () => {
  it("walks backward to the ancestor chain", () => {
    const rows = [mem("a"), mem("b", "a"), mem("c", "b")];
    expect(ids(chainOf("c", rows).ancestors)).toEqual(["b", "a"]);
    expect(chainOf("c", rows).successors).toEqual([]);
  });

  it("walks forward through every row that supersedes the id", () => {
    const rows = [mem("a"), mem("b", "a"), mem("c", "b"), mem("other")];
    expect(ids(chainOf("a", rows).successors)).toEqual(["b", "c"]);
    expect(chainOf("a", rows).ancestors).toEqual([]);
  });

  it("returns both directions from the middle of a chain", () => {
    const rows = [mem("a"), mem("b", "a"), mem("c", "b"), mem("d", "c")];
    const chain = chainOf("b", rows);
    expect(ids(chain.ancestors)).toEqual(["a"]);
    expect(ids(chain.successors)).toEqual(["c", "d"]);
  });

  it("terminates on a cycle and never returns the origin", () => {
    const rows = [mem("a", "b"), mem("b", "a"), mem("self", "self")];
    const chain = chainOf("a", rows);
    expect(ids(chain.ancestors)).toEqual(["b"]);
    expect(chain.successors).toEqual([]);
    expect(ids(chainOf("self", rows).ancestors)).toEqual([]);
    expect(ids(chainOf("self", rows).successors)).toEqual([]);
  });

  it("stops at an ancestor that is not in the rows", () => {
    expect(chainOf("b", [mem("b", "gone")]).ancestors).toEqual([]);
  });
});
