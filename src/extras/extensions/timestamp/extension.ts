import type { Extension } from '../../../extension.js';

/**
 * timestamp extension — records start/finish ISO timestamps in turn
 * metadata for observability.
 *
 * Sets `metadata.startedAt` in `beforeTurn` and `metadata.finishedAt`
 * in `afterTurn`. No config needed — self-contained.
 */
const timestampExtension: Extension = {
  name: 'timestamp',
  priority: 0,
  install(agent) {
    agent.hook('beforeTurn', 'timestamp', async (ctx) => {
      ctx.turn.metadata.startedAt = new Date().toISOString();
    });
    agent.hook('afterTurn', 'timestamp', async (ctx) => {
      ctx.turn.metadata.finishedAt = new Date().toISOString();
    });
  },
};

export default timestampExtension;
