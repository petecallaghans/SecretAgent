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

Tests: `npm test` (node:test via tsx, `test/*.test.ts`). Also verify with `npm run build` (strict TypeScript; does not typecheck `test/`) and manual testing via `npm run dev`.

## Architecture

```
Telegram ─┐
          ├→ ChannelRegistry → Gateway → Agent (query()) → Claude via Agent SDK
Slack ────┘                       ↕              ↕
                            SessionManager    MCP ToolServer + Haiku subagents
                            (sessions.json)   (in-process)
                                 ↕
                          CronScheduler / WebhookServer
```

- **Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — tunnels through Claude Code, supports Max subscription auth via OAuth. No API key needed.
- **MCP tools** — all custom tools are served via an in-process MCP server using `createSdkMcpServer()` + `tool()` + Zod v4. Tools: shell, fetch_url, web_search, read_file, write_file, list_files, send_file, memory_search, save_memory, append_memory, save_soul, append_log, read_log, manage_cron, manage_webhook, delegate.
- **Channels** — `ChannelAdapter` interface (`src/channels/types.ts`); chat ids are namespaced strings: bare numeric ids = Telegram (legacy), `slack:<channel>` = Slack. Slack adapter (Bolt, Socket Mode) only starts when `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` are set.
- **Subagents** — `researcher` (web/memory) and `worker` (shell/files) defined in `agent.ts` via the SDK `agents` option, run on Haiku with narrow tool lists; keeps grunt work out of the main context.
- **Session resume** — SDK manages conversation history. We store a `chatId → {sessionId, count}` map in `data/sessions.json`. On subsequent messages, pass `resume: sessionId` to `query()`. After `SESSION_MAX_MESSAGES` exchanges the gateway queues a wrap-up turn (summary → daily log) and clears the session.
- **Images** — saved to `workspace/tmp/` as files; agent uses built-in `Read` tool to view them.
- **Voice/Video notes** — downloaded as OGG, transcribed via OpenAI Whisper (`OPENAI_API_KEY` required), then sent as text to the agent.
- **External MCP servers** — agent loads additional MCP server configs from `workspace/mcp.json` at runtime, auto-allowlisting their tools.

## Key Design Decisions

- **bypassPermissions** — agent runs headless, so we skip all Claude Code permission prompts (`permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`).
- **allowedTools** — restricted to `mcp__secret-agent-tools__*` (our custom tools) plus `Read` (built-in, for image viewing). External MCP servers from `mcp.json` are also allowlisted.
- **Memory layout** — `workspace/memory.md` is a short INDEX (one line per topic); substance lives in `workspace/memory/topics/<slug>.md`; daily logs in `workspace/memory/YYYY-MM-DD.md`. `memory_search` greps all of it. A nightly cron (`MEMORY_DISTILL_CRON`) distills yesterday's log into topics on the light model.
- **System prompt** — built from `workspace/soul.md` + memory index + memory protocol + recent daily logs + current timestamp. Set once at session creation; memory updates during a session are visible via memory tools but not reflected in the system prompt until a new session.
- **Shared chatId state** — a mutable `{ chatId }` object is shared between `Agent` and `createToolServer()` so tools can tag cron/webhook jobs with the current chat.
- **Approval mode** — per-chat toggle (`/approve`). When enabled, shell commands and file writes require user confirmation via Telegram inline buttons (2-minute timeout → auto-deny).
- **Gateway queuing** — messages for the same chatId are serialized; concurrent messages queue behind the active one.
- **Late-binding refs** — `index.ts` creates the `ChannelRegistry` (and a `gatewayRef`) before the adapters exist because the tool server needs to call back into them; adapters are registered afterwards.
- **Per-chat prefs** — model + effort persisted in `data/prefs.json` (`src/prefs.ts`); `/deep` bumps effort to high for that message.
- **`delete process.env.CLAUDECODE`** — in `index.ts`, so the Agent SDK doesn't think it's already inside a Claude Code session during development.

## Project Structure

