#!/usr/bin/env bash
# post_slack_message.sh — Post a message to Slack as the bot.
#
# Usage: post_slack_message.sh <channel_id> [thread_ts] <text> [blocks_json]
#
# Args:
#   $1 — channel ID (e.g. C12345678 for a channel, D12345678 for a DM)
#   $2 — thread timestamp (optional — if it looks like a ts, replies in thread)
#   $3 — message text in mrkdwn (fallback text; use "" if sending blocks only)
#   $4 — blocks JSON string (optional — Slack Block Kit blocks array)
#
# Env:
#   SLACK_BOT_TOKEN — xoxb-... bot token (inherited from the bot process)
#
# The script posts via the Slack Web API (chat.postMessage). Either text or
# blocks (or both) must be provided. Prints the JSON response to stdout.
# On error, prints the error and exits 1.

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: post_slack_message.sh <channel_id> [thread_ts] <text> [blocks_json]" >&2
  echo "" >&2
  echo "  channel_id  — Slack channel or DM ID (required)" >&2
  echo "  thread_ts   — Thread timestamp (optional — omit for top-level)" >&2
  echo "  text        — Fallback text in mrkdwn (use \"\" for blocks-only)" >&2
  echo "  blocks_json — Slack Block Kit blocks as a JSON array string (optional)" >&2
  echo "" >&2
  echo "Examples:" >&2
  echo "  post_slack_message.sh C12345678 1234567890.123456 \"Hello world\"" >&2
  echo "  post_slack_message.sh C12345678 \"\" '[{\"type\":\"section\",\"text\":{\"type\":\"mrkdwn\",\"text\":\"*Bold*\"}}]'" >&2
  echo "  post_slack_message.sh C12345678 1234567890.123456 \"See table\" '[{\"type\":\"table\",\"rows\":[[{\"type\":\"raw_text\",\"text\":\"A\"},{\"type\":\"raw_text\",\"text\":\"B\"}]]}]'" >&2
  exit 1
fi

CHANNEL_ID="$1"
shift

# If the next arg looks like a timestamp (contains a dot), it's a thread_ts.
THREAD_TS=""
if [ $# -ge 2 ] && [[ "$1" == *.* ]]; then
  THREAD_TS="$1"
  shift
fi

TEXT="${1:-}"
shift || true

# Any remaining arg is blocks JSON.
BLOCKS_JSON=""
if [ $# -ge 1 ]; then
  BLOCKS_JSON="$1"
fi

if [ -z "$SLACK_BOT_TOKEN" ]; then
  echo "Error: SLACK_BOT_TOKEN env var is not set" >&2
  exit 1
fi

if [ -z "$TEXT" ] && [ -z "$BLOCKS_JSON" ]; then
  echo "Error: either text or blocks (or both) must be provided" >&2
  exit 1
fi

# Build the JSON payload with jq.
# Start with channel + optional thread_ts, then add text and/or blocks.
PAYLOAD=$(jq -n --arg channel "$CHANNEL_ID" '{channel: $channel}')

if [ -n "$THREAD_TS" ]; then
  PAYLOAD=$(echo "$PAYLOAD" | jq --arg ts "$THREAD_TS" '. + {thread_ts: $ts}')
fi

if [ -n "$TEXT" ]; then
  PAYLOAD=$(echo "$PAYLOAD" | jq --arg text "$TEXT" '. + {text: $text}')
fi

if [ -n "$BLOCKS_JSON" ]; then
  # Parse the blocks JSON string and inject it into the payload.
  if ! echo "$BLOCKS_JSON" | jq -e 'type == "array"' >/dev/null 2>&1; then
    echo "Error: blocks_json must be a JSON array" >&2
    exit 1
  fi
  PAYLOAD=$(echo "$PAYLOAD" | jq --argjson blocks "$BLOCKS_JSON" '. + {blocks: $blocks}')
fi

RESPONSE=$(curl -s -X POST "https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "$PAYLOAD")

# Check for API errors.
OK=$(echo "$RESPONSE" | jq -r '.ok // false')
if [ "$OK" != "true" ]; then
  ERROR=$(echo "$RESPONSE" | jq -r '.error // "unknown_error"')
  echo "Slack API error: $ERROR" >&2
  echo "$RESPONSE" >&2
  exit 1
fi

# Print the response (includes message_ts, channel, etc.)
echo "$RESPONSE"
