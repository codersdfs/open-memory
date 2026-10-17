/**
 * `~/.ai-memory/settings.json` — the console's writable settings.
 *
 * A file instead of a route that rewrites `.env`: the user's `.env` is where a mistake
 * costs a key, and this file is the one place the console may write. It holds two
 * whitelists — the knobs below, and the credentials a user would otherwise hand-type
 * into `.env`. The vocabulary is the environment's — a key *is* an env var name, so
 * there is no mapping layer to drift and the factory's `env` seam is the whole
 * integration. Precedence: real environment > this file > the factory's built-in
 * default.
 */

import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveHome } from "./dbPath.js";
import { commentOutEnvKeys, envFilePath, readEnvFile } from "./envFile.js";

/** Every non-secret key `settings.json` may hold. A setting key is an env var name — nothing else. */
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
  "JEV_ENDPOINT",
  "JEV_MODEL",
  "MEMORY_JEV",
  "MEMORY_JEV_MIN",
  "ENABLE_EXTRACTOR",
  "EXTRACTOR_MODEL",
] as const;

/**
 * Credentials the console may write — one per provider the factory, the judge or the
 * extractor can use. A closed list rather than a `/API_KEY|TOKEN/` shape: the pattern
 * only guessed at which names were credentials, and a console has to name exactly which.
 */
export const SECRET_KEYS = ["OPENAI_API_KEY", "NVIDIA_API_KEY", "NIM_API_KEY", "JEV_API_KEY"] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];
export type SecretKey = (typeof SECRET_KEYS)[number];

/** The two whitelists as one vocabulary: what may be written, read back and merged. */
export type WritableKey = SettingKey | SecretKey;

export type Settings = Partial<Record<WritableKey, string>>;

/** Both lists in one place, so nothing can add a key to one and forget the other. */
const WRITABLE_KEYS: readonly WritableKey[] = [...SETTING_KEYS, ...SECRET_KEYS];

function isWritableKey(key: string): key is WritableKey {
  return (WRITABLE_KEYS as readonly string[]).includes(key);
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
  for (const key of WRITABLE_KEYS) {
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
 * Anything outside the two whitelists is rejected — silently storing a name the console
 * does not own would be the kind of mistake this file exists to make recoverable.
 *
 * The file is created `0600` so only its owner can read it. That is a POSIX mode: on
 * Windows `mode` is largely inert and the protection is the user profile ACL, so this
 * is not a promise that the file is locked there. `mode` only applies to a file
 * `writeFile` creates, so the tmp is removed first: a stale `settings.json.tmp` from an
 * interrupted write would otherwise be reused at its old mode and renamed into place.
 */
export async function writeSettings(patch: Settings, home?: string): Promise<Settings> {
  for (const key of Object.keys(patch)) {
    if (!isWritableKey(key)) {
      throw new Error(`unknown setting "${key}" — settings.json holds only: ${WRITABLE_KEYS.join(", ")}`);
    }
  }

  const merged: Settings = { ...readSettings(home) };
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === "string" && isWritableKey(key)) merged[key] = value;
  }

  await mkdir(resolveHome(home), { recursive: true });
  const target = settingsPath(home);
  const tmp = `${target}.tmp`;
  try {
    await rm(tmp, { force: true });
    await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return merged;
}

export interface AdoptOptions {
  home?: string;
  /** The `.env` to read; defaults to the one this process would load. */
  envFile?: string;
}

export interface AdoptResult {
  /** The names that moved, in `.env` order. */
  adopted: string[];
  /** Where the pre-edit `.env` copy lives; `null` when `.env` was not touched. */
  backupPath: string | null;
  /** Always `true`: the running process still holds what it read at boot. */
  restartRequired: boolean;
}

/**
 * Move the whitelisted `.env` keys into `settings.json` and comment their lines out.
 *
 * The environment wins the merge, so a key sitting in `.env` shadows every console write:
 * this is how a user gets out of that without hand-editing. Only `SETTING_KEYS ∪
 * SECRET_KEYS` move — `TYPESAFE_API_KEY` and `JEV_API_KEY_FILE` are readable from the
 * environment but are not console fields, so they stay in `.env` untouched and never
 * reach `settings.json`.
 *
 * Settings are written first and `.env` commented second: a failure between the two
 * leaves the value in both places, which the next call finishes, where the reverse order
 * would lose it.
 */
export async function adoptEnvKeys(opts: AdoptOptions = {}): Promise<AdoptResult> {
  const file = opts.envFile ?? envFilePath();
  const patch: Settings = {};
  const names: WritableKey[] = [];

  for (const entry of readEnvFile(file)) {
    const name = entry.name;
    // A commented line is already doing nothing, and an empty value reads as unset on both
    // sides of the merge — neither has a value to move or a shadow to clear.
    if (!entry.enabled || !isWritableKey(name) || entry.value === "") continue;
    patch[name] = entry.value;
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) return { adopted: [], backupPath: null, restartRequired: true };

  await writeSettings(patch, opts.home);
  const { commented, backupPath } = await commentOutEnvKeys(file, names);
  return { adopted: commented, backupPath, restartRequired: true };
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
 * The environment every consumer should be built from: real environment > settings file
 * > the factory's default. Both sides drop empty strings first, so `KEY=` in `.env`
 * or `""` in the file reads as unset instead of shadowing the layer below it with a
 * broken value.
 */
export function runtimeEnv(base: NodeJS.ProcessEnv = process.env, home?: string): NodeJS.ProcessEnv {
  return mergeEnv(base, readSettings(home));
}

/** Only the whitelisted keys survive, so a caller cannot smuggle anything into env. */
function pickSettingKeys(settings: Settings): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of WRITABLE_KEYS) {
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
