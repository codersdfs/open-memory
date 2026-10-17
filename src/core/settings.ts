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

/**
 * Credential names the environment is read for but the console may not write.
 *
 * `TYPESAFE_API_KEY` is the judge's third choice, after `JEV_API_KEY` and the path in
 * `JEV_API_KEY_FILE` — and the path form exists for a checkout whose `.env` is shareable.
 * Neither is a console field, so `writeSettings` refuses both; the inventory still reports
 * them, because an empty JEV field would otherwise read as "no key anywhere" while a live
 * one sits in the environment. The kind is per name: a key is a secret, a path is not.
 */
export const ENV_ONLY_KEYS = {
  TYPESAFE_API_KEY: "secret",
  JEV_API_KEY_FILE: "plain",
} as const satisfies Record<string, "secret" | "plain">;

export type SettingKey = (typeof SETTING_KEYS)[number];
export type SecretKey = (typeof SECRET_KEYS)[number];
/** The names only the environment provides: reported by the inventory, refused by `writeSettings`. */
export type EnvOnlyKey = keyof typeof ENV_ONLY_KEYS;

/** The two whitelists as one vocabulary: what may be written, read back and merged. */
export type WritableKey = SettingKey | SecretKey;

export type Settings = Partial<Record<WritableKey, string>>;

/** Both lists in one place, so nothing can add a key to one and forget the other. */
export const WRITABLE_KEYS: readonly WritableKey[] = [...SETTING_KEYS, ...SECRET_KEYS];

export function isWritableKey(key: string): key is WritableKey {
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
  /**
   * The names `commentOutEnvKeys` actually commented, in `.env` order — the `.env` rewrite's
   * report, not the list settings.json recorded, so it can be shorter than that list when the
   * file no longer matched.
   */
  adopted: string[];
  /**
   * Enabled whitelisted names left in `.env` because their line could not be read exactly —
   * see `adoptEnvKeys`. Empty when every value present was adopted.
   */
  notAdopted: string[];
  /**
   * Where the `.bak` copy lives — written once, on the first adopt that changed the file, and
   * kept — so on a later adopt this is still that first copy; `null` when `.env` was not
   * touched at all.
   */
  backupPath: string | null;
  /** Always `true`: the running process still holds what it read at boot. */
  restartRequired: boolean;
}

/**
 * Whether this line's raw text is what `parseValue` turned into `value` — the reconstruction
 * test adopt needs, because `parseValue` strips the quotes and drops an inline comment
 * rather than telling you what it removed.
 *
 * A quoted line must be that quote, the value, and the same closing quote with nothing
 * before or after. An unquoted one must be the value alone, or the value and a trailing `#`
 * comment. `JEV_API_KEY="ab\"cd"` (reads `ab\`), a quote opener that is never closed
 * (`'sk-1` reads with the quote glued on) and text after the closing quote (`"abc"def`
 * reads `abc`) all fail it.
 */
function readsBackExactly(raw: string | undefined, value: string): boolean {
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") return trimmed === `${quote}${value}${quote}`;
  if (!trimmed.startsWith(value)) return false;
  return trimmed === value || /^\s+#/.test(trimmed.slice(value.length));
}

/**
 * The value text `parseValue` was given for a line it accepted. A name holds no `=`, and
 * neither the indent, the `#` nor the `export ` prefix does, so the first `=` is always the
 * assignment's. `undefined` for a line the file no longer has.
 */
function rawValueText(line: string | undefined): string | undefined {
  if (line === undefined) return undefined;
  const eq = line.indexOf("=");
  return eq === -1 ? undefined : line.slice(eq + 1);
}

/**
 * Whether the loader that actually builds this process's environment reads the line
 * differently from `parseValue`: it expands `\n` inside double quotes, which `parseValue`
 * leaves as two characters. That is why a backslash stays refused even when the raw text
 * does reconstruct the value — `readsBackExactly` cannot see an escape it does not interpret.
 */
