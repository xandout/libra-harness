# Slack bot example

A Slack bot powered by a libra agent. Uses Slack Socket Mode (no public URL needed).

## Setup

1. Create a Slack app at https://api.slack.com/apps with the following:
   - **Socket Mode** enabled (Settings → Socket Mode → Enable)
   - **Bot Token Scopes**: `chat:write`, `app_mentions:read`, `im:history`, `im:read`, `im:write`, `users:read`, `reactions:write`, `commands`, `files:read`, `files:write`
   - **Event Subscriptions** → Subscribe to bot events:
     - `app_mention`
     - `message.im`
   - **Slash Commands** → Create new command:
     - Command: `/halt`
     - Description: `Halt the currently running agent turn`
     - Usage hint: `[thread_ts]` (optional — halt a specific thread)

2. Install the app to your workspace. You'll get:
   - **Bot User OAuth Token** (`xoxb-...`) → `SLACK_BOT_TOKEN`
   - **App-Level Token** (`xapp-...`) → `SLACK_APP_TOKEN`

3. Copy `.env.example` to `.env` and fill in your tokens:

```bash
cp .env.example .env
```

4. Install dependencies and run:

```bash
pnpm install
pnpm start
```

5. DM the bot or @mention it in a channel.

## What it demonstrates

- **Slack Socket Mode** adapter receiving events and forwarding to a libra agent
- **Session extension** for per-conversation memory (DMs and threads are separate sessions)
- **Logger extension** for observability
- **Streaming** — text deltas are captured via the streaming extension
- **Reactions** — `thinking_face` while processing, `white_check_mark` when done, `x` on error
- **Steering** — if the user sends a follow-up while the agent is still thinking, it steers the running turn instead of queuing
- **Slack MCP** (optional) — connects to the Slack MCP server so the agent can search messages, read channels, look up users, send messages, and more

## Slack MCP (optional)

To give the agent access to Slack tools (search, read channels, send messages, etc.) via the [Slack MCP server](https://docs.slack.dev/ai/slack-mcp-server):

1. Copy `mcpServers.example.json` to `mcpServers.json`
2. Replace the `authToken` with your Slack user token (`xoxp-...`)
3. Make sure your Slack app has the required OAuth scopes (see [Slack MCP docs](https://docs.slack.dev/ai/slack-mcp-server#oauth-scopes))

The bot will connect to the Slack MCP server on startup and register all available tools. The agent can then use them to search Slack, read channel history, send messages, look up users, etc.
