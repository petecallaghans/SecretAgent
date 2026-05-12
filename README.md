# SecretAgent

Your personal AI assistant on Telegram, powered by Claude (with OpenAI as a cheap helper). It personalizes itself on first message — choosing a name, personality, and learning about you through conversation.

Claude Opus drives the conversation. For routine subtasks (parsing, summarizing, extracting, formatting, transcribing voice) the agent hands off to OpenAI models via a built-in `delegate` tool and Whisper. This keeps Claude Max plan token usage to a minimum without sacrificing the quality of the main agent.

## Prerequisites

- **Node.js 22+**
- **Claude Code** with a Max or Team subscription (main agent — no Anthropic API key needed)
- **Telegram** account
- **OpenAI API key** *(optional but recommended)* — unlocks voice transcription via Whisper and the `delegate` tool that offloads cheap work off the Max plan

## Quick Start

```bash
git clone https://github.com/petecallaghans/SecretAgent.git
cd SecretAgent
npm install
npm run dev
```

That's it. On first run, the setup wizard launches automatically if no `.env` exists — it walks you through creating a Telegram bot and configuring the basics. You can also run it manually with `npm run setup`.

## First Message

When you message the bot for the first time, it will:
- Greet you and ask what you'd like to call it
- Ask about the personality you want (witty, professional, chill, etc.)
- Learn who you are and how it can help
- Save its new identity — all future conversations use that personality

Use `/reset` to start a fresh conversation (personality persists).

## Commands

| Command         | Description                                                  |
|-----------------|--------------------------------------------------------------|
| `/start`        | Welcome message                                              |
| `/reset`        | Clear conversation history                                   |
| `/memory`       | Show what the bot remembers                                  |
| `/cron`         | List scheduled tasks                                         |
| `/model [name]` | View or switch Claude model for this session                 |
| `/effort`       | Set effort level: low, medium, high, max                     |
| `/think`        | Toggle extended thinking                                     |
| `/approve`      | Toggle approval mode for shell/file actions                  |
| `/webhook`      | List registered webhooks                                     |
| `/restart`      | Restart the bot process                                      |
| `/update`       | Pull latest code, preserve personal files, rebuild, restart  |
| `/deep <msg>`   | One-shot: route this message to the deep model (Opus)        |
| `/light <msg>`  | One-shot: route this message to the light model (Haiku)      |

## Configuration

All config lives in `.env` (created by setup):

| Variable                | Default              | Description                                                       |
|-------------------------|----------------------|-------------------------------------------------------------------|
| `TELEGRAM_BOT_TOKEN`    | *(required)*         | From @BotFather                                                   |
| `ALLOWED_USERS`         | *(empty = all)*      | Comma-separated Telegram user IDs                                 |
| `MODEL_LIGHT`           | `claude-haiku-4-5`   | Cheap model for cron, webhooks, voice relay                       |
| `MODEL_DEFAULT`         | `claude-opus-4-6`    | Main user-facing model (also fallback for legacy `MODEL` var)     |
| `MODEL_DEEP`            | `claude-opus-4-6`    | Used by `/deep` prefix                                            |
| `OPENAI_API_KEY`        | *(optional)*         | Enables voice transcription (Whisper) and the `delegate` tool     |
| `OPENAI_DELEGATE_NANO`  | `gpt-5.4-nano`       | Helper model for trivial subtasks                                 |
| `OPENAI_DELEGATE_MINI`  | `gpt-5-mini`         | Default helper for delegated work                                 |
| `OPENAI_DELEGATE_SMART` | `gpt-5.4-mini`       | Helper for harder subtasks                                        |
| `MAX_TOKENS`            | `8192`               | Max response tokens                                               |
| `EFFORT`                | `low`                | low \| medium \| high \| max — caps turns and tokens per query    |
| `THINKING`              | `disabled`           | adaptive \| disabled — extended thinking mode                     |
| `WORKSPACE_DIR`         | `./workspace`        | Agent's working directory                                         |
| `DATA_DIR`              | `./data`             | Session, cron, and webhook data                                   |
| `SHELL_ALLOWLIST`       | *(empty = all)*      | Comma-separated allowed shell commands                            |
| `WEBHOOK_PORT`          | `3000`               | Port for incoming webhooks                                        |

## Scripts

```bash
npm run setup    # interactive setup wizard
npm run dev      # dev mode with hot reload
npm run build    # compile TypeScript
npm start        # run compiled JS (production)
```

## How It Works

```
Telegram → TelegramAdapter → Gateway → Agent → Claude (via Agent SDK)
                                ↕            ↕
                          SessionManager   MCP Tools
                          (sessions.json)  (shell, web, files, memory, cron, delegate)
```

- **No Anthropic API key needed** — uses Claude Code's OAuth flow (requires Max or Team subscription)
- **Session persistence** — conversations resume across bot restarts
- **Memory** — long-term memory in `workspace/memory.md`, daily logs in `workspace/logs/`
- **Personality** — defined in `workspace/soul.md`, rewritten during onboarding
- **Tools** — shell, web fetch/search, file I/O, cron, webhooks, delegate (OpenAI helper)

## Model Routing & Cost Control

To keep Claude Max plan usage low, messages are routed across three Claude tiers plus an OpenAI helper:

| Source                          | Model used                              |
|---------------------------------|-----------------------------------------|
| User chat (default)             | `MODEL_DEFAULT` (Opus 4.6)              |
| Cron job firing                 | `MODEL_LIGHT` (Haiku)                   |
| Webhook firing                  | `MODEL_LIGHT` (Haiku)                   |
| Voice note (post-Whisper)       | `MODEL_LIGHT` (Haiku)                   |
| `/deep <msg>` prefix            | `MODEL_DEEP` (Opus)                     |
| `/light <msg>` prefix           | `MODEL_LIGHT` (Haiku)                   |
| `/model <name>` (session)       | Whatever the user set                   |

The main agent also has a **`delegate` tool** that calls OpenAI (gpt-5-mini default) for cheap subtasks — parsing tool output, summarizing fetched pages, extracting fields, classifying intent, formatting. Opus synthesizes the final answer; the helper produces raw intermediate output. This keeps large raw outputs out of the conversation history that re-enters input on every following turn, cutting Max-plan token usage significantly on tool-heavy workloads.

## Running 24/7

Install as a background service that survives logout and reboot:

```bash
npm run service install    # build + install + start
npm run service status     # check if running (PID, uptime)
npm run service logs       # tail logs (Ctrl+C to stop)
npm run service stop       # stop the service
npm run service start      # start it again
npm run service restart    # restart
npm run service uninstall  # stop + remove service
```

Works on **macOS** (launchd) and **Linux** (systemd) — platform is detected automatically.

## License

MIT