function hasEscape(raw: string | undefined): boolean {
  return raw !== undefined && raw.includes("\\");
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
 *
 * A line whose value `.env` cannot be read back exactly is not moved at all, because
 * commenting it out would make `settings.json` the only copy and the value there would be
 * wrong. Two checks decide that, and neither subsumes the other: the raw text must
 * reconstruct the value (`readsBackExactly`), and it must carry no backslash, because the
 * real loader expands `\n` inside double quotes while `parseValue` does not. A name with
 * such a line stays enabled in `.env` and is reported in `notAdopted`; making the file
 * explainable beats silently rewriting a key.
 *
 * The file is `MEMORY_ENV_FILE` when it is set, otherwise `cwd/.env` (see `envFilePath`),
 * and that is only the right file when the daemon loads it: `config.ts` calls
 * `process.loadEnvFile()` with no argument, which reads `.env` from the cwd and ignores
 * `MEMORY_ENV_FILE`. So if that variable is set it must point at the file the daemon
 * actually loads, or the values adopt moves into `settings.json` never shadowed anything.
 */
export async function adoptEnvKeys(opts: AdoptOptions = {}): Promise<AdoptResult> {
  const file = opts.envFile ?? envFilePath();
  const entries: { name: WritableKey; value: string; line: number }[] = [];

  for (const entry of readEnvFile(file)) {
    // A commented line is already doing nothing, and an empty value reads as unset on both
    // sides of the merge — neither has a value to move or a shadow to clear.
    if (!entry.enabled || !isWritableKey(entry.name) || entry.value === "") continue;
    entries.push({ name: entry.name, value: entry.value, line: entry.line });
  }
  if (entries.length === 0) return { adopted: [], notAdopted: [], backupPath: null, restartRequired: true };

  // `readEnvFile` splits the same latin-1 text on the same newline, so `line - 1` indexes it.
  const lines = readFileSync(file, "latin1").split("\n");
  // One unreadable line makes its name unadoptable: `commentOutEnvKeys` comments every
  // enabled line of a name it is given, which would take the unreadable value with it.
  const lossy = new Set<string>();
  for (const entry of entries) {
    const raw = rawValueText(lines[entry.line - 1]);
    if (hasEscape(raw) || !readsBackExactly(raw, entry.value)) lossy.add(entry.name);
  }

  const patch: Settings = {};
  const names: WritableKey[] = [];
  for (const entry of entries) {
    if (lossy.has(entry.name)) continue;
    patch[entry.name] = entry.value;
    if (!names.includes(entry.name)) names.push(entry.name);
  }
  const notAdopted = [...lossy];
  if (names.length === 0) return { adopted: [], notAdopted, backupPath: null, restartRequired: true };

  await writeSettings(patch, opts.home);
  const { commented, backupPath } = await commentOutEnvKeys(file, names);
  return { adopted: commented, notAdopted, backupPath, restartRequired: true };
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

/**
 * The masked form of a secret: `…` plus its last four characters.
 *
 * The tail is what lets a user recognise which key is saved. A value no longer than the
 * tail gets the ellipsis alone, because "…" plus four characters of a four-character value
 * is the value — and "never in clear" has no exception for short keys.
 */
export function maskSecret(value: string): string {
  return value.length > 4 ? `…${value.slice(-4)}` : "…";
}

/**
 * The keys the embedder reads when it is built, so saving one changes what the *next*
 * start serves and never the process running now (ADR-0009: one process, one vector
 * space). Everything else on either whitelist is read through `runtimeEnv` per call — the
 * keys by the code that uses them, the judge and extractor knobs at each use — which is
 * what makes those `immediate`.
 */
const RESTART_KEYS: ReadonlySet<string> = new Set<WritableKey>([
  "EMBEDDING_PROVIDER",
  "EMBEDDING_DIM",
  "NIM_DIM",
  "OPENAI_EMBED_MODEL",
  "NIM_EMBED_MODEL",
  "OPENAI_BASE_URL",
  "NIM_BASE_URL",
  "NIM_INPUT_TYPE",
  "NIM_TRUNCATE",
]);

/** What applying a saved value costs: a restart, or nothing at all. */
export function keyEffect(name: WritableKey): "immediate" | "restart" {
  return RESTART_KEYS.has(name) ? "restart" : "immediate";
}

/** One line of `GET /settings`: where a value comes from, and what changing it costs. */
export interface SettingsEntry {
  /**
   * A `WritableKey` for every console field. The `EnvOnlyKey`s that happen to be set are
   * reported here too, marked `writable: false`, so a value the environment provides under
   * another name is visible rather than implied absent.
   */
  name: WritableKey | EnvOnlyKey;
  kind: "secret" | "plain";
  source: "env" | "file" | "default" | "absent";
  /** `…` plus the last four characters, or null when there is no value or nothing secret. */
  masked: string | null;
  effect: "immediate" | "restart";
  /** False for `ENV_ONLY_KEYS`: reported by the inventory, refused by `writeSettings`. */
  writable: boolean;
}

function isSecret(name: string): boolean {
  return (SECRET_KEYS as readonly string[]).includes(name);
}

/**
 * Every key the console may show, with its source, its masked tail and its effect.
 *
 * A non-secret setting with no value anywhere is `default`, not `absent`: the embedder,
 * the judge and the extractor each supply a fallback, and duplicating those values here
 * would be a second copy of their rules that could drift. `absent` is what a credential
 * with no value anywhere is — there is nothing behind it.
 */
export function settingsInventory(base: NodeJS.ProcessEnv = process.env, home?: string): SettingsEntry[] {
  const env = nonEmpty(base);
  const file = nonEmpty(readSettings(home) as NodeJS.ProcessEnv);
  const entries: SettingsEntry[] = WRITABLE_KEYS.map((name) => {
    const secret = isSecret(name);
    const value = env[name] ?? file[name];
    return {
      name,
      kind: secret ? "secret" : "plain",
      source: env[name] !== undefined ? "env" : file[name] !== undefined ? "file" : secret ? "absent" : "default",
      masked: secret && value !== undefined ? maskSecret(value) : null,
      effect: keyEffect(name),
      writable: true,
    };
  });
  for (const name of Object.keys(ENV_ONLY_KEYS) as EnvOnlyKey[]) {
    const kind = ENV_ONLY_KEYS[name];
    const value = env[name];
    if (value === undefined) continue;
    entries.push({
      name,
      kind,
      source: "env",
      masked: kind === "secret" ? maskSecret(value) : null,
      // Read per call by `judge.ts`, like every other credential.
      effect: "immediate",
      writable: false,
    });
  }
  return entries;
}

/** Where the effective `EMBEDDING_PROVIDER` comes from. */
export function embeddingSource(base: NodeJS.ProcessEnv = process.env, home?: string): "env" | "settings" | "default" {
  const nonBlank = (v: string | undefined) => v !== undefined && v.trim() !== "";
  if (nonBlank(base.EMBEDDING_PROVIDER)) return "env";
  if (nonBlank(readSettings(home).EMBEDDING_PROVIDER)) return "settings";
  return "default";
}
