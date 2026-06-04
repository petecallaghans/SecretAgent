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
| `PEER_SECRET`           | *(optional)*         | Shared bearer secret for the peer channel (multi-agent teams)     |
| `MAX_HOPS`              | `8`                  | Max agent↔agent hops before a chain halts for a human            |
| `PEER_ROSTER`           | *(optional)*         | Inline roster JSON; overrides `workspace/roster.json`             |

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

## Running a Team (multi-agent collaboration)

Run several SecretAgent instances that know each other and collaborate. Each keeps its own
`soul.md` (identity, role). You invite all their bots into one Telegram group, where you watch
and steer; the agents talk to each other over a private peer channel.

**Why a peer channel?** Telegram bots cannot see each other's messages (platform rule). So
agent↔agent comms travel over HTTP (`POST /peer`, reusing the webhook server), while the
Telegram group is for human visibility and steering. Handoffs are mirrored into the group so
you can follow along.

```
        ┌──────── Telegram group (you watch + steer) ────────┐
        │   Alice posts ▲    Bob posts ▲    You ▲             │
        └───────▲─────────────────▲──────────────▲───────────┘
                │                  │              │
        ┌───────┴──────┐  /peer ┌──┴───────────┐ │ @mentions
        │  Instance A  │ (HTTP) │  Instance B   │◀┘ (group-gated)
        │  self: alice │◀──────▶│  self: bob    │
        └──────────────┘        └───────────────┘
```

### Step 1 — Create the bots

