import { readFileSync, statSync, existsSync } from 'node:fs';
import { makeToolName, getReadSet, isTextFile, isImageFile, imageMime, type ToolFactory } from './shared.js';

export const readTool: ToolFactory = (cfg) => ({
  name: makeToolName(cfg.toolPrefix, 'read'),
  description:
    'Read a file from the local filesystem. Returns file contents with line numbers. ' +
    'Text files are returned as text; binary files as base64; images are returned as base64 data URLs. ' +
    'You MUST read a file before editing or overwriting it. ' +
    'Use absolute paths. For large files, use offset (1-based line number) and limit (line count) to read a portion.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to read.',
      },
      offset: {
        type: 'integer',
        description: 'The line number to start reading from (1-based). Default: 1.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of lines to read. Default: 2000.',
      },
    },
    required: ['file_path'],
  },
  async execute(args, ctx) {
    const filePath = String(args.file_path ?? '');
    if (!filePath) {
      return { toolCallId: '', content: 'Error: file_path is required' };
    }

    if (!existsSync(filePath)) {
      return { toolCallId: '', content: `File not found: ${filePath}` };
    }

    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      return {
        toolCallId: '',
        content: `Path is a directory, not a file: ${filePath}. Use find_file_by_name or exec with ls to list directory contents.`,
      };
    }

    if (stat.size > cfg.maxReadSize) {
      return {
        toolCallId: '',
        content: `File is too large (${stat.size} bytes, max ${cfg.maxReadSize}). Use offset and limit to read a portion, or use exec with head/tail.`,
      };
    }

    // Track that this file was read — edit and write require it.
    getReadSet(ctx.metadata).add(filePath);

    const buf = readFileSync(filePath);

    // ── Image files: return as base64 data URL ──────────────────────
    if (isImageFile(filePath)) {
      const mime = imageMime(filePath);
      const base64 = buf.toString('base64');
      return {
        toolCallId: '',
        content: `File: ${filePath} (${stat.size}b, ${mime})\ndata:${mime};base64,${base64}`,
      };
    }

    // ── Binary files: return as base64 ──────────────────────────────
    if (!isTextFile(filePath)) {
      const base64 = buf.toString('base64');
      return {
        toolCallId: '',
        content: `File: ${filePath} (${stat.size}b, binary)\nbase64: ${base64}`,
      };
    }

    // ── Text files: return with line numbers ────────────────────────
    const text = buf.toString('utf-8');
    const allLines = text.split('\n');

    // Apply offset (1-based)
    const offset = Math.max(1, Number(args.offset ?? 1));
    const startIdx = offset - 1;
    let lines = allLines.slice(startIdx);

    // Apply limit
    const limit = Math.min(Number(args.limit ?? cfg.maxReadLines), cfg.maxReadLines);
    const truncated = lines.length > limit;
    lines = lines.slice(0, limit);

    // Format with line numbers, truncating long lines
    const formatted = lines.map((line, i) => {
      const lineNum = startIdx + i + 1;
      const truncatedLine = line.length > cfg.maxLineLength
        ? line.slice(0, cfg.maxLineLength) + ' [...truncated]'
        : line;
      return `${String(lineNum).padStart(6)}\t${truncatedLine}`;
    }).join('\n');

    const header = `File: ${filePath} (${stat.size}b)`;
    const footer = truncated
      ? `\n\n[showing lines ${offset}-${offset + limit - 1} of ${allLines.length} total]`
      : '';

    return {
      toolCallId: '',
      content: `${header}\n${formatted}${footer}`,
    };
  },
});
