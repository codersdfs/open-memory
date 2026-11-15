import { createHash } from "node:crypto";

/**
 * Deterministic ids for the code index (ADR-0050).
 *
 * Both the sync and the stores derive the same id from the natural key, so an
 * incremental sync can name symbols a store has not seen yet, and a re-index of
 * an unchanged natural key keeps the id — line drift never rewrites identity.
 */

export const codeSymbolId = (project: string, filePath: string, qualifiedName: string): string =>
  createHash("sha1").update(`${project}\u0000${filePath}::${qualifiedName}`).digest("hex");

export const codeFileId = (project: string, filePath: string): string =>
  createHash("sha1").update(`${project}\u0000file\u0000${filePath}`).digest("hex");
