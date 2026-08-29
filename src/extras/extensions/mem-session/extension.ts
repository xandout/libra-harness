import type { Extension } from '../../../extension.js';
import type { Message } from '../../../types.js';

/**
 * A simple in-memory session extension.
 *
 * Stores conversation history per session ID in a Map. On each turn:
 * - `beforeTurn`: loads prior messages and prepends them to the turn context
 * - `afterTurn`: saves the full conversation (including this turn) back
 *
 * Low priority so it loads after mutators (emoji, timestamp) — this means
 * `afterTurn` saves the final decorated response, and `beforeTurn` prepends
 * history after other extensions have processed the raw input.
 *
 * The returned extension has extra methods (`getMessages`, `clear`,
 * `clearAll`) on the object for host-side inspection. These are not part
 * of the `Extension` interface — the host can access them by finding the
 * extension in the loaded array and casting.
 */
export default function createMemSessionExtension(): Extension & {
  getMessages(sessionId?: string): Message[];
  clear(sessionId?: string): void;
  clearAll(): void;
} {
  const store = new Map<string, Message[]>();

  return {
    name: 'mem-session',
    priority: -100,
    install(agent) {
      agent.hook('beforeTurn', 'mem-session', async (ctx) => {
        const sessionId = (ctx.turn.request.metadata?.sessionId as string) ?? 'default';
        const history = store.get(sessionId);
        if (history && history.length > 0) {
          ctx.turn.messages = [...history, ...ctx.turn.messages];
        }
      });

      agent.hook('afterTurn', 'mem-session', async (ctx) => {
        const sessionId = (ctx.turn.request.metadata?.sessionId as string) ?? 'default';
        store.set(sessionId, [...ctx.turn.messages]);
      });
    },
    /** Get the messages for a session. */
    getMessages(sessionId: string = 'default'): Message[] {
      return store.get(sessionId) ?? [];
    },
    /** Clear a single session. */
    clear(sessionId: string = 'default') {
      store.delete(sessionId);
    },
    /** Clear all sessions. */
    clearAll() {
      store.clear();
    },
  };
}
