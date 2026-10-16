# Console Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user set provider keys and judge/extractor knobs from the console (`#/settings`), stored in `~/.ai-memory/settings.json`, so `.env` never has to be hand-edited again.

**Architecture:** `settings.json` grows a second whitelist (`SECRET_KEYS`) beside the existing non-secret one, stays flat (a settings key *is* an env var name), and is merged into the environment by one generalized seam (`runtimeEnv`, today's `embedEnv`). A key sitting in `.env` shadows any console write, so an adopt action copies it into the file, comments the `.env` line out, and asks for a restart through a new `ai-memory daemon restart`.

**Tech Stack:** TypeScript, node:http, node:sqlite, vitest (root), Vite + React 19 (ui/), tsx for the dev daemon.

**Spec:** `docs/superpowers/specs/2026-10-16-console-credentials-design.md`

## Global Constraints

- Published package keeps `dependencies: {}` (ADR-0007). No new dependency in the root, in `src/`, in `ui/`, or in tests — node stdlib plus the existing devDeps (vitest, tsx, vite, react) only.
- Node floor: `process.loadEnvFile` (20.12), `node:sqlite` (22.5), `fs.writeFile` `{ mode }`.
- Precedence is unchanged and never re-ordered: **real environment > settings.json > built-in default**. An empty string reads as absent on both sides.
- Secrets are never logged, never returned in clear in any HTTP response or error body. Masked form is `…` plus the last 4 characters.
- `.env` is only ever **commented**, never deleted from or reordered. `.env.bak` is written before any `.env` mutation; every `.env` write goes tmp + rename.
- One env seam: `runtimeEnv`. No second merge helper, no alias kept for `embedEnv`.
- Windows and POSIX both supported; CRLF tolerated. `0600` is POSIX-only and is documented as such — never promised to lock a file on Windows.
- The console is a localhost surface: no auth is added, and `/admin/shutdown` must refuse non-loopback callers.
- Effect timing is data, not prose: keys, judge knobs and extractor knobs are `immediate`; embedding provider/dim/model/base-URL changes are `restart` (ADR-0009).

## Review Focus

Inputs and conditions the spec implies but no task's happy path covers — each has its test in the owning task:

1. A credential-shaped name **outside** the whitelists (`TYPESAFE_API_KEY`, `JEV_API_KEY_FILE`) present in `.env`: adopt must not move it, and `GET /settings` must still report it as environment-sourced rather than letting the user believe nothing is set. (Tasks 4, 5)
2. `.env` line shapes: `export NAME=v`, quoted values, inline `#` comment after a value, CRLF, no trailing newline, the same name twice. (Task 3)
3. A failed or interrupted `.env` write: `.env.bak` exists, `.env` still holds the original bytes, no `.tmp` left behind. (Tasks 3, 4)
4. Saving a key that the real environment already provides: the write is refused with a message naming where the live value is, matching the existing `/embedding` behaviour. (Task 5)
5. `/admin/shutdown` reached from a non-loopback address: refused, not executed. (Task 5)

---

### Task 1: Two whitelists, 0600, and `runtimeEnv`

**Files:**
- Modify: `src/core/settings.ts`
- Modify: `src/api/server.ts` (3 `embedEnv` uses: lines ~258, ~295, ~571, plus the `/embedding` scope guard in Step 3)
- Modify: `tests/console-api.test.ts` (the one assertion that pinned the old `/embedding` rejection message)
- Modify: `src/cli/index.ts:10,230`
- Modify: `src/core/memoryService.ts:10,31`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SECRET_KEYS` (readonly tuple), `type SecretKey`, `type WritableKey = SettingKey | SecretKey`, `type Settings = Partial<Record<WritableKey, string>>`, `readSettings(home?: string): Settings`, `writeSettings(patch: Settings, home?: string): Promise<Settings>`, `runtimeEnv(base?: NodeJS.ProcessEnv, home?: string): NodeJS.ProcessEnv` (replaces `embedEnv`), `SETTING_KEYS` extended with `JEV_ENDPOINT`, `JEV_MODEL`, `MEMORY_JEV`, `MEMORY_JEV_MIN`, `ENABLE_EXTRACTOR`, `EXTRACTOR_MODEL`. `embeddingSource` keeps its current signature.

- [ ] **Step 1: Write the failing tests** — append to `tests/settings.test.ts` (temp `home` per test already exists there):

```ts
it("accepts a whitelisted secret", async () => {
  await writeSettings({ OPENAI_API_KEY: "sk-test" }, home);
  expect(readSettings(home).OPENAI_API_KEY).toBe("sk-test");
});
it("still rejects a credential-shaped name outside the whitelists", async () => {
  await expect(writeSettings({ TYPESAFE_API_KEY: "x" } as never, home)).rejects.toThrow(/unknown setting/);
  await expect(writeSettings({ JEV_API_KEY_FILE: "x" } as never, home)).rejects.toThrow(/unknown setting/);
});
it("reads a secret back through runtimeEnv", async () => {
  await writeSettings({ JEV_API_KEY: "jev-1" }, home);
  expect(runtimeEnv({}, home).JEV_API_KEY).toBe("jev-1");
});
it("lists the judge and extractor knobs", () => {
  for (const k of ["JEV_ENDPOINT", "JEV_MODEL", "MEMORY_JEV", "MEMORY_JEV_MIN", "ENABLE_EXTRACTOR", "EXTRACTOR_MODEL"])
    expect(SETTING_KEYS).toContain(k);
});
it.skipIf(process.platform === "win32")("creates the file 0600 on POSIX", async () => {
  await writeSettings({ OPENAI_API_KEY: "sk-test" }, home);
  expect(statSync(settingsPath(home)).mode & 0o777).toBe(0o600);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/settings.test.ts` → FAIL: "unknown setting" for `OPENAI_API_KEY`, `runtimeEnv` not exported.

- [ ] **Step 3: Implement in `src/core/settings.ts`.** Keep the existing error wording (`unknown setting "X" — settings.json holds only: …`) for everything outside both lists — this is the only place that decides what may be written, and the message is what tells a user they typed a name the console does not own. `readSettings` and `pickSettingKeys` iterate both lists. `writeSettings` passes `{ encoding: "utf8", mode: 0o600 }` to the existing `writeFile` on the tmp path. Rename `embedEnv` to `runtimeEnv` and update the five call sites listed above The server's `/embedding` preview keeps its current behaviour, but its **scope guard must move**: the old refusal of credentials lived in `writeSettings`'s secret regex, and whitelisting secrets removes it, so `POST /embedding` grows its own check — a patch key outside `SETTING_KEYS` is a 400 before preview, message `<KEY> is not an embedding setting — this route writes only: <SETTING_KEYS joined>`. That keeps the route refusing credentials while its response shape is untouched; the one console-api assertion that pinned the old wording changes with it.

- [ ] **Step 4: Run tests** — `npx vitest run tests/settings.test.ts tests/console-api.test.ts tests/embedding.test.ts` → PASS, then `npm test` → PASS (green is the check that the rename reached every caller).

- [ ] **Step 5: Commit** — `git add -A src/core/settings.ts src/api/server.ts src/cli/index.ts src/core/memoryService.ts tests/settings.test.ts` then `git commit -F <message file>` with `feat(settings): hold whitelisted secrets and one runtimeEnv seam` (commit messages always go through a file in this repo).

---

### Task 2: The judge and the extractor read through the seam

**Files:**
- Modify: `src/core/judgment/judge.ts` (reads: `JEV_API_KEY`, `JEV_API_KEY_FILE`, `TYPESAFE_API_KEY`, `JEV_ENDPOINT`, `JEV_MODEL`, `MEMORY_JEV`, `MEMORY_JEV_MIN`)
- Modify: `src/core/extraction/extractor.ts` (reads: `OPENAI_API_KEY`, `ENABLE_EXTRACTOR`, `EXTRACTOR_MODEL`)
- Test: `tests/judge.test.ts`, `tests/extraction.test.ts`

**Interfaces:**
- Consumes: `runtimeEnv` from Task 1.
- Produces: no new exported symbol. `jevApiKey()`, `jevEnabled()`, `jevKeep()` and the extractor keep their signatures; only the source of their values changes.

- [ ] **Step 1: Write the failing tests.** In `tests/judge.test.ts` (its `saved`/`afterEach` env restore already exists):

```ts
it("honors a key written in settings.json, not just the environment", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "jev-home-"));
  process.env.AI_MEMORY_HOME = home;
  delete process.env.JEV_API_KEY;
  await writeSettings({ JEV_API_KEY: "jev-from-file" }, home);
  let sent: Record<string, string> = {};
  const spy = (async (_u: unknown, init: RequestInit) => {
    sent = init.headers as Record<string, string>;
    return new Response(JSON.stringify({ model: "jev-test", answers: { keep: { type: "noul", noul: 0.9 } } }), { status: 200 });
  }) as unknown as typeof fetch;
  await jevKeep("anything", { fetchImpl: spy });
  expect(Object.values(sent).join(" ")).toContain("jev-from-file");
});
it("reads MEMORY_JEV from settings.json", async () => { /* write {MEMORY_JEV:"false"} to the temp home, expect jevEnabled() === false */ });
```

In `tests/extraction.test.ts`: `it("honors ENABLE_EXTRACTOR=false from settings.json even with an env key present")` — set `process.env.OPENAI_API_KEY`, write `{ ENABLE_EXTRACTOR: "false" }` to a temp `AI_MEMORY_HOME`, assert the heuristic path is used (no fetch to the extractor endpoint).

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/judge.test.ts tests/extraction.test.ts` → FAIL: no key found in the file.

