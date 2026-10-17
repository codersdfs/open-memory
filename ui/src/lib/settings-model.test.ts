import { describe, expect, it } from "vitest";
import type { SettingsEntry } from "./api";
import { effectBadge, maskedDisplay, needsAdoptBanner, sourceBadge } from "./settings-model";

/** One row as `GET /settings` serializes it, overridden per test. */
const entry = (patch: Partial<SettingsEntry>): SettingsEntry => ({
  name: "JEV_API_KEY",
  kind: "secret",
  source: "file",
  masked: "…abcd",
  effect: "immediate",
  writable: true,
  ...patch,
});

describe("effectBadge", () => {
  it("says something different for an immediate value and one that waits", () => {
    expect(effectBadge("immediate")).not.toBe(effectBadge("restart"));
    expect(effectBadge("immediate")).toBe("live on save");
    expect(effectBadge("restart")).toBe("restart required");
  });
});

describe("sourceBadge", () => {
  it("names where each of the four sources puts the value", () => {
    expect(sourceBadge("env")).toBe("env");
    expect(sourceBadge("file")).toBe("settings");
    expect(sourceBadge("default")).toBe("default");
    expect(sourceBadge("absent")).toBe("unset");
  });

  it("gives every source its own word", () => {
    const words = (["env", "file", "default", "absent"] as const).map(sourceBadge);
    expect(new Set(words).size).toBe(words.length);
  });
});

describe("maskedDisplay", () => {
  it("shows the mask the API sent and nothing else", () => {
    expect(maskedDisplay(entry({ masked: "…9f3c" }))).toBe("…9f3c");
  });

  it("falls back to a placeholder when there is no mask", () => {
    expect(maskedDisplay(entry({ masked: null, source: "absent" }))).toBe("not set");
  });
});

describe("needsAdoptBanner", () => {
  it("is true for a secret that the environment supplies", () => {
    expect(needsAdoptBanner([entry({ kind: "secret", source: "env" })])).toBe(true);
  });

  it("is true for a plain knob the environment shadows, because adopt moves it too", () => {
    expect(needsAdoptBanner([entry({ name: "MEMORY_JEV", kind: "plain", masked: null, source: "env" })])).toBe(true);
  });

  it("is false for an env-sourced key the console may not write, which adopt cannot move", () => {
    // `TYPESAFE_API_KEY` is read by the judge but is on neither whitelist, so the banner would
    // offer a button that changes nothing.
    expect(needsAdoptBanner([entry({ name: "TYPESAFE_API_KEY", source: "env", writable: false })])).toBe(false);
  });

  it("is false for a secret already living in the settings file", () => {
    expect(needsAdoptBanner([entry({ kind: "secret", source: "file" })])).toBe(false);
  });

  it("finds one env-sourced secret among rows that need no banner", () => {
    const rows = [
      entry({ name: "JEV_MODEL", kind: "plain", masked: null, source: "default" }),
      entry({ name: "OPENAI_API_KEY", source: "file" }),
      entry({ name: "JEV_API_KEY", source: "env" }),
    ];
    expect(needsAdoptBanner(rows)).toBe(true);
  });

  it("is false when there are no rows at all", () => {
    expect(needsAdoptBanner([])).toBe(false);
  });
});
