/**
 * The words the settings view puts on a row, kept out of the JSX so they can be tested and
 * so two cards cannot describe the same field differently.
 *
 * Every string here is derived from what `GET /settings` reported (src/core/settings.ts:355-369);
 * nothing re-derives a value's source or its effect locally, because a second copy of that rule
 * is how the badge and the server start disagreeing.
 */
import type { SettingsEntry } from "./api";

/**
 * What saving the field costs. `restart required` is not a warning to soften: the process
 * running now keeps the value it read at boot (ADR-0009), so a user who saved and saw no
 * change has been told the truth by the badge rather than by a support thread.
 */
export function effectBadge(effect: SettingsEntry["effect"]): string {
  return effect === "restart" ? "restart required" : "live on save";
}

/**
 * Where the value in force comes from. The environment beats `settings.json`, so `env` is
 * also the reason a save on that row is refused — the badge is the first half of that
 * sentence and the 400 the second.
 */
export function sourceBadge(source: SettingsEntry["source"]): string {
  switch (source) {
    case "env":
      return "env";
    case "file":
      return "settings";
    case "default":
      return "default";
    case "absent":
      return "unset";
  }
}

/**
 * The masked tail for a secret row, or the placeholder that says there is nothing behind it.
 * This is the only place a secret-valued field is rendered, and it renders the mask the API
 * sent — never a value the console would have to hold in order to print it.
 */
export function maskedDisplay(entry: SettingsEntry): string {
  return entry.masked ?? "not set";
}

/**
 * Whether the adopt banner belongs on the page: at least one writable entry is being supplied
 * by the environment, so a save into `settings.json` would land where nothing reads it.
 *
 * The gate is `writable`, not `kind === "secret"`: `adoptEnvKeys` moves any whitelisted name,
 * so a plain knob shadowed in `.env` (`MEMORY_JEV=true`) has the same problem and the same way
 * out, while an env-only key (`TYPESAFE_API_KEY`) cannot be adopted and gets no banner.
 */
export function needsAdoptBanner(entries: SettingsEntry[]): boolean {
  return entries.some((entry) => entry.writable && entry.source === "env");
}
