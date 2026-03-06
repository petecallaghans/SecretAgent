# SecretAgent

Your personal AI assistant on Telegram, powered by Claude. It personalizes itself on first message — choosing a name, personality, and learning about you through conversation.

## Prerequisites

- **Node.js 22+**
- **Claude Code** with a Max or Team subscription
- **Telegram** account

## Quick Start

```bash
# 1. Clone
git clone https://github.com/petemill/SecretAgent.git
cd SecretAgent

# 2. Install dependencies
npm install

# 3. Run setup wizard
npm run setup

# 4. Start the bot
npm run dev
```

The setup wizard will walk you through:
1. Verifying Claude Code is installed and authenticated
2. Creating a Telegram bot (via @BotFather)
3. Optionally restricting access to your Telegram user ID
4. Writing your `.env` config

## First Message

When you message the bot for the first time, it will:
- Greet you and ask what you'd like to call it
- Ask about the personality you want (witty, professional, chill, etc.)
- Learn who you are and how it can help
- Save its new identity — all future conversations use that personality

Use `/reset` to start a fresh conversation (personality persists).

## Commands

| Command   | Description                        |
|-----------|------------------------------------|
| `/start`  | Welcome message                    |
| `/reset`  | Clear conversation history         |
| `/memory` | Show what the bot remembers        |
| `/cron`   | List scheduled tasks               |

## Configuration

All config lives in `.env` (created by `npm run setup`):

| Variable             | Default              | Description                              |
|----------------------|----------------------|------------------------------------------|
| `TELEGRAM_BOT_TOKEN` | *(required)*         | From @BotFather                          |
| `ALLOWED_USERS`      | *(empty = all)*      | Comma-separated Telegram user IDs        |
| `MODEL`              | `claude-sonnet-4-5`  | Claude model to use                      |
| `MAX_TOKENS`         | `8192`               | Max response tokens                      |
| `WORKSPACE_DIR`      | `./workspace`        | Agent's working directory                |
| `DATA_DIR`           | `./data`             | Session and cron data                    |
| `SHELL_ALLOWLIST`    | *(empty = all)*      | Comma-separated allowed shell commands   |

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
