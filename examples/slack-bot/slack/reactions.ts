import type { WebClient } from '@slack/web-api';

/**
 * Shared Slack reaction helpers. Used by both the bot's message handler
 * and the slack extension's `slack_add_reaction` tool.
 *
 * All helpers swallow errors (reactions are cosmetic — a failure shouldn't
 * crash a turn).
 */

export async function addReaction(
  client: WebClient,
  channel: string,
  timestamp: string,
  name: string,
): Promise<void> {
  await client.reactions.add({ channel, timestamp, name }).catch(() => {});
}

export async function removeReaction(
  client: WebClient,
  channel: string,
  timestamp: string,
  name: string,
): Promise<void> {
  await client.reactions.remove({ channel, timestamp, name }).catch(() => {});
}

/** Remove `from` reaction, then add `to` reaction. */
export async function swapReaction(
  client: WebClient,
  channel: string,
  timestamp: string,
  from: string,
  to: string,
): Promise<void> {
  await removeReaction(client, channel, timestamp, from);
  await addReaction(client, channel, timestamp, to);
}
