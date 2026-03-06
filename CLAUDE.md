# SecretAgent

Lightweight AI agent with a Telegram interface, powered by the Claude Agent SDK.

## Architecture

```
Telegram → TelegramAdapter → Gateway → Agent (query()) → Claude via Agent SDK
                                ↕              ↕
                          SessionManager    MCP ToolServer
                          (sessions.json)   (in-process)
```

- **Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — tunnels through Claude Code, supports Max subscription auth via OAuth. No API key needed.
- **MCP tools** — all custom tools (shell, web, files, memory, cron) are served via an in-process MCP server using `createSdkMcpServer()` + `tool()` + Zod.
- **Session resume** — the SDK manages conversation history. We store a `chatId → sdkSessionId` map in `data/sessions.json`. On subsequent messages, we pass `resume: sessionId` to `query()`.
- **Images** — saved to `workspace/tmp/` as files; agent uses built-in `Read` tool to view them.

## Project Structure

```
src/
  index.ts        — entrypoint, wires all components
  types.ts        — Config, CronJobDef, loadConfig()
  agent.ts        — Agent class wrapping query() async generator
  gateway.ts      — request queue, routes messages/images to agent
  sessions.ts     — chatId↔sessionId map (JSON file)
  telegram.ts     — grammY bot, auth middleware, /start /reset /memory /cron
  memory.ts       — soul.md + memory.md reader/writer with fs.watch
  cron.ts         — node-cron scheduler with persistence
  tools/
    index.ts      — createToolServer() — MCP server with all tools
    shell.ts      — executeShell() with allowlist
    web.ts        — fetchUrl(), webSearch() via DuckDuckGo
    files.ts      — readFileContent(), writeFileContent(), listFiles()
workspace/
  soul.md         — system prompt / personality
  memory.md       — agent-managed long-term memory
data/
  sessions.json   — chatId → SDK session ID map
  crons.json      — persisted cron job definitions
```

## Commands

```bash
npm run dev       # dev with hot reload (tsx watch)
npm run build     # compile TypeScript
npm start         # run compiled JS
```

## Prerequisites

- Node 22+
- `claude login` (authenticate with Claude Max subscription)
- `TELEGRAM_BOT_TOKEN` in `.env`

## Config (.env)

```
TELEGRAM_BOT_TOKEN=   # required
ALLOWED_USERS=        # comma-separated Telegram user IDs (empty = all)
MODEL=                # default: claude-sonnet-4-5
MAX_TOKENS=           # default: 8192
WORKSPACE_DIR=        # default: ./workspace
DATA_DIR=             # default: ./data
SHELL_ALLOWLIST=      # comma-separated allowed commands (empty = all)
```

No `ANTHROPIC_API_KEY` — auth is handled by Claude Code's OAuth flow.

## Key Design Decisions

- **bypassPermissions** — agent runs headless, so we skip all Claude Code permission prompts (`permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`).
- **allowedTools** — restricted to `mcp__secret-agent-tools__*` (our custom tools) plus `Read` (built-in, needed for image viewing).
- **System prompt** — built from `workspace/soul.md` + `workspace/memory.md` + current timestamp. Set once at session creation; memory updates during a session are visible via memory tools but not reflected in the system prompt until a new session.
- **Shared chatId state** — a mutable `{ chatId }` object is shared between `Agent` and `createToolServer()` so the cron tool can tag jobs with the current chat.

## Recent Changes

- **Swapped `@anthropic-ai/sdk` → `@anthropic-ai/claude-agent-sdk`** — no more direct API calls; everything goes through `query()` which tunnels via Claude Code.
- **Zod v4** — required by the Agent SDK for MCP tool schemas.
- **Sessions simplified** — was JSONL per-chat message history with token budgeting; now a single JSON map (SDK manages conversation history internally).
- **No more `MessageParam`** — the agent receives plain text prompts, not structured message arrays.
