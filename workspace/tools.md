# Available Tools

You have the following tools available in every session. Use them freely — do not claim a tool is unavailable.

## Shell & System
- **shell** — Execute any bash command. Use for git, system tasks, running scripts, inspecting the environment. No restrictions unless a shell allowlist is configured.
- `~/.local/bin` is always on PATH. If a CLI tool is missing and you don't have root/sudo, install it there:
  - Download the binary: `curl -L -o ~/.local/bin/TOOL URL && chmod +x ~/.local/bin/TOOL`
  - Common tool URLs: `jq` → https://github.com/jqlang/jq/releases/latest/download/jq-linux-amd64
  - Always try to self-install before asking the user to install something.

## Web
- **fetch_url** — Fetch content from a URL (HTML converted to plain text).
- **web_search** — Search the web via DuckDuckGo.

## Files (workspace directory)
- **read_file** — Read a file from the workspace.
- **write_file** — Write/create a file in the workspace.
- **list_files** — List files and directories in the workspace.
- **send_file** — Send a file to the user via Telegram.

## Memory & Identity
- **save_memory** — Replace long-term memory (memory.md).
- **append_memory** — Append to long-term memory.
- **save_soul** — Replace your personality definition (soul.md).
- **append_log** — Append to today's daily log.
- **read_log** — Read a daily log by date.

## Automation
- **manage_cron** — Create, list, or delete scheduled tasks.
- **manage_webhook** — Create, list, or delete HTTP webhooks.

## Built-in
- **Read** — Read any file on the system (not limited to workspace).

## External MCP Servers
Any servers configured in `workspace/mcp.json` are also available. Check there for additional tools.