- [ ] **Step 3: Implement.** Replace the `process.env` reads in both files with `runtimeEnv()`. Read it once per call, not at module load: that is what makes a key change take effect without a restart.

- [ ] **Step 4: Run tests** — `npx vitest run tests/judge.test.ts tests/extraction.test.ts` → PASS; `npm test` → PASS.

- [ ] **Step 5: Commit** — `feat(judge): read keys and knobs through runtimeEnv`.

---

### Task 3: A `.env` reader that only comments

**Files:**
- Create: `src/core/envFile.ts`
- Test: `tests/env-file.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `envFilePath(cwd?: string): string` (= `process.env.MEMORY_ENV_FILE?.trim() || path.join(cwd ?? process.cwd(), ".env")`), `interface EnvEntry { name: string; value: string; line: number; enabled: boolean }`, `readEnvFile(file: string): EnvEntry[]`, `commentOutEnvKeys(file: string, names: readonly string[]): Promise<{ commented: string[]; backupPath: string | null }>`.

- [ ] **Step 1: Write the failing tests** in `tests/env-file.test.ts` — one temp dir per case, values written literally:

```ts
expect(readEnvFile(f)[0]).toMatchObject({ name: "A", value: "1", enabled: true });          // A=1
// export A=1        -> name A, value 1
// A="1 2"           -> value "1 2" (quotes stripped on read, raw kept for commenting)
// A=1 # note        -> value "1" (inline comment dropped)
// #A=1              -> present but enabled: false; blank lines ignored
// CRLF file, no trailing newline -> parsed the same
// the same name twice -> two entries
```
```ts
it("comments every occurrence and leaves the rest byte-for-byte", async () => {
  const { commented, backupPath } = await commentOutEnvKeys(f, ["JEV_API_KEY"]);
  expect(commented).toEqual(["JEV_API_KEY"]);
  expect(readFileSync(backupPath!, "utf8")).toContain("JEV_API_KEY=");
  expect(readFileSync(f, "utf8")).toContain("#JEV_API_KEY=");
  expect(readFileSync(f, "utf8")).toContain("OTHER=keep");   // every other line untouched
});
it("a name that is absent from the file comments nothing and writes no backup", async () => {
  expect(await commentOutEnvKeys(f, ["NOPE"])).toEqual({ commented: [], backupPath: null });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/env-file.test.ts` → FAIL: module not found.

- [ ] **Step 3: Implement `src/core/envFile.ts`.** Commenting prepends `#` to the line's own leading whitespace position (an `export A=1` line becomes `#export A=1`, so re-enabling is a manual uncomment of the same text). Write `.env` copy → `.env.bak`, then tmp + rename for the new `.env`, removing the tmp on failure — mirror `writeSettings`.

- [ ] **Step 4: Run tests** — `npx vitest run tests/env-file.test.ts` → PASS.

- [ ] **Step 5: Commit** — `feat(env): read .env and comment named keys out, with a backup`.

---

### Task 4: Adopt

**Files:**
- Modify: `src/core/settings.ts`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: `writeSettings` (Task 1), `readEnvFile`/`commentOutEnvKeys`/`envFilePath` (Task 3).
- Produces: `adoptEnvKeys(opts?: { home?: string; envFile?: string }): Promise<{ adopted: string[]; backupPath: string | null; restartRequired: boolean }>`.

- [ ] **Step 1: Write the failing tests**: a temp `.env` holding `JEV_API_KEY=abc`, `MEMORY_JEV=true`, `TYPESAFE_API_KEY=legacy`, `HOME_THING=x` → after `adoptEnvKeys({ home, envFile })`, `adopted` is `["JEV_API_KEY", "MEMORY_JEV"]`, `readSettings(home)` holds both, `.env` has both lines commented, `.env.bak` exists, and `TYPESAFE_API_KEY=legacy` is still an uncommented line **and absent from `readSettings`**. Second test: nothing whitelisted present → `{ adopted: [], backupPath: null, restartRequired: true }` and `.env` unchanged (same bytes).

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/settings.test.ts` → FAIL: `adoptEnvKeys` not exported.

- [ ] **Step 3: Implement `adoptEnvKeys` in `src/core/settings.ts`.** Whitelist = `SETTING_KEYS ∪ SECRET_KEYS`; anything else is left in `.env` untouched. Write settings first, then comment the file: a failure between them leaves the value in both places, which is recoverable, where the reverse order would lose it. `restartRequired` is always `true` — the running process still holds what it read at boot.

- [ ] **Step 4: Run tests** — `npx vitest run tests/settings.test.ts tests/env-file.test.ts` → PASS.

- [ ] **Step 5: Commit** — `feat(settings): adopt whitelisted .env keys into settings.json`.

---

### Task 5: The routes

**Files:**
- Modify: `src/core/settings.ts` (add `settingsInventory`, `maskSecret`, `keyEffect`)
- Modify: `src/api/server.ts`
- Test: `tests/console-api.test.ts`, `tests/api.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `interface SettingsEntry { name: WritableKey; kind: "secret" | "plain"; source: "env" | "file" | "default" | "absent"; masked: string | null; effect: "immediate" | "restart" }`, `settingsInventory(base?: NodeJS.ProcessEnv, home?: string): SettingsEntry[]`, `maskSecret(value: string): string`, `keyEffect(name: WritableKey): "immediate" | "restart"`. Routes: `GET /settings` → `{ entries, settingsPath, envPath, restartRequired }`; `POST /settings` (flat body of names to values) → `{ saved: string[], restartRequired: boolean }`; `POST /settings/adopt-env` → the `adoptEnvKeys` result; `POST /admin/shutdown` → `204` and stops the process.

- [ ] **Step 1: Write the failing tests** in `tests/console-api.test.ts` (`buildServer({ service })` → `{ app }` pattern already there; drive it over a real listener on port 0):
   - `GET /settings` with `OPENAI_API_KEY` in the environment and `JEV_API_KEY` in a temp settings file → the secret entries carry `masked` ending in the last 4 and the response text does **not** contain the full value; the env one reports `source: "env"`, the file one `source: "file"`; `TYPESAFE_API_KEY` set in the environment appears as an `env`-sourced entry (Review Focus 1).
   - `POST /settings` with a name the real environment provides → `400` whose body contains `is set in the environment` (Review Focus 4).
   - `POST /settings` with `{ NOPE: "x" }` → `400`.
   - `POST /settings` with `{ JEV_API_KEY: "k" }` → `200`, and `readSettings(home)` holds it.
   - `POST /settings` with `{ JEV_API_KEY: "bad" }` while the judge's fetch is stubbed to answer 401 → `400`, and `readSettings(home)` is unchanged (validate before write; spec S3).
   - `POST /settings/adopt-env` against a temp `MEMORY_ENV_FILE` → `adopted` names, backup path returned; a second call is a no-op with `adopted: []`.
   - `POST /admin/shutdown` from loopback → the injected shutdown callback is called once; with a non-loopback `remoteAddress` the route is not found (Review Focus 5). `buildServer` gains an optional `onShutdown?: () => void` in its options — the test asserts the callback, never killing the test runner.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/console-api.test.ts` → FAIL: 404 for the new routes.

- [ ] **Step 3: Implement.** Extract the existing shadowed-check + preview-then-write sequence out of the `POST /embedding` handler into one helper used by both routes; `/embedding` behaviour and its response shape stay as they are. Validation is per key kind: embedding keys go through `previewEmbedding` as `/embedding` already does, and a `JEV_API_KEY` patch goes through one noul call using the judge's existing `fetchImpl` seam — a stored-but-broken key is the silent-fallback failure this project keeps writing comments about. `GET /settings` composes `settingsInventory()` with `restartRequired` measured the same way `/embedding` measures it. `/admin/shutdown` is rejected unless `req.socket.remoteAddress` is a loopback address.

- [ ] **Step 4: Run tests** — `npx vitest run tests/console-api.test.ts tests/api.test.ts tests/settings.test.ts` → PASS; `npm test` → PASS.

- [ ] **Step 5: Commit** — `feat(api): settings inventory, secret writes, adopt, and a loopback shutdown`.

---

### Task 6: `ai-memory daemon restart`

**Files:**
- Create: `src/cli/daemon.ts`
- Modify: `src/cli/index.ts` (command table, near line 50)
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `POST /admin/shutdown` (Task 5); the CLI's existing base-URL resolution in `src/cli/http.ts` (`AI_MEMORY_SERVER`, `PORT`/`MEMORY_PORT`, `MEMORY_HOST`).
- Produces: `restartDaemon(deps?: { probe?: () => Promise<boolean>; shutdown?: () => Promise<void>; spawn?: () => void; stdout?: (s: string) => void }): Promise<{ restarted: boolean; reason?: string }>` and the CLI command `daemon restart`.

- [ ] **Step 1: Write the failing tests** with all three dependencies injected (no real daemon, no real child process): nothing answering → `{ restarted: false, reason: "no daemon is running" }`, exit code 0; something answering → `shutdown` called once, then `spawn` called once, `{ restarted: true }`; shutdown throwing → `{ restarted: false }` and `spawn` **not** called.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/cli.test.ts` → FAIL: unknown command.

- [ ] **Step 3: Implement.** Real defaults: `probe` = `GET /health` with a short timeout; `shutdown` = `POST /admin/shutdown` then poll `/health` until it stops answering, bounded at 5s; `spawn` = detached `process.execPath` with the server entry resolved next to the built CLI (`../api/server.js`), inheriting `PORT`/`HOST`; when that file does not exist (running from source under tsx) print the exact command to run instead. A restart that cannot start a replacement must say so and exit non-zero rather than reporting success.

- [ ] **Step 4: Run tests** — `npx vitest run tests/cli.test.ts` → PASS.

- [ ] **Step 5: Commit** — `feat(cli): ai-memory daemon restart`.

---

### Task 7: The console view

**Files:**
- Create: `ui/src/lib/settings-model.ts`, `ui/src/lib/settings-model.test.ts`, `ui/src/views/Settings.tsx`
- Modify: `ui/src/lib/api.ts`, `ui/src/router.tsx`

**Interfaces:**
- Consumes: the routes from Task 5.
- Produces: `api.getSettings(): Promise<SettingsPayload>`, `api.patchSettings(patch: Record<string, string>): Promise<{ saved: string[]; restartRequired: boolean }>`, `api.adoptEnv(): Promise<{ adopted: string[]; backupPath: string | null }>`; pure helpers `effectBadge(effect: "immediate" | "restart"): string`, `sourceBadge(source: SettingsEntry["source"]): string`, `maskedDisplay(entry: SettingsEntry): string`, `needsAdoptBanner(entries: SettingsEntry[]): boolean` (true when any entry is `source: "env"` **and** secret-shaped).

- [ ] **Step 1: Write the failing test** in `ui/src/lib/settings-model.test.ts`: `effectBadge` returns different text for the two effects; `sourceBadge` maps all four sources; `maskedDisplay` shows the mask when present and a placeholder when null; `needsAdoptBanner` is true for an env-sourced secret, false for an env-sourced plain key and false for a file-sourced secret.

- [ ] **Step 2: Run to verify failure** — `npx vitest run ui/src/lib/settings-model.test.ts` → FAIL: module not found.

- [ ] **Step 3: Implement the pure helper, run the test** → PASS (`npx vitest run ui/src/lib/settings-model.test.ts`).

- [ ] **Step 4: Build the view.** Add `settings` to `VIEWS` in `ui/src/router.tsx`; `Settings.tsx` renders the four cards from the spec (Keys, Judge, Extractor, the adopt banner gated by `needsAdoptBanner`, and the restart line showing `ai-memory daemon restart`), each input posting through `patchSettings`, and the one link back to the Stats embedding card. Types in `api.ts` keep the existing file:line citation style.

- [ ] **Step 5: Verify** — `npm --prefix ui run typecheck` → 0 errors; `npm --prefix ui run build` → succeeds; `npx vitest run ui/src/lib` → PASS. Then the behavioural check: the dev daemon is on `127.0.0.1:7331`, open `http://127.0.0.1:7331/app#/settings`, confirm the Keys/Judge/Extractor cards render, that a masked value shows for the machine's real `JEV_API_KEY`, and that the adopt banner appears (it is env-sourced today).

- [ ] **Step 6: Commit** — `feat(console): a settings view for keys and knobs`.

---

### Task 8: ADR-0010 and the two stale README claims

**Files:**
- Create: `docs/adr/0010-console-writes-credentials.md`
- Modify: `docs/adr/0009-embedding-switch-is-settings-plus-restart.md` (status line points at 0010)
- Modify: `README.md` (the paragraph around line 184, and the jev-key block around lines 267-274)

**Interfaces:**
- Consumes: the decisions as built.
- Produces: documentation only.

- [ ] **Step 1: Write ADR-0010** in the repo's ADR shape (Status / Options / Context / Decision): two flat whitelists in `settings.json`; masked reads; adopt comments rather than deletes with a `.env.bak`; `0600` with the explicit Windows caveat; effect timing; **supersedes ADR-0009's "never an API key" clause**, and records why the OS keyring was rejected (ADR-0007's zero-dependency promise for the published package) as the upgrade path.

- [ ] **Step 2: Update the README** — the "never an API key" sentence, and the jev block whose "`# a path, so .env stays shareable`" line no longer describes the console's behaviour. State the precedence and the restart rule the same way the ADR does.

- [ ] **Step 3: Verify no stale claim survives** — `grep -rn "never an API key" README.md docs/ src/` → no hits; `grep -rn "JEV_API_KEY" README.md` → describes both the environment form and the console field.

- [ ] **Step 4: Full suite** — `npm test` → PASS; `npm --prefix ui run typecheck` → 0; `grep -n '\"dependencies\": {}' package.json` → still empty (Global Constraints).

- [ ] **Step 5: Commit** — `docs: ADR-0010 and README for console-written credentials`.

---

## Notes for the executor

- Every commit message goes through a file (`git commit -F <file>`); never inline a message with backticks or `$(...)` in it.
- `git add` explicit paths. This repo has unrelated work in progress in the root; a `git add -A` would sweep it in.
- Tests always use a temp `home` (`AI_MEMORY_HOME` and the `home` argument), never the real `~/.ai-memory`.
- The daemon on this machine is currently started as `npm start` in `C:/memory` and reads `.env` at boot — after Task 5 lands, restarting it is the check that a file-sourced key is really live.
