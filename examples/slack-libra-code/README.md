# Slack Socket Server for lc (libra-code)

A simple Slack Socket Mode bot that forwards incoming messages to `lc` (the libra code agent) and replies with the results, preserving conversation history via `lc`'s disk session.

## Features

- **Slack Socket Mode**: No public URL, webhook endpoints, or ngrok required.
- **`LC_SOURCE` Flexibility**: Point to a local directory or script, an npm package, or a GitHub tarball URL.
- **Disk Session Persistence**: `lc` maintains continuous multi-turn conversation memory on disk (`~/.libra/sessions/`).
- **Slack Reactions**: Shows `:thinking_face:` while `lc` is working, `:white_check_mark:` when completed, and `:x:` on error.
- **Threaded Execution**: Replies directly within threads in channels or DMs.
- **In-flight Turn Control**: Supports `/oc halt [reason]` to stop and `/oc steer <msg>` to redirect mid-turn.
- **Built-in Browser & Slack Tools**: Gives `lc` access to `screenshot`, `slack-upload`, `slack-screenshot`, `slack-post`, and `slack-read` directly in PATH.

## Slash Commands

Register `/oc` in your Slack App (Features → Slash Commands):
- `/oc <prompt>` — Execute a code agent turn directly
- `/oc steer <message>` — Steer / redirect an in-flight turn
- `/oc halt [reason]` — Stop an in-flight turn immediately
- `/oc status` — Show agent status, CWD, active turn, and configured model

## Built-in Tools Available to `lc`

When `lc` runs in the container, it has access to:
- `screenshot [output.png] [url]` — Take a full screenshot of the X11 virtual display (`:99`) or render a web URL via Chrome
- `slack-upload <file> [comment]` — Upload any image or file directly into the active Slack thread
- `slack-screenshot [url] [comment]` — Capture a screenshot and post it to Slack in one step
- `slack-post <message>` — Post an additional message or Block Kit JSON to the Slack thread
- `slack-read` — Read recent messages from the current channel or thread

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
