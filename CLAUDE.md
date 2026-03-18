# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # dev with hot reload (tsx watch)
npm run build     # compile TypeScript (tsc → dist/)
npm start         # run compiled JS (production)
npm run setup     # interactive setup wizard (runs automatically on first dev/start if no .env)
npm run service install|status|logs|stop|start|restart|uninstall  # manage as background service (macOS launchd / Linux systemd)
```

No test suite exists. Verify changes by running `npm run build` (strict TypeScript) and manual testing via `npm run dev`.

## Architecture

```
Telegram → TelegramAdapter → Gateway → Agent (query()) → Claude via Agent SDK
                                ↕              ↕
                          SessionManager    MCP ToolServer
                          (sessions.json)   (in-process)
                               ↕
                        CronScheduler / WebhookServer
```

- **Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — tunnels through Claude Code, supports Max subscription auth via OAuth. No API key needed.
- **MCP tools** — all custom tools are served via an in-process MCP server using `createSdkMcpServer()` + `tool()` + Zod v4. Tools: shell, fetch_url, web_search, read_file, write_file, list_files, send_file, save_memory, append_memory, save_soul, append_log, read_log, manage_cron, manage_webhook.
- **Session resume** — SDK manages conversation history. We store a `chatId → sdkSessionId` map in `data/sessions.json`. On subsequent messages, pass `resume: sessionId` to `query()`.
- **Images** — saved to `workspace/tmp/` as files; agent uses built-in `Read` tool to view them.
- **Voice/Video notes** — downloaded as OGG, transcribed via OpenAI Whisper (`OPENAI_API_KEY` required), then sent as text to the agent.
- **External MCP servers** — agent loads additional MCP server configs from `workspace/mcp.json` at runtime, auto-allowlisting their tools.

## Key Design Decisions

- **bypassPermissions** — agent runs headless, so we skip all Claude Code permission prompts (`permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`).
- **allowedTools** — restricted to `mcp__secret-agent-tools__*` (our custom tools) plus `Read` (built-in, for image viewing). External MCP servers from `mcp.json` are also allowlisted.
- **System prompt** — built from `workspace/soul.md` + `workspace/memory.md` + recent daily logs + current timestamp. Set once at session creation; memory updates during a session are visible via memory tools but not reflected in the system prompt until a new session.
- **Shared chatId state** — a mutable `{ chatId }` object is shared between `Agent` and `createToolServer()` so tools can tag cron/webhook jobs with the current chat.
- **Approval mode** — per-chat toggle (`/approve`). When enabled, shell commands and file writes require user confirmation via Telegram inline buttons (2-minute timeout → auto-deny).
- **Gateway queuing** — messages for the same chatId are serialized; concurrent messages queue behind the active one.
- **Late-binding refs** — `index.ts` uses mutable refs (`telegramRef`, `gatewayRef`) because Telegram/Gateway are created after the tool server but tools need to call back into them.
- **`delete process.env.CLAUDECODE`** — in `index.ts`, so the Agent SDK doesn't think it's already inside a Claude Code session during development.

## Project Structure

```
src/
  index.ts        — entrypoint, wires all components
  types.ts        — Config, CronJobDef, WebhookDef, loadConfig()
  agent.ts        — Agent class wrapping query() async generator
  gateway.ts      — request queue, routes messages/images/voice to agent, per-chat model switching
  sessions.ts     — chatId↔sessionId map (JSON file)
  telegram.ts     — grammY bot, auth middleware, commands (/start /reset /memory /cron /model /approve /restart /webhook)
  memory.ts       — soul.md + memory.md + daily logs reader/writer with fs.watch
  cron.ts         — node-cron scheduler with persistence
  webhook.ts      — HTTP server for incoming webhooks
  service.ts      — install/manage as system service (launchd/systemd)
  setup.ts        — interactive first-run setup wizard
  tools/
    index.ts      — createToolServer() — MCP server with all tools
    shell.ts      — executeShell() with allowlist
    web.ts        — fetchUrl(), webSearch() via DuckDuckGo
    files.ts      — readFileContent(), writeFileContent(), listFiles()
workspace/
  soul.md         — system prompt / personality (rewritten during onboarding)
  memory.md       — agent-managed long-term memory
  mcp.json        — optional external MCP server configs
data/
  sessions.json   — chatId → SDK session ID map
  crons.json      — persisted cron job definitions
  webhooks.json   — persisted webhook definitions
```

## Config (.env)

```
TELEGRAM_BOT_TOKEN=   # required
ALLOWED_USERS=        # comma-separated Telegram user IDs (empty = all)
MODEL=                # default: claude-sonnet-4-5
MAX_TOKENS=           # default: 8192
WORKSPACE_DIR=        # default: ./workspace
DATA_DIR=             # default: ./data
SHELL_ALLOWLIST=      # comma-separated allowed commands (empty = all)
WEBHOOK_PORT=         # default: 3000
OPENAI_API_KEY=       # optional, needed for voice transcription
```

No `ANTHROPIC_API_KEY` — auth is handled by Claude Code's OAuth flow.
