import { readFileSync, existsSync } from 'node:fs';
import { diffLines } from 'diff';
import type { Extension } from '@xandout/libra-harness';
import type { SessionSocketServer } from './session-socket.js';

// ── Types ────────────────────────────────────────────────────────────
export interface FileChange {
  /** File path that was changed. */
  path: string;
  /** Tool that made the change: 'write' or 'edit'. */
  tool: string;
  /** Timestamp of the change. */
  timestamp: number;
  /** Original content (before the change). Empty string for new files. */
  before: string;
  /** New content (after the change). */
  after: string;
  /** Unified diff string. */
  diff: string;
  /** Whether this is a new file creation. */
  isNew: boolean;
}

/**
 * Create an extension that tracks file changes made by the write and
 * edit tools. The changes are stored in an array that the TUI can
 * read to render diffs.
 *
 * The extension hooks into afterTool and inspects tool results from
 * 'write' and 'edit' tools. It reads the file before and after to
 * generate a diff.
 *
 * IMPORTANT: This extension must be installed BEFORE the code-tools
 * extension so its afterTool hook runs after the file has been
 * written. Use a high priority.
 */
export function createFileChangeTracker(
  changes: FileChange[],
): Extension & { getChanges: () => FileChange[]; getLatestChange: () => FileChange | undefined } {
  // Track file contents before writes by hooking beforeTool.
  const beforeContents = new Map<string, string>();

  return {
    name: 'file-change-tracker',
    priority: 95, // Run before code-tools (priority 50) in beforeTool, after in afterTool

    install(agent) {
      // Capture file content before write/edit.
      agent.hook('beforeTool', 'file-change-tracker', async (ctx) => {
        const toolCall = ctx.toolCall;
        if (!toolCall) return;
        if (toolCall.name !== 'write' && toolCall.name !== 'edit') return;

        try {
          const args = JSON.parse(toolCall.arguments);
          const filePath = String(args.file_path ?? '');
          if (!filePath) return;

          if (existsSync(filePath)) {
            beforeContents.set(filePath, readFileSync(filePath, 'utf-8'));
          } else {
            beforeContents.set(filePath, '');
          }
        } catch {
          // ignore parse errors
        }
      });

      // After write/edit, capture the new content and generate a diff.
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

          const before = beforeContents.get(filePath) ?? '';
          const after = existsSync(filePath)
            ? readFileSync(filePath, 'utf-8')
            : '';
          const isNew = !before && after.length > 0;

          // Generate a line-level diff and filter to only show changed
          // lines with up to 3 lines of surrounding context.
          const parts = diffLines(before, after);
          const CONTEXT = 3;
          const outLines: string[] = [];

          // First pass: build all lines with their change type.
          const allParts: { prefix: string; lines: string[] }[] = [];
          for (const part of parts) {
            const prefix = part.added ? '+' : part.removed ? '-' : ' ';
            const partLines = part.value.split('\n');
            if (partLines.length > 0 && partLines[partLines.length - 1] === '') {
              partLines.pop();
            }
            allParts.push({ prefix, lines: partLines });
          }

          // Determine which unchanged blocks should be included (those
          // adjacent to added/removed blocks, within CONTEXT lines).
          const includeBlock = new Array(allParts.length).fill(false);
          for (let i = 0; i < allParts.length; i++) {
            if (allParts[i].prefix !== ' ') {
              // This is a changed block — include it and nearby context.
              includeBlock[i] = true;
              // Look backward for context.
              let ctx = CONTEXT;
              for (let j = i - 1; j >= 0 && ctx > 0; j--) {
                if (allParts[j].prefix === ' ') {
                  includeBlock[j] = true;
                  ctx--;
                } else {
                  break;
                }
              }
              // Look forward for context.
              ctx = CONTEXT;
              for (let j = i + 1; j < allParts.length && ctx > 0; j++) {
                if (allParts[j].prefix === ' ') {
                  includeBlock[j] = true;
                  ctx--;
                } else {
                  break;
                }
              }
            }
          }

          // Second pass: emit included lines with separators for gaps.
          let prevIncluded = false;
          for (let i = 0; i < allParts.length; i++) {
            if (includeBlock[i]) {
              if (prevIncluded === false && outLines.length > 0) {
                outLines.push('⋯');
              }
              for (const line of allParts[i].lines) {
                outLines.push(`${allParts[i].prefix}${line}`);
              }
              prevIncluded = true;
            } else {
              prevIncluded = false;
            }
          }

          const diffStr = outLines.join('\n');

          const change: FileChange = {
            path: filePath,
            tool: toolCall.name,
            timestamp: Date.now(),
            before,
            after,
            diff: diffStr,
            isNew,
          };
          changes.push(change);
          // Emit a file event to the socket server so all consumers (TUI,
          // stdout, Slack) know which files were touched.
          const socketServer = ctx.turn.metadata.__socketServer as SessionSocketServer | undefined;
          socketServer?.broadcast({ type: 'file', file: filePath, ts: Date.now() });
          beforeContents.delete(filePath);
        } catch {
          // ignore errors
        }
      });
    },

    getChanges() {
      return changes;
    },

    getLatestChange() {
      return changes.length > 0 ? changes[changes.length - 1] : undefined;
    },
  };
}
