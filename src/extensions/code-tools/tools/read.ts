import { readFileSync, statSync, existsSync } from 'node:fs';
import { makeToolName, getReadSet, isTextFile, isImageFile, imageMime, type ToolFactory } from './shared.js';

export const readTool: ToolFactory = (cfg) => ({
  name: makeToolName(cfg.toolPrefix, 'read'),
  description:
    'Read a file from the local filesystem. Returns file contents with line numbers. ' +
    'Text files are returned as text; binary files as base64; images are returned as base64 data URLs. ' +
    'You MUST read a file before editing or overwriting it. ' +
    'Use absolute paths. For large files, specify startLine and endLine to view a portion.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to read.',
      },
      startLine: {
        type: 'integer',
        description: 'The line number to start reading from (1-based, inclusive).',
      },
      endLine: {
        type: 'integer',
        description: 'The line number to stop reading at (1-based, inclusive).',
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
        content: `Path is a directory, not a file: ${filePath}.`,
      };
    }

    // Track that this file was read — edit and write require it.
    getReadSet(ctx.metadata).add(filePath);

    const buf = readFileSync(filePath);

    if (isImageFile(filePath)) {
      const mime = imageMime(filePath);
      const base64 = buf.toString('base64');
      return {
        toolCallId: '',
        content: `File: ${filePath} (${stat.size}b, ${mime})\ndata:${mime};base64,${base64}`,
      };
    }

    if (!isTextFile(filePath)) {
      const base64 = buf.toString('base64');
      return {
        toolCallId: '',
        content: `File: ${filePath} (${stat.size}b, binary)\nbase64: ${base64}`,
      };
    }

    const text = buf.toString('utf-8');
    const allLines = text.split('\n');

    const start = args.startLine !== undefined ? Math.max(1, Number(args.startLine)) : 1;
    let end = args.endLine !== undefined ? Number(args.endLine) : start + cfg.maxReadLines - 1;
    
    // Enforce max read size
    if (end - start + 1 > cfg.maxReadLines) {
      end = start + cfg.maxReadLines - 1;
    }

    const startIdx = start - 1;
    const endIdx = end; // slice is exclusive

    const lines = allLines.slice(startIdx, endIdx);
    const truncated = allLines.length > endIdx;

    const formatted = lines.map((line, i) => {
      const lineNum = startIdx + i + 1;
      const truncatedLine = line.length > cfg.maxLineLength
        ? line.slice(0, cfg.maxLineLength) + ' [...truncated]'
        : line;
      return `${String(lineNum).padStart(6)}\t${truncatedLine}`;
    }).join('\n');

    const header = `File: ${filePath} (${stat.size}b)`;
    const footer = truncated
      ? `\n\n[showing lines ${start}-${end} of ${allLines.length} total]`
      : '';

    return {
      toolCallId: '',
      content: `${header}\n${formatted}${footer}`,
    };
  },
});
