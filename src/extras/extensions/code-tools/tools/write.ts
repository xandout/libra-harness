import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Tool } from '../../../../tool.js';
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

    // Enforce read-before-overwrite for existing files.
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
    'Replace a string in a file with a new string. The old_string must be unique in the file ' +
    'unless replace_all is true. You MUST read the file before editing it. ' +
    'Use absolute paths. Preserve indentation exactly — match the file\'s actual content. ' +
    'The new_string must differ from old_string.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to edit.',
      },
      old_string: {
        type: 'string',
        description: 'The exact string to find in the file. Must be unique unless replace_all is true.',
      },
      new_string: {
        type: 'string',
        description: 'The string to replace old_string with. Must differ from old_string.',
      },
      replace_all: {
        type: 'boolean',
        description: 'If true, replace all occurrences of old_string. Default: false.',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  async execute(args, ctx) {
    const filePath = String(args.file_path ?? '');
    if (!filePath) {
      return { toolCallId: '', content: 'Error: file_path is required' };
    }

    const oldString = String(args.old_string ?? '');
    const newString = String(args.new_string ?? '');
    const replaceAll = args.replace_all === true;

    if (oldString === newString) {
      return {
        toolCallId: '',
        content: 'Error: new_string must differ from old_string.',
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

    // Enforce read-before-edit.
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

    // Count occurrences.
    let count = 0;
    let idx = 0;
    while ((idx = content.indexOf(oldString, idx)) !== -1) {
      count++;
      idx += oldString.length;
    }

    if (count === 0) {
      return {
        toolCallId: '',
        content: `Error: old_string not found in ${filePath}. Check for exact whitespace, indentation, and line endings.`,
        isError: true,
      };
    }

    if (count > 1 && !replaceAll) {
      return {
        toolCallId: '',
        content: `Error: old_string appears ${count} times in ${filePath}. Provide more surrounding context to make it unique, or set replace_all to true.`,
        isError: true,
      };
    }

    // Perform the replacement.
    let newContent: string;
    if (replaceAll) {
      newContent = content.split(oldString).join(newString);
    } else {
      newContent = content.replace(oldString, newString);
    }

    try {
      writeFileSync(filePath, newContent, 'utf-8');
      const replaced = replaceAll ? count : 1;
      return {
        toolCallId: '',
        content: `Replaced ${replaced} occurrence${replaced === 1 ? '' : 's'} in ${filePath}`,
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
