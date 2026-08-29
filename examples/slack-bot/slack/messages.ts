import type { WebClient } from '@slack/web-api';

const SLACK_TEXT_LIMIT = 4_000;

/**
 * Shared Slack message helpers. Used by both the bot's reply logic
 * and the slack extension's `slack_send_message` tool.
 */

export function chunkText(text: string, limit = SLACK_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut <= limit * 0.3) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}

export async function postMessage(
  client: WebClient,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  for (const chunk of chunkText(text)) {
    await client.chat.postMessage({
      channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: chunk,
    });
  }
}

export async function postMessageWithBlocks(
  client: WebClient,
  channel: string,
  text: string,
  blocks?: unknown[],
  threadTs?: string,
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  try {
    // `chat.postMessage` accepts a union (text-only | blocks-only | …).
    // The conditional spreads produce `text?`/`blocks?` that don't narrow
    // to a single union member, so cast at the call boundary. At runtime
    // either `text` or `blocks` is always present.
    const args = {
      channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(text ? { text } : {}),
      ...(blocks ? { blocks: blocks as never } : {}),
    } as Parameters<typeof client.chat.postMessage>[0];
    const result = await client.chat.postMessage(args);
    return { ok: true, ts: result.ts };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
