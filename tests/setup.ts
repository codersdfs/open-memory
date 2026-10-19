/**
 * Every test file runs with an empty memory home and no judge credentials.
 *
 * The settings seam is `AI_MEMORY_HOME` (see `resolveHome`), and until this file existed a
 * suite's colour depended on what the developer's machine happened to have configured:
 * a real `JEV_API_KEY` in `~/.ai-memory/settings.json` made every "no key" assertion fail
 * and made the extraction gate ask a live model, whose answers differ per run. Console
 * tests already redirect this seam by hand; this makes the empty home the default instead
 * of a ritual each new test has to remember.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AI_MEMORY_HOME = mkdtempSync(path.join(os.tmpdir(), "ai-memory-test-home-"));

/** Names that would otherwise arrive from the developer's shell or a checkout's `.env`. */
const FOREIGN = [
  "JEV_API_KEY",
  "JEV_API_KEY_FILE",
  "TYPESAFE_API_KEY",
  "MEMORY_JEV",
  "MEMORY_JEV_MIN",
  "MEMORY_RECONCILE",
  "MEMORY_RECONCILE_LEX",
  "MEMORY_RECONCILE_COS",
  "MEMORY_RECONCILE_MARGIN",
  "MEMORY_VECTOR_WEIGHT",
  "MEMORY_SEMANTIC_MARGIN",
  "ENABLE_EXTRACTOR",
  "EXTRACTOR_MODEL",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_DIM",
  "NIM_DIM",
  "OPENAI_API_KEY",
  "NVIDIA_API_KEY",
  "NIM_API_KEY",
  "NIM_INPUT_TYPE",
  "NIM_TRUNCATE",
  "OPENAI_BASE_URL",
  "NIM_BASE_URL",
  "OPENAI_EMBED_MODEL",
  "NIM_EMBED_MODEL",
  "JEV_ENDPOINT",
] as const;

for (const key of FOREIGN) delete process.env[key];
