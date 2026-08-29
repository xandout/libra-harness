import type { Extension } from '../../../extension.js';

/**
 * Config for the emoji extension.
 *
 * Passed by the extension loader from the host's config object.
 * The key `emojiPrefix` should be declared in extension.json's `configKeys`.
 */
export interface EmojiExtensionConfig {
  /** Prefix to prepend to each response. Default: "✨ ". */
  emojiPrefix?: string;
}

/**
 * emoji extension — decorates the final response with a leading emoji.
 *
 * Demonstrates the simplest possible factory extension: a single
 * `beforeResponse` hook that mutates the outgoing message. Accepts an
 * optional `emojiPrefix` via config (default: `"✨ "`).
 */
export default function createEmojiExtension(
  config?: EmojiExtensionConfig,
): Extension {
  const prefix = config?.emojiPrefix ?? '\u2728 ';
  return {
    name: 'emoji',
    priority: 0,
    install(agent) {
      agent.hook('beforeResponse', 'emoji', async (ctx) => {
        if (ctx.turn.response?.message) {
          ctx.turn.response.message = `${prefix}${ctx.turn.response.message}`;
        }
      });
    },
  };
}
