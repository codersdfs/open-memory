/**
 * Package root — what someone embedding this in their own agent imports.
 *
 * Everything a caller needs is re-exported here so the supported surface is one
 * list of imports, not a scavenger hunt through `dist/src/`. The CLI, the MCP
 * server and the console do not go through this file; it exists for library use.
 */
export { MemoryService } from "./core/memoryService.js";
export { createMemoryTool, autoInject } from "./api/tool.js";
export type { Memory, MemoryInput, MemoryType, SearchOptions, SearchResult, MemoryEvent, MemoryEventKind, ChainView } from "./core/types.js";
export { resolveDbPath, resolveHome } from "./core/dbPath.js";
export { createEmbeddingProvider } from "./core/embedding/index.js";
export { createRegistry, defaultAdapters, type Adapter, type AdapterRegistry } from "./adapters/index.js";
