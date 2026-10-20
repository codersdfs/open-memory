# Plugging open-memory into a coding agent

One store, one CLI, four ways in. Pick the lowest number your agent supports.

| Way in | Needs from the agent | Effort |
|---|---|---|
| 1. MCP tools | an MCP client | one command |
| 2. `ai-memory` CLI | a shell | one command |
| 3. `inject` hook | a hook on prompt submit | one command |
| 4. Library / HTTP | you are writing the agent | a `curl` or an import |

## 1. One command

```bash
ai-memory agent link --write   # register with every agent detected on this machine
ai-memory agent doctor         # what it wrote, and whether it can work
```

`link` is a dry run until you pass `--write`, and it prints the diff either way.
`unlink` removes exactly what `link` added — never another tool's entry — and the
first write to a file leaves a `.ai-memory.bak` beside it.

## 2. The agent is not on the list

Any MCP client is one declaration away. No code, no rebuild — the config lives in
`~/.ai-memory/agents.json`, and `agent add` writes it for you:

```bash
ai-memory agent add cursor --mcp-file ~/.cursor/mcp.json
ai-memory agent add cursor --mcp-file ~/.cursor/mcp.json --write
```

Then `ai-memory agent status --agent cursor` and `ai-memory agent unlink --agent cursor --write`
work like any built-in.

Flags:

| Flag | Meaning |
|---|---|
| `--mcp-file <path>` | the client's config file (required). `~` is expanded |
| `--json-path <key>` | where the server map lives. Default `mcpServers` (`mcp_servers` for `--format toml`). Dotted paths work: `mcp.servers` |
| `--format json\|toml` | the file's format. TOML is edited section-wise, like Codex does |
| `--env K=V[,K=V]` | extra env for the spawned server, on top of `AI_MEMORY_AGENT=<id>` |
| `--instructions <path>` | a rules/instructions file that also gets the managed memory block |

The declaration, hand-written, is the same thing:

```json
{
  "agents": {
    "cursor": { "mcpFile": "~/.cursor/mcp.json" },
    "windsurf": { "mcpFile": "~/.codeium/windsurf/mcp_config.json", "env": { "AI_MEMORY_USER": "frank" } }
  }
}
```

An id that is also built in (`claude`, `codex`, `dsh`, `pi`) is **refused**. Those
adapters write more than an MCP entry — Claude Code's hooks, Codex's TOML section and
managed block — so a declaration would drop that work silently. Link them as they are,
`ai-memory agent link --agent claude --write`, and pick another id if you really want a
second entry. `agent specs` marks a hand-written collision, `agent doctor` fails on one,
and `ai-memory agent remove <id>` clears it.

## 3. What gets written

| Agent | MCP entry | Instructions |
|---|---|---|
| Claude Code | `~/.claude.json` → `mcpServers.ai-memory` | hooks in `~/.claude/settings.json` (`SessionStart`, `UserPromptSubmit`, `Stop`) call `ai-memory inject` |
| Codex CLI | `~/.codex/config.toml` → `[mcp_servers.ai-memory]` | managed block in `~/.codex/AGENTS.md` |
| DeepSeek Harness | `$DSH_HOME/mcp.json` → `mcpServers.ai-memory` | — |
| pi | `~/.pi/agent/mcp-adapter.json` → `mcpServers.ai-memory` | — |

Every entry spawns the same process: `<node> <cli> mcp`, with `AI_MEMORY_AGENT`
set to the agent id — that variable is what puts a write in the right partition.

## 4. The three mechanisms

- **Managed instructions block** — a `<!-- ai-memory:begin -->` … `<!-- ai-memory:end -->`
  block telling the agent the tools exist and to search before guessing. Text only:
  the fallback for an agent with neither MCP nor hooks.
- **`inject` hook** — the agent pipes its hook payload on stdin, and the block printed on
  stdout becomes context for that turn. Budgeted (`AI_MEMORY_INJECT_BUDGET`, default
  600) and silent when nothing scores above `AI_MEMORY_INJECT_THRESHOLD`.
- **MCP tools** — `memory_search`, `memory_remember`, `memory_list`, `memory_get`,
  `memory_forget`, `memory_stats`. Every tool takes an explicit `scope`, so the agent
  decides private vs shared per call. This is the one to prefer.

## 5. You are writing the agent

- **HTTP** — any language:

  ```bash
  curl -X POST http://127.0.0.1:3000/memories/search \
    -H "Content-Type: application/json" \
    -d '{"query":"where does the user live?","namespaces":"default:default","k":5,"budgetTokens":800}'
  ```

- **TypeScript** — `npm i open-memory`:

  ```ts
  import { MemoryService, createMemoryTool, autoInject } from "open-memory";

  const svc = new MemoryService();
  await svc.init();

  const tool = createMemoryTool(svc); // hand this to your tool-calling loop
  const { injected } = await autoInject(svc, messages, { budgetTokens: 800 });
  ```

- **CLI** — anything that can spawn a process: `ai-memory save "…"`, `ai-memory search "…" --json`.

## 6. When it does not work

```bash
ai-memory agent doctor      # runtime, cli build, store, identity, per-agent state
ai-memory db info           # which store, and why that one
```

`doctor` fails only on things that cannot work; a detected-but-unlinked agent is
advice, not breakage. If a config file is not valid JSON, `link` refuses to touch it
and says so, rather than writing over it.
