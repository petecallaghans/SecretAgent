# SecretAgent

Your personal AI assistant on Telegram, powered by Claude. It personalizes itself on first message — choosing a name, personality, and learning about you through conversation.

## Prerequisites

- **Node.js 22+**
- **Claude Code** with a Max or Team subscription
- **Telegram** account

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

| Command    | Description                        |
|------------|------------------------------------|
| `/start`   | Welcome message                    |
| `/reset`   | Clear conversation history         |
| `/memory`  | Show what the bot remembers        |
| `/cron`    | List scheduled tasks               |
| `/model`   | Switch Claude model                |
| `/approve` | Toggle approval mode for actions   |
| `/webhook` | List registered webhooks           |

## Configuration

All config lives in `.env` (created by setup):

| Variable             | Default              | Description                              |
|----------------------|----------------------|------------------------------------------|
| `TELEGRAM_BOT_TOKEN` | *(required)*         | From @BotFather                          |
| `ALLOWED_USERS`      | *(empty = all)*      | Comma-separated Telegram user IDs        |
| `MODEL`              | `claude-sonnet-4-5`  | Claude model to use                      |
| `MAX_TOKENS`         | `8192`               | Max response tokens                      |
| `WORKSPACE_DIR`      | `./workspace`        | Agent's working directory                |
| `DATA_DIR`           | `./data`             | Session and cron data                    |
| `SHELL_ALLOWLIST`    | *(empty = all)*      | Comma-separated allowed shell commands   |
| `WEBHOOK_PORT`       | `3000`               | Port for incoming webhooks               |

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
                          (sessions.json)  (shell, web, files, memory, cron)
```

- **No API key needed** — uses Claude Code's OAuth flow (requires Max or Team subscription)
- **Session persistence** — conversations resume across bot restarts
- **Memory** — the agent maintains long-term memory in `workspace/memory.md`
- **Personality** — defined in `workspace/soul.md`, rewritten during onboarding
- **Tools** — shell execution, web fetching/searching, file read/write, cron scheduling

## Running 24/7 (systemd)

```bash
npm run build
sudo cp secret-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable secret-agent
sudo systemctl start secret-agent
```

Check status with `sudo systemctl status secret-agent` and logs with `journalctl -u secret-agent -f`.

Edit the service file if your install path or user differs from `/root/SecretAgent`.

## Docker

```bash
docker build -t secret-agent .
docker run -d \
  --env-file .env \
  -v $(pwd)/workspace:/app/workspace \
  -v $(pwd)/data:/app/data \
  secret-agent
```

## License

MIT