```
src/
  index.ts        — entrypoint, wires all components + nightly distill cron
  types.ts        — Config, CronJobDef, WebhookDef, loadConfig()
  agent.ts        — Agent class wrapping query() async generator; subagent definitions
  gateway.ts      — request queue, routes messages/images/voice to agent, model/effort selection, session rotation
  sessions.ts     — chatId↔{sessionId,count} map (JSON file)
  prefs.ts        — per-chat model/effort prefs (data/prefs.json)
  telegram.ts     — grammY bot, auth middleware, commands (/start /reset /memory /cron /model /effort /approve /restart /update /webhook)
  memory.ts       — soul.md + memory index + topics + daily logs reader/writer with fs.watch
  cron.ts         — node-cron scheduler with persistence
  webhook.ts      — HTTP server for incoming webhooks + peer channel
  service.ts      — install/manage as system service (launchd/systemd)
  setup.ts        — interactive first-run setup wizard
  update.ts       — /update self-update: snapshots workspace personal files, git-resets to upstream, restores files, npm install + build
  channels/
    types.ts      — ChannelAdapter interface (namespaced chat ids)
    registry.ts   — ChannelRegistry, prefix → adapter routing
    slack.ts      — SlackAdapter (@slack/bolt socket mode) + mrkdwn conversion
  tools/
    index.ts      — createToolServer() — MCP server with all tools
    shell.ts      — executeShell() with allowlist + metachar guard
    web.ts        — fetchUrl(), webSearch() (Brave → DDG scrape → instant answer)
    memorySearch.ts — searchMemory() over index/topics/logs
    files.ts      — readFileContent(), writeFileContent(), listFiles()
workspace/
  soul.md         — system prompt / personality (rewritten during onboarding)
  memory.md       — memory INDEX (one line per topic)
  memory/topics/  — topic files (the real memory content)
  memory/         — daily logs (YYYY-MM-DD.md)
  mcp.json        — optional external MCP server configs
data/
  sessions.json   — chatId → {sessionId, count}
  prefs.json      — per-chat model/effort
  crons.json      — persisted cron job definitions
  webhooks.json   — persisted webhook definitions
```

## Config (.env)

```
TELEGRAM_BOT_TOKEN=   # required
ALLOWED_USERS=        # comma-separated Telegram user IDs (empty = all)
SLACK_BOT_TOKEN=      # optional — xoxb-…; with SLACK_APP_TOKEN enables the Slack channel
SLACK_APP_TOKEN=      # optional — xapp-… (socket mode, connections:write)
SLACK_ALLOWED_USERS=  # comma-separated Slack user IDs (empty = all)
MODEL_LIGHT=          # default: claude-haiku-4-5 — cron, webhooks, maintenance turns
MODEL_DEFAULT=        # default: claude-opus-4-6 — main user-facing agent (fallback: MODEL)
MODEL_DEEP=           # default: claude-opus-4-6 — /deep prefix override
OPENAI_DELEGATE_NANO= # default: gpt-5.4-nano — `delegate` tool trivial tier
OPENAI_DELEGATE_MINI= # default: gpt-5-mini — `delegate` tool workhorse
OPENAI_DELEGATE_SMART=# default: gpt-5.4-mini — `delegate` tool harder subtasks
MAX_TOKENS=           # default: 8192
WORKSPACE_DIR=        # default: ./workspace
DATA_DIR=             # default: ./data
SHELL_ALLOWLIST=      # comma-separated allowed commands (empty = all)
WEBHOOK_PORT=         # default: 3000
BRAVE_API_KEY=        # optional — real web search via Brave (else DDG HTML scrape)
MEMORY_DISTILL_CRON=  # default: 30 3 * * * — nightly memory distillation (empty = off)
SESSION_MAX_MESSAGES= # default: 40 — exchanges before session wrap-up + rotation (0 = off)
OPENAI_API_KEY=       # optional, needed for voice transcription
EFFORT=               # low|medium|high|max (default: medium) — caps maxTurns + maxTokens per query
THINKING=             # adaptive|disabled (default: disabled) — extended thinking mode
```

No `ANTHROPIC_API_KEY` — auth is handled by Claude Code's OAuth flow.
