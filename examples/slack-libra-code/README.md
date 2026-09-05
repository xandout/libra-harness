# Slack Socket Server for lc (libra-code)

A simple Slack Socket Mode bot that forwards incoming messages to `lc` (the libra code agent) and replies with the results, preserving conversation history via `lc`'s disk session.

## Features

- **Slack Socket Mode**: No public URL, webhook endpoints, or ngrok required.
- **`LC_SOURCE` Flexibility**: Point to a local directory or script, an npm package, or a GitHub tarball URL.
- **Disk Session Persistence**: `lc` maintains continuous multi-turn conversation memory on disk (`~/.libra/sessions/`).
- **Slack Reactions**: Shows `:thinking_face:` while `lc` is working, `:white_check_mark:` when completed, and `:x:` on error.
- **Threaded Execution**: Replies directly within threads in channels or DMs.
- **In-flight Turn Control**: Supports `/halt` slash command to stop running turns.

## Setup

1. Create a Slack App at https://api.slack.com/apps:
   - **Socket Mode**: Enable Socket Mode (Settings → Socket Mode).
   - **Bot Token Scopes** (OAuth & Permissions):
     - `chat:write`
     - `app_mentions:read`
     - `im:history`
     - `im:read`
     - `im:write`
     - `reactions:write`
     - `commands`
   - **Event Subscriptions**:
     - `app_mention`
     - `message.im`
     - `message.channels` (optional, for channel monitoring)
   - **Slash Commands** (optional):
     - `/halt` — Halt currently running `lc` execution

2. Install the app to your workspace to generate:
   - **Bot User OAuth Token** (`xoxb-...`) → `SLACK_BOT_TOKEN`
   - **App-Level Token** (`xapp-...` with `connections:write`) → `SLACK_APP_TOKEN`

3. Configure your environment:
   ```bash
   cp .env.example .env
   ```
   Add your `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and LLM API key (e.g. `DEEPSEEK_API_KEY`).

4. Configure `LC_SOURCE`:
   - **Local workspace repo** (default):
     ```env
     LC_SOURCE=../../extras/libra-code
     ```
   - **Global or published npm package**:
     ```env
     LC_SOURCE=@xandout/libra-code
     ```
   - **GitHub tarball / URL**:
     ```env
     LC_SOURCE=https://github.com/xandout/libra-harness/archive/refs/heads/main.tar.gz
     ```

5. Install dependencies and start the server:
   ```bash
   pnpm install
   pnpm start
   ```

6. DM the bot or @mention it in a channel!
