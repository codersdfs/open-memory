import { cp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The static UI is served, not imported, so tsc never copies it. Mirror it into
 * dist so `src/api/server.js` keeps its `../ui` path in dev and in an installed
 * package — the alternative, a runtime path that depends on where the package
 * was installed, is the bug that made every installed UI 404.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src", "ui");
const to = join(root, "dist", "src", "ui");
await rm(to, { recursive: true, force: true });
await cp(from, to, { recursive: true });
console.log("ui -> dist/src/ui");
