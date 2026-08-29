import type { WebClient } from '@slack/web-api';
import { slackifyMarkdown } from 'slackify-markdown';
import { postMessage, postMessageWithBlocks } from './messages.js';

/**
 * Result of parsing block markers out of an agent response.
 */
interface ParsedBlocks {
  /** Text with block JSON fences removed. May be empty. */
  text: string;
  /** Parsed Block Kit blocks, if any valid ones were found. */
  blocks: unknown[];
}

/**
 * Marker the agent uses to embed Slack Block Kit JSON in its response.
 *
 * The agent wraps Block Kit JSON in fenced code blocks tagged with
 * `slack_blocks`:
 *
 * ````
 * Here's a summary:
 *
 * ```slack_blocks
 * [
 *   {"type": "section", "text": {"type": "mrkdwn", "text": "*Job Status*"}},
 *   {"type": "divider"},
 *   {"type": "section", "fields": [
 *     {"type": "mrkdwn", "text": "*Job:*\nKitchen Remodel"},
 *     {"type": "mrkdwn", "text": "*Status:*\nIn Progress"}
 *   ]}
 * ]
 * ```
 * ````
 *
 * The parser extracts the JSON, validates it's an array of objects
 * with `type` fields, and returns the blocks separately from the
 * surrounding text. The text (with the fence removed) is used as the
 * fallback `text` field — Slack shows it if blocks fail to render.
 */
const BLOCK_FENCE = /```slack_blocks\n([\s\S]*?)```/g;

/**
 * Parse Slack Block Kit JSON out of an agent response.
 *
 * Extracts all ```slack_blocks fences, parses each as JSON, and
 * validates that the result is an array of objects with `type` fields.
 * Invalid JSON or malformed blocks are silently skipped — the text
 * passes through as plain text fallback.
 *
 * @returns The text with fences removed, and any valid blocks.
 */
export function parseSlackBlocks(text: string): ParsedBlocks {
  const blocks: unknown[] = [];
  let cleaned = text;

  // Reset regex state (global regexes are stateful).
  BLOCK_FENCE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = BLOCK_FENCE.exec(text)) !== null) {
    const jsonStr = match[1].trim();
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        blocks.push(...parsed.filter(isValidBlock));
      }
    } catch {
      // Invalid JSON — skip, leave the text as fallback.
    }
  }

  // Remove the block fences from the text.
  cleaned = text.replace(BLOCK_FENCE, '').trim();

  return { text: cleaned, blocks };
}

/**
 * Check if a value looks like a valid Slack Block Kit block.
 * Not exhaustive — just enough to reject obviously bad data.
 */
function isValidBlock(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.type === 'string' && obj.type.length > 0;
}

/**
 * Post an agent reply to Slack, using Block Kit blocks when present.
 *
 * If the reply contains ```slack_blocks fences, the blocks are
 * extracted and posted via `chat.postMessage` with `blocks`. The
 * surrounding text is sent as the `text` fallback (shown in
 * notifications and when blocks can't render).
 *
 * If no blocks are found, or if block posting fails, the reply is
 * sent as plain mrkdwn text — same as before.
 *
 * @returns true if blocks were posted, false if plain text was used.
 */
export async function postAgentReply(
  client: WebClient,
  channel: string,
  reply: string,
  threadTs?: string,
): Promise<boolean> {
  const { text, blocks } = parseSlackBlocks(reply);

  if (blocks.length > 0) {
    const fallbackText = text ? toMrkdwnSafe(text) : '';
    const result = await postMessageWithBlocks(
      client,
      channel,
      fallbackText,
      blocks,
      threadTs,
    );

    if (result.ok) {
      // If there's remaining text beyond the fallback, post it as a
      // follow-up so the agent's commentary isn't lost.
      if (text && text.length > 0) {
        // The fallback text already went with the blocks. Don't double-post.
      }
      return true;
    }

    // Block posting failed — fall back to plain text.
    console.warn(`[slack] block post failed (${result.error}), falling back to text`);
  }

  // Plain text path (no blocks, or block posting failed).
  const mrkdwn = toMrkdwnSafe(text || reply);
  if (mrkdwn) {
    await postMessage(client, channel, mrkdwn, threadTs);
  }
  return false;
}

function toMrkdwnSafe(text: string): string {
  try {
    return slackifyMarkdown(text);
  } catch {
    return text;
  }
}
