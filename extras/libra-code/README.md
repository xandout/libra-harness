# lc — libra code agent

A code agent CLI powered by [libra-harness](https://github.com/xandout/libra-harness).

## Install

```bash
npm install -g @xandout/libra-code
```

## Quick start

```bash
# Set your model (provider/model format)
lc config set model deepseek/deepseek-chat

# Run a one-shot prompt
lc "refactor the auth module to use async/await"

# Interactive TUI mode
lc --tui

# TUI with an initial prompt, exits when the agent finishes
lc -x "fix the failing tests in src/auth"
```

## Modes

| Mode | Command | Description |
|------|---------|-------------|
| Stdout | `lc <prompt>` | Runs the agent in-process, streams text to stdout |
| TUI | `lc --tui [prompt]` | Interactive terminal UI with tool activity, stats, and diffs |
| Exit-on-complete | `lc -x <prompt>` | TUI that exits when the turn finishes |
| Worker | `lc --worker ...` | Internal — spawned by the TUI and by host integrations |

All modes use the **journal** as the single source of truth. The agent writes events (text deltas, tool calls, file changes, stats, status) to a JSONL journal file. Every consumer — stdout, TUI, or an external host like [zocode](https://github.com/xandout/zocode) — reads from the same journal.

## Configuration

```bash
lc config set model <provider/model>    # e.g. deepseek/deepseek-chat
lc config set maxIterations 50           # max LLM iterations per turn
lc config set systemPrompt "..."         # override the default system prompt
lc config get model                      # read a value
lc config path                           # show config file location
lc config prompt                         # show the effective system prompt
lc providers                             # list configured providers
```

Config is stored at `$LIBRA_HOME/config.json` (default `~/.libra/config.json`).

### Environment variables

| Variable | Description |
|----------|-------------|
| `LIBRA_HOME` | State directory (default `~/.libra`) |
| `LIBRA_MODEL` or `MODEL` | Fallback model if not set via config |
| `OPENAI_API_KEY` | OpenAI provider key |
| `ANTHROPIC_API_KEY` | Anthropic provider key |
| `DEEPSEEK_API_KEY` | DeepSeek provider key |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google provider key |

## Project instructions

Place an `AGENTS.md` file in your project root. Its contents are appended to the system prompt, giving the agent project-specific context (conventions, tooling, code style).

```markdown
# AGENTS.md

## This project

- Uses pnpm, not npm
- Tests are in `test/` and run with `pnpm test`
- All code is TypeScript ESM
```

## State

All state lives under `$LIBRA_HOME`:

```
~/.libra/
  config.json          # Agent configuration
  sessions/            # Per-directory conversation history (JSONL)
  turns/               # Journal events for each turn (JSONL)
  turn-meta/           # Turn metadata (status, timing, reply)
  todos/               # Per-session todo lists
  shells/              # Persistent shell sessions
  locks/               # Session locks (prevents concurrent agents)
```

Set `LIBRA_HOME` to relocate state (useful for containers and sandboxed environments):

```bash
LIBRA_HOME=/workspace/.libra lc "fix the bug"
```

## Journal events

Each turn writes a JSONL journal at `turns/<turnId>.jsonl`. Events:

| Type | Fields | Description |
|------|--------|-------------|
| `status` | `message` | Status update ("Thinking…", "Writing reply…") |
| `text` | `delta` | Streamed text delta |
| `tool` | `name`, `phase`, `file?` | Tool call start/end |
| `file` | `file` | File was written or edited |
| `stats` | `stats` | Token/call counters |
| `steer` | `text` | User steered the agent mid-turn |
| `halt` | `reason` | Turn was halted |
| `done` | `reply`, `finishReason` | Turn finished |

External systems can replay and live-tail this journal to render agent output in any UI.

## Tools

The agent has built-in code tools:

- **read** — Read a file
- **write** — Write a file
- **edit** — Edit part of a file
- **shell** — Run shell commands (persistent sessions)
- **find_file_by_name** — Glob-based file search
- **grep** — Content search (ripgrep)
- **todo_write** — Track multi-step tasks

## License

MIT
