# Plugging open-memory into a coding agent

One store, one CLI, three ways in (plus the library). Pick the lowest number your agent supports.

| Way in | Needs from the agent | Effort |
|---|---|---|
| 1. MCP tools | an MCP client | one command |
| 2. `ai-memory` CLI | a shell | one command |
| 3. `inject` hook | a hook on prompt submit | one command |
| 4. Library / HTTP | you are writing the agent | a `curl` or an import |

Three shapes of client are covered without you writing anything: sixteen agents are
known by name, any other MCP client is one `agent add` away, and an agent with neither
MCP nor hooks still gets the CLI and a managed instructions block.

## 1. One command

```bash
ai-memory agent link --write   # register with every agent detected on this machine
ai-memory agent doctor         # what it wrote, and whether it can work
```

`link` is a dry run until you pass `--write`, and it prints the diff either way.
`unlink` removes exactly what `link` added — never another tool's entry — and the
first write to a file leaves a `.ai-memory.bak` beside it.

## 2. The agent is on the list

`ai-memory agent list` knows sixteen clients without any declaration. Four are
built in (`claude`, `codex`, `dsh`, `pi`); the other twelve are a table of paths, so
`agent link --agent <id> --write` works on a fresh install with nothing to configure.

| Id | Config file | Format |
|---|---|---|
| `cursor` | `~/.cursor/mcp.json` | JSON |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` | JSON |
| `cline` | `~/.cline/data/cline_mcp_settings.json` | JSON |
| `zed` | `%APPDATA%\Zed\settings.json` → `context_servers` | JSONC |
| `continue` | `~/.continue/mcpServers/ai-memory.json` | JSON |
| `vscode` | `%APPDATA%\Code\User\mcp.json` → `servers` (`~/Library/Application Support/Code/User/mcp.json`, `~/.config/Code/User/mcp.json`) | JSONC |
| `gemini` | `~/.gemini/settings.json` | JSON |
| `opencode` | `$XDG_CONFIG_HOME/opencode/opencode.json`, else `~/.config/opencode/opencode.json`, else legacy | JSON |
| `qwen` | `~/.qwen/settings.json` | JSON |
| `crush` | `~/.config/crush/crush.json` | JSON |
| `amp` | `~/.config/amp/settings.json` | JSON |
| `aider` | `~/.aider/mcp.json` | JSON |

Two of these files are **JSONC** — they ship with comments (Zed's `settings.json`
opens with `// Zed settings`). Those are edited by splicing text in and out, never by
round-tripping through `JSON.parse`, so `link` then `unlink` gives back a
byte-identical file and your comments survive both.

`installed` / `not found` in `agent list` is a directory probe, not a guess: it looks
for the client's own folder under your home. A client that is not found is still
listed, because "absent from the list" reads as "unsupported", and only a bare
`agent link --write` filters to what is installed — the twelve known clients are
listed with `--agent`.

## 3. The agent is not on the list

Any MCP client is one declaration away. No code, no rebuild — the config lives in
`~/.ai-memory/agents.json`, and `agent add` writes it for you:

```bash
ai-memory agent add myeditor --mcp-file ~/.myeditor/mcp.json
ai-memory agent add myeditor --mcp-file ~/.myeditor/mcp.json --write
```

Then `ai-memory agent status --agent myeditor` and `ai-memory agent unlink --agent
myeditor --write` work like any built-in. `--format jsonc` is there for a file with
comments; `--json-path` when the server map is not `mcpServers`.

Flags:

| Flag | Meaning |
|---|---|
| `--mcp-file <path>` | the client's config file (required). `~` is expanded |
| `--json-path <key>` | where the server map lives. Default `mcpServers` (`mcp_servers` for `--format toml`). Dotted paths work: `mcp.servers` |
| `--format json\|jsonc\|toml` | the file's format. TOML is edited section-wise, like Codex does; JSONC preserves comments |
| `--env K=V[,K=V]` | extra env for the spawned server, on top of `AI_MEMORY_AGENT=<id>` |
| `--instructions <path>` | a rules/instructions file that also gets the managed memory block |

The declaration, hand-written, is the same thing:

```json
{
  "agents": {
    "myeditor": { "mcpFile": "~/.myeditor/mcp.json" },
    "windsurf-fork": { "mcpFile": "~/.codeium/windsurf/mcp_config.json", "env": { "AI_MEMORY_USER": "frank" } }
  }
}
```

An id that is already known is **refused**, for two different reasons. The four
built-ins (`claude`, `codex`, `dsh`, `pi`) write more than an MCP entry — Claude
Code's hooks, Codex's TOML section and managed block — so a declaration would drop
that work silently. The twelve known clients are already linked directly from their
own path, so a declaration pointing somewhere else is almost always a mistake; if the
config genuinely lives elsewhere, use a different id. `agent specs` marks a
hand-written collision, `agent doctor` fails on one, and `ai-memory agent remove <id>`
clears it.

## 4. What gets written

| Agent | MCP entry | Instructions |
|---|---|---|
| Claude Code | `~/.claude.json` → `mcpServers.ai-memory` | hooks in `~/.claude/settings.json` (`SessionStart`, `UserPromptSubmit`, `Stop`) call `ai-memory inject` |
| Codex CLI | `~/.codex/config.toml` → `[mcp_servers.ai-memory]` | managed block in `~/.codex/AGENTS.md` |
| DeepSeek Harness | `$DSH_HOME/mcp.json` → `mcpServers.ai-memory` | — |
| pi | `~/.pi/agent/mcp-adapter.json` → `mcpServers.ai-memory` | — |
| the twelve in §2 | `mcpServers.ai-memory` (Zed: `context_servers`, VS Code: `servers`) | — |

Every entry spawns the same process: `<node> <cli> mcp`, with `AI_MEMORY_AGENT`
set to the agent id — that variable is what puts a write in the right partition.

## 5. The three mechanisms

- **Managed instructions block** — a `<!-- ai-memory:begin -->` … `<!-- ai-memory:end -->`
  block telling the agent the tools exist and to search before guessing. Text only:
  the fallback for an agent with neither MCP nor hooks.
- **`inject` hook** — the agent pipes its hook payload on stdin, and the block printed on
  stdout becomes context for that turn. Budgeted (`AI_MEMORY_INJECT_BUDGET`, default
  600) and silent when nothing scores above `AI_MEMORY_INJECT_THRESHOLD`.
- **MCP tools** — `memory_search`, `memory_remember`, `memory_list`, `memory_get`,
  `memory_forget`, `memory_stats`. Every tool takes an explicit `scope`, so the agent
  decides private vs shared per call. This is the one to prefer.

## 6. You are writing the agent

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

## 7. When it does not work

```bash
ai-memory agent doctor      # runtime, cli build, store, identity, per-agent state
ai-memory db info           # which store, and why that one
```

`doctor` fails only on things that cannot work; a detected-but-unlinked agent is
advice, not breakage. If a config file is not valid JSON, `link` refuses to touch it
and says so, rather than writing over it. A JSONC file that fails to parse gets the
same refusal — the splicer re-parses its own output and compares the target path
before it writes, so a bug in the splice shows up as an error, not as a mangled
editor config.

If `agent list` says `not found` for something you have installed, the probe looked for
the wrong folder: the exact paths are the table in §2, and `agent status --agent <id>`
prints the one it used.
