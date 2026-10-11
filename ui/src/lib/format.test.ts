import { describe, expect, it } from "vitest";
import { absTime, bytes, pct, relTime, score3, tokens, truncate } from "./format";

const T = 1_700_000_000_000; // fixed epoch ms; nothing here reads the clock

describe("relTime", () => {
  it("handles null and 0", () => {
    expect(relTime(null)).toBe("never");
    expect(relTime(0)).toBe("never");
  });

  it("walks every unit", () => {
    expect(relTime(T, T)).toBe("now");
    expect(relTime(T - 12_000, T)).toBe("12s");
    expect(relTime(T - 5 * 60_000, T)).toBe("5m");
    expect(relTime(T - 3 * 3600_000, T)).toBe("3h");
    expect(relTime(T - 4 * 86_400_000, T)).toBe("4d");
    expect(relTime(T - 60 * 86_400_000, T)).toBe("2mo");
    expect(relTime(T - 400 * 86_400_000, T)).toBe("1y");
  });

  it("floors at the second and minute boundaries", () => {
    expect(relTime(T - 59_000, T)).toBe("59s");
    expect(relTime(T - 60_000, T)).toBe("1m");
    expect(relTime(T - 59 * 60_000, T)).toBe("59m");
    expect(relTime(T - 86_400_000, T)).toBe("1d");
  });

  it("does not go negative for a future timestamp", () => {
    expect(relTime(T + 60_000, T)).toBe("now");
  });
});

describe("absTime", () => {
  it("is fixed-width and handles null", () => {
    expect(absTime(null)).toBe("never");
    expect(absTime(0)).toBe("never");
    expect(absTime(T)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe("score3", () => {
  it("always keeps three decimals", () => {
    expect(score3(0.737)).toBe("0.737");
    expect(score3(0.5)).toBe("0.500");
    expect(score3(1)).toBe("1.000");
  });
});

describe("tokens", () => {
  it("switches to k at 1000", () => {
    expect(tokens(800)).toBe("800 tok");
    expect(tokens(999)).toBe("999 tok");
    expect(tokens(1200)).toBe("1.2k tok");
  });
});

describe("bytes", () => {
  it("handles an unknown size", () => {
    expect(bytes(null)).toBe("—");
    expect(bytes(0)).toBe("0 B");
  });

  it("crosses each unit boundary", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(999)).toBe("999 B");
    expect(bytes(1000)).toBe("1.0 kB");
    expect(bytes(1400)).toBe("1.4 kB");
    expect(bytes(1_000_000)).toBe("1.0 MB");
    expect(bytes(3_100_000)).toBe("3.1 MB");
  });
});

describe("pct", () => {
  it("rounds to whole percent", () => {
    expect(pct(0.72)).toBe("72%");
    expect(pct(0)).toBe("0%");
  });
});

describe("truncate", () => {
  it("collapses to one line and caps at n characters", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("a\nb\tc", 10)).toBe("a b c");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abcdef", 4).length).toBe(4);
    expect(truncate("abcdef", 0)).toBe("");
  });
});
