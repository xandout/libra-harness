import type { Extension } from '@xandout/libra-harness';
import type { SessionSocketServer } from './session-socket.js';

/**
 * Create an extension that tracks file changes made by the write and
 * edit tools.
 *
 * It simply emits a file event to the socket server so consumers (like stdout)
 * know which files were touched.
 */
export function createFileChangeTracker(): Extension {
  return {
    name: 'file-change-tracker',
    priority: 95,

    install(agent) {
      // After write/edit, emit a socket event.
      agent.hook('afterTool', 'file-change-tracker', async (ctx) => {
        const toolCall = ctx.toolCall;
        const toolResult = ctx.toolResult;
        if (!toolCall || !toolResult) return;
        if (toolCall.name !== 'write' && toolCall.name !== 'edit') return;
        if (toolResult.isError) return;

        try {
          const args = JSON.parse(toolCall.arguments);
          const filePath = String(args.file_path ?? '');
          if (!filePath) return;

          // Emit a file event to the socket server so all consumers (stdout, Slack)
          // know which files were touched.
          const socketServer = ctx.turn.metadata.__socketServer as SessionSocketServer | undefined;
          socketServer?.broadcast({ type: 'file', file: filePath, ts: Date.now() });
        } catch {
          // ignore errors
        }
      });
    },
  };
}
