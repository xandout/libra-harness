#!/usr/bin/env bash
# task-wrapper.sh — wrapper for all backgrounded agent shell tasks.
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
#   LC_BIN         — lc binary path (e.g. "lc")
#   LC_SESSION     — session key for lc --session
#   TASK_COMMAND   — the actual command to run

set -o pipefail

# ── stdin ──
if [ -n "$TASK_INPUT_FIFO" ] && [ -e "$TASK_INPUT_FIFO" ]; then
  exec 3<>"$TASK_INPUT_FIFO"
  STDIN_FD='&3'
else
  exec 3</dev/null
  STDIN_FD='&3'
fi

# ── run the command ──
# Wrap in parentheses so internal pipes don't inherit the fd redirect.
( $TASK_COMMAND ) <&3
__code=$?

# ── capture exit code ──
echo "$__code" > "$TASK_EXIT_FILE" 2>/dev/null

# ── fire callback (detached, output silenced) ──
if [ -n "$LC_BIN" ] && [ -n "$LC_SESSION" ]; then
  $LC_BIN --session "$LC_SESSION" \
    "Background task $TASK_ID finished (exit code $__code). Output file: $TASK_OUTPUT" \
    >/dev/null 2>&1 &
fi

exit $__code
