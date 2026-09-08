#!/usr/bin/env bash
# task-wrapper.sh — wrapper for all agent shell tasks.
#
# Ensures:
# - The command's exit code is always captured to the exit file.
# - The lc callback fires on exit (steer if turn active, new turn if not).
# - Output is never lost (goes to the output file via fd redirection).
# - The callback is detached so it doesn't block.
#
# Args (env vars):
#   TASK_ID        — task identifier (e.g. task_1)
#   TASK_EXIT_FILE — path to write the exit code to
#   TASK_OUTPUT    — path to the output file (for the callback message)
#   TASK_INPUT_FIFO — path to input FIFO (optional; if set, stdin comes from here)
#   TASK_NOTIFY_FILE — callback is armed when this file exists
#   LC_BIN         — callback runtime executable (normally node)
#   LC_ENTRY       — exact lc entry script
#   LC_SESSION     — session key for lc --session
#   TASK_COMMAND   — the actual command to run

set -o pipefail

TASK_LOG="${TASK_OUTPUT}.lifecycle"
log_event() {
  line="[$(date -u '+%Y-%m-%dT%H:%M:%S.%3NZ')] [shell] task=$TASK_ID $*"
  printf '%s\n' "$line" >> "$TASK_LOG"
  if [ -w /proc/1/fd/1 ]; then
    printf '%s\n' "$line" > /proc/1/fd/1 2>/dev/null || true
  fi
}

log_event "wrapper-started pid=$$ session=$LC_SESSION output=$TASK_OUTPUT"

# ── stdin ──
if [ -n "$TASK_INPUT_FIFO" ] && [ -e "$TASK_INPUT_FIFO" ]; then
  exec 3<>"$TASK_INPUT_FIFO"
  STDIN_FD='&3'
else
  exec 3</dev/null
  STDIN_FD='&3'
fi

# ── run the command ──
# Re-parse the command with bash so quotes, substitutions, pipes, redirects,
# conditionals, and command separators retain normal shell semantics.
bash -c "$TASK_COMMAND" <&3
__code=$?

# ── capture exit code ──
echo "$__code" > "$TASK_EXIT_FILE" 2>/dev/null
log_event "command-exited code=$__code"

# ── fire callback (detached, output persisted separately) ──
if [ -e "$TASK_NOTIFY_FILE" ] && [ -n "$LC_BIN" ] && [ -n "$LC_SESSION" ]; then
  callback_output="${TASK_OUTPUT}.callback"
  log_event "callback-launching session=$LC_SESSION output=$callback_output"
  if [ -n "$LC_ENTRY" ]; then
    nohup "$LC_BIN" "$LC_ENTRY" --session "$LC_SESSION" \
      "FYI: Background task $TASK_ID finished (exit code $__code). Output file: $TASK_OUTPUT. This is a detached callback turn: your normal reply is archived but is not delivered to Slack. Inspect the output and continue the task as appropriate. If you decide the user should receive an update, send it with slack-post." \
      </dev/null >"$callback_output" 2>&1 &
  else
    nohup "$LC_BIN" --session "$LC_SESSION" \
      "FYI: Background task $TASK_ID finished (exit code $__code). Output file: $TASK_OUTPUT. This is a detached callback turn: your normal reply is archived but is not delivered to Slack. Inspect the output and continue the task as appropriate. If you decide the user should receive an update, send it with slack-post." \
      </dev/null >"$callback_output" 2>&1 &
  fi
  callback_pid=$!
  log_event "callback-started pid=$callback_pid"
  wait "$callback_pid"
  callback_code=$?
  log_event "callback-exited pid=$callback_pid code=$callback_code"
fi

exit $__code
