import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeToolName, getReadSet, type ToolFactory } from './shared.js';

// ── write ────────────────────────────────────────────────────────────
export const writeTool: ToolFactory = (cfg) => ({
  name: makeToolName(cfg.toolPrefix, 'write'),
  description:
    'Write content to a file, creating it if it does not exist or overwriting it if it does. ' +
    'You MUST read an existing file before overwriting it — this is enforced. ' +
    'Use absolute paths. Creates parent directories as needed. ' +
    'The content parameter is the complete file contents (not a patch).',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to write.',
      },
      content: {
        type: 'string',
        description: 'The complete content to write to the file.',
      },
    },
    required: ['file_path', 'content'],
  },
  async execute(args, ctx) {
    const filePath = String(args.file_path ?? '');
    if (!filePath) {
      return { toolCallId: '', content: 'Error: file_path is required' };
    }

    const content = String(args.content ?? '');

    if (existsSync(filePath)) {
      const readSet = getReadSet(ctx.metadata);
      if (!readSet.has(filePath)) {
        return {
          toolCallId: '',
          content: `Error: You must read "${filePath}" before overwriting it. Use the read tool first.`,
          isError: true,
        };
      }
    }

    try {
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(filePath, content, 'utf-8');
      return {
        toolCallId: '',
        content: `Wrote ${content.length} chars to ${filePath}`,
      };
    } catch (err) {
      return {
        toolCallId: '',
        content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

// ── edit ─────────────────────────────────────────────────────────────
export const editTool: ToolFactory = (cfg) => ({
  name: makeToolName(cfg.toolPrefix, 'edit'),
  description:
    'Replace a chunk of a file. Use this ONLY when replacing a contiguous block of text. ' +
    'You MUST read the file before editing it. ' +
    'Provide the exact existing lines to replace as targetContent, and the replacement as replacementContent. ' +
    'Specify startLine and endLine to narrow the search scope.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to edit.',
      },
      startLine: {
        type: 'integer',
        description: 'Starting line number of the block to replace (1-indexed).',
      },
      endLine: {
        type: 'integer',
        description: 'Ending line number of the block to replace (1-indexed).',
      },
      targetContent: {
        type: 'string',
        description: 'The exact string to find in the file. Must be unique within the line range.',
      },
      replacementContent: {
        type: 'string',
        description: 'The string to replace targetContent with.',
      },
    },
    required: ['file_path', 'startLine', 'endLine', 'targetContent', 'replacementContent'],
  },
  async execute(args, ctx) {
    const filePath = String(args.file_path ?? '');
    if (!filePath) {
      return { toolCallId: '', content: 'Error: file_path is required' };
    }

    const startLine = Number(args.startLine);
    const endLine = Number(args.endLine);
    const targetContent = String(args.targetContent ?? '');
    const replacementContent = String(args.replacementContent ?? '');

    if (isNaN(startLine) || isNaN(endLine) || startLine < 1 || endLine < startLine) {
      return {
        toolCallId: '',
        content: `Error: Invalid line range (${args.startLine}, ${args.endLine}). startLine must be >= 1 and <= endLine.`,
        isError: true,
      };
    }

    if (targetContent === replacementContent) {
      return {
        toolCallId: '',
        content: 'Error: targetContent and replacementContent are identical',
        isError: true,
      };
    }

    if (!existsSync(filePath)) {
      return {
        toolCallId: '',
        content: `File not found: ${filePath}`,
        isError: true,
      };
    }

    const readSet = getReadSet(ctx.metadata);
    if (!readSet.has(filePath)) {
      return {
        toolCallId: '',
        content: `Error: You must read "${filePath}" before editing it. Use the read tool first.`,
        isError: true,
      };
    }

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err) {
      return {
        toolCallId: '',
        content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    const lines = content.split('\n');
    const startIdx = Math.max(0, startLine - 1);
    const endIdx = Math.min(lines.length, endLine);
    const rangeContent = lines.slice(startIdx, endIdx).join('\n');

    let count = 0;
    let idx = 0;
    while ((idx = rangeContent.indexOf(targetContent, idx)) !== -1) {
      count++;
      idx += targetContent.length;
    }

    if (count === 0) {
      return {
        toolCallId: '',
        content: `Error: targetContent not found in ${filePath} between lines ${startLine} and ${endLine}. Check for exact whitespace and indentation.`,
        isError: true,
      };
    }

    if (count > 1) {
      return {
        toolCallId: '',
        content: `Error: targetContent appears ${count} times in the specified range. Provide a more specific targetContent or a narrower line range.`,
        isError: true,
      };
    }

    const newRangeContent = rangeContent.replace(targetContent, replacementContent);
    const newLines = [
      ...lines.slice(0, startIdx),
      newRangeContent,
      ...lines.slice(endIdx)
    ];

    try {
      writeFileSync(filePath, newLines.join('\n'), 'utf-8');
      return {
        toolCallId: '',
        content: `Successfully edited ${filePath} (lines ${startLine}-${endLine}).`,
      };
    } catch (err) {
      return {
        toolCallId: '',
        content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});
