/**
 * `~/.ai-memory/settings.json` — the console's writable, non-secret settings.
 *
 * A file instead of a route that rewrites `.env` because the user's `.env` may hold
 * API keys, and a mistake there is unrecoverable; this file holds only the variable
 * names below, so a bad write costs a delete. The vocabulary is the environment's —
 * a setting key *is* an env var name, so there is no mapping layer to drift and the
 * factory's `env` seam is the whole integration. Precedence: real environment >
 * this file > the factory's built-in default.
 */

import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveHome } from "./dbPath.js";

/** Every key `settings.json` may hold. A settings key is an env var name — nothing else. */
export const SETTING_KEYS = [
  "EMBEDDING_PROVIDER",
  "EMBEDDING_DIM",
  "NIM_DIM",
  "OPENAI_EMBED_MODEL",
  "NIM_EMBED_MODEL",
  "OPENAI_BASE_URL",
  "NIM_BASE_URL",
  "NIM_INPUT_TYPE",
  "NIM_TRUNCATE",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export type Settings = Partial<Record<SettingKey, string>>;

/** Anything shaped like a credential belongs in the environment, never in this file. */
const SECRET_KEY = /API_KEY|_KEY|TOKEN|SECRET/i;

function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

/** Absolute path to the settings file. `resolveHome` is the only home resolution. */
export function settingsPath(home?: string): string {
  return path.join(resolveHome(home), "settings.json");
}

/**
 * Tolerant read: a missing file, an unreadable file, invalid JSON, a JSON array or a
 * non-string value all degrade to fewer keys — never to a throw. A malformed settings
 * file must not be able to stop the server from starting.
 */
export function readSettings(home?: string): Settings {
  const parsed = readJson(settingsPath(home));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Settings = {};
  for (const key of SETTING_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    // missing, unreadable or invalid JSON — all the same answer here: no settings yet
    return null;
  }
}

/**
 * Merge `patch` into the file and return the merged settings.
 *
 * Creates the home dir if missing, then writes `settings.json.tmp` and renames over
 * the target, so an interrupted or failed write leaves the previous file intact.
 * Unknown keys and anything key-shaped are rejected — silently storing either would
 * be the kind of mistake this file exists to make recoverable.
 */
export async function writeSettings(patch: Settings, home?: string): Promise<Settings> {
  for (const key of Object.keys(patch)) {
    if (SECRET_KEY.test(key)) {
      throw new Error(`${key} looks like a secret — API keys and tokens belong in the environment, not in settings.json`);
    }
    if (!isSettingKey(key)) {
      throw new Error(`unknown setting "${key}" — settings.json holds only: ${SETTING_KEYS.join(", ")}`);
    }
  }

  const merged: Settings = { ...readSettings(home) };
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === "string" && isSettingKey(key)) merged[key] = value;
  }

  await mkdir(resolveHome(home), { recursive: true });
  const target = settingsPath(home);
  const tmp = `${target}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return merged;
}

/** An empty string is an absent value, on either side of the merge. */
function nonEmpty(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  return out;
}

/**
 * The environment the embedder should be built from: real environment > settings file
 * > the factory's default. Both sides drop empty strings first, so `KEY=` in `.env`
 * or `""` in the file reads as unset instead of shadowing the layer below it with a
 * broken value.
 */
export function embedEnv(base: NodeJS.ProcessEnv = process.env, home?: string): NodeJS.ProcessEnv {
  return mergeEnv(base, readSettings(home));
}

/** Only the whitelisted keys survive, so a caller cannot smuggle anything into env. */
function pickSettingKeys(settings: Settings): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of SETTING_KEYS) {
    const value = settings[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Merge settings into an environment without touching the disk.
 *
 * POST /embedding has to preview a patch it has not written yet: validating it the
 * same way the factory will build it at the next start is the only way a body that
 * passes here cannot fail there.
 */
export function mergeEnv(base: NodeJS.ProcessEnv, settings: Settings): NodeJS.ProcessEnv {
  return { ...nonEmpty(pickSettingKeys(settings)), ...nonEmpty(base) };
}

/** Where the effective `EMBEDDING_PROVIDER` comes from. */
export function embeddingSource(base: NodeJS.ProcessEnv = process.env, home?: string): "env" | "settings" | "default" {
  const nonBlank = (v: string | undefined) => v !== undefined && v.trim() !== "";
  if (nonBlank(base.EMBEDDING_PROVIDER)) return "env";
  if (nonBlank(readSettings(home).EMBEDDING_PROVIDER)) return "settings";
  return "default";
}