In Telegram, talk to [@BotFather](https://t.me/BotFather) and run `/newbot` once per agent
(e.g. `Alice`, `Bob`). Save each bot token. Then, so bots can read normal group messages,
send BotFather `/setprivacy` → pick each bot → **Disable**. (With privacy enabled a bot only
sees messages that @mention it or reply to it — mention-gating still works, but plain-name
addressing like "Alice, do X" won't reach the bot.)

### Step 2 — Create the group and get its ID

1. Create a Telegram group and add **all** the agent bots plus yourself.
2. Get the group's chat id: add [@RawDataBot](https://t.me/RawDataBot) to the group briefly
   and read `message.chat.id` (a negative number like `-1001234567890`), then remove it.
   Alternatively, message the group and open
   `https://api.telegram.org/bot<ANY_BOT_TOKEN>/getUpdates` and read `chat.id`.

### Step 3 — Lay out one instance per agent

Each agent is a separate process with its own token, port, data dir, and workspace. Two ways:

**Same machine (simplest for testing):** one clone, different env vars per process.

```bash
# Alice — terminal 1
TELEGRAM_BOT_TOKEN=<alice-token> PEER_SECRET=shared-secret \
WEBHOOK_PORT=3000 DATA_DIR=./dataA WORKSPACE_DIR=./wsA npm run dev

# Bob — terminal 2
TELEGRAM_BOT_TOKEN=<bob-token> PEER_SECRET=shared-secret \
WEBHOOK_PORT=3001 DATA_DIR=./dataB WORKSPACE_DIR=./wsB npm run dev
```

**Separate machines/VMs:** one deploy each, normal `.env` per host. Set each `peerUrl` to the
reachable address of that host (LAN/VPN/localhost — see Security).

### Step 4 — Write the shared roster

Copy `workspace/roster.example.json` to each instance's `WORKSPACE_DIR/roster.json`. The file
is **identical across instances except `self`**, which is that instance's own id.

```json
{
  "self": "alice",
  "groupChatId": "-1001234567890",
  "sharedSecret": "env:PEER_SECRET",
  "peers": [
    { "id": "alice", "name": "Alice", "role": "researcher", "peerUrl": "http://127.0.0.1:3000/peer" },
    { "id": "bob",   "name": "Bob",   "role": "writer",     "peerUrl": "http://127.0.0.1:3001/peer" }
  ]
}
```

- Plain JSON only — **no comments**; `peerUrl`s contain `//` and a comment-stripper would corrupt them.
- `sharedSecret: "env:PEER_SECRET"` reads the secret from the env var (keeps it out of the file).
- `peerUrl` is `http://<host>:<that instance's WEBHOOK_PORT>/peer`.
- Bob's copy is the same file with `"self": "bob"`.

### Step 5 — Give each agent a role in its soul

`soul.md` holds personality and behavior; the framework only supplies the *mechanism* to message
peers. Tell each agent how to collaborate. Example snippets:

```markdown
<!-- wsA/soul.md (Alice, the researcher) -->
You are Alice, the team's researcher. When asked to investigate something, gather the facts
with your tools, then hand the findings to Bob with `message_peer({ to: "bob", message, payload })`.
Don't write the final copy yourself — that's Bob's job.
```

```markdown
<!-- wsB/soul.md (Bob, the writer) -->
You are Bob, the team's writer. When Alice sends you research, draft the piece, post it to the
group, and message Alice back if you need anything. Replies from teammates arrive as new
messages — don't wait around for them.
```

### Step 6 — Run and try it

Start all instances. In the group, address an agent by @username, name, or id:

```
@AliceBot research the top 3 LLM eval frameworks and have Bob write a short summary.
```

You should see: Alice works, a mirrored `→ Bob: …` handoff line, Bob's draft posted to the
group, and any reply back to Alice — all visible to you, who can interrupt at any point.

### How it behaves

- **Opt-in.** No roster (or no peers) → classic single-agent behavior, unchanged.
- **Mention-gating.** In a group, an agent acts only when addressed — its @username, its name,
  or its id, or a reply to one of its own messages. (Private chats: unchanged.) Use
  `/command@BotName` to scope slash commands to one bot in a group.
- **`message_peer` tool.** Agents hand off with `message_peer({ to, message, payload? })`.
  Replies arrive later as a new inbound message — agents don't block waiting.
- **Sessions.** Each peer conversation runs in its own chain-scoped session, so unrelated
  hand-offs don't bleed into one another.
- **Loop safety.** A `hops` counter caps runaway chains at `MAX_HOPS` (default 8); on the cap,
  the chain halts and asks for a human.

### Verify the peer channel (without a group)

Confirm the wire works against a single running instance:

```bash
# Pretend Bob messaged Alice (Alice running on :3000 with PEER_SECRET=shared-secret)
curl -i -XPOST http://127.0.0.1:3000/peer \
  -H 'Authorization: Bearer shared-secret' -H 'Content-Type: application/json' \
  -d '{"from":"bob","to":"alice","message":"can you research X and send notes?"}'
# → HTTP 202 {"accepted":true,"msgId":"..."}; wrong/absent token → 401
```

### Security

- The peer channel is bearer-authenticated with `PEER_SECRET` (constant-time compared). Use a
  long random value and the **same** one on every instance.
- Keep `peerUrl`s on a private network (LAN/VPN/localhost). **Don't expose `/peer` to the open
  internet.**
- Content an agent fetched from outside (emails, web pages) and forwards in a peer message is
  still untrusted data. The framework never auto-executes payloads — agents decide — so write
  your souls to treat forwarded content with suspicion.

### Troubleshooting

- **Both bots reply to everything** → roster not loaded (mention-gating only activates with a
  roster). Check the startup log for `Team: I am …`; confirm `roster.json` is in the right
  `WORKSPACE_DIR` and is valid JSON.
- **Agent ignores "Alice, do X" but answers "@AliceBot do X"** → bot privacy mode is on; disable
  it via BotFather `/setprivacy` (Step 1).
- **`message_peer` says "unknown teammate"** → the `to` value must match a peer `id` or `name`
  in the roster.
- **Peer delivery fails / 401** → `PEER_SECRET` differs between instances, or `peerUrl`/port is
  wrong or unreachable. The sender mirrors the failure to the group.
- **"Hop limit reached"** → a chain hit `MAX_HOPS`; reply in the group to continue, or raise
  `MAX_HOPS`.
- **Startup error `Roster 'self' id "x" not found`** → `self` doesn't match any peer `id`.

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
