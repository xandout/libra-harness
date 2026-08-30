import { readFileSync, statSync, existsSync } from 'node:fs';
import { extname, basename } from 'node:path';
import type { Extension } from '../../../extension.js';

/**
 * Configuration for the code-tools extension.
 */
export interface CodeToolsConfig {
  /**
   * Tool name prefix. Default: no prefix (tools are named `read`, `write`, etc.).
   * Set to avoid collisions when multiple tool-providing extensions are used.
   */
  toolPrefix?: string;
  /**
   * Maximum file size for read operations (bytes). Default: 1MB.
   * Files larger than this return a metadata-only response.
   */
  maxReadSize?: number;
  /**
   * Maximum number of lines to return from a read operation. Default: 2000.
   * Lines beyond this are truncated with a notice.
   */
  maxReadLines?: number;
  /**
   * Maximum line length before truncation. Default: 2000 characters.
   */
  maxLineLength?: number;
}

// ── Read tracking ────────────────────────────────────────────────────
// The edit and write tools require that a file was read first in the
// current turn. We track read paths per turn via the metadata bag.
const READ_KEY = '__codeToolsReadPaths';

function getReadSet(metadata: Record<string, unknown>): Set<string> {
  let set = metadata[READ_KEY] as Set<string> | undefined;
  if (!set) {
    set = new Set();
    metadata[READ_KEY] = set;
  }
  return set;
}

// ── Text/binary detection ────────────────────────────────────────────
const TEXT_EXTENSIONS = new Set([
  '.txt', '.csv', '.json', '.xml', '.yaml', '.yml', '.md', '.markdown',
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.py', '.java', '.c',
  '.cpp', '.h', '.hpp', '.go', '.rs', '.rb', '.php', '.sql', '.html',
  '.htm', '.css', '.scss', '.less', '.sh', '.bash', '.zsh', '.ini',
  '.conf', '.log', '.env', '.toml', '.graphql', '.gql', '.svg', '.srt',
  '.vtt', '.properties', '.dockerfile', '.gitignore', '.editorconfig',
  '.lock', '.map', '.d.ts', '.d.ts.map',
]);

function isTextFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  // No extension — check if it's a known dotfile
  const name = basename(path).toLowerCase();
  if (['dockerfile', '.gitignore', '.editorconfig', '.env', '.npmrc'].includes(name)) return true;
  return false;
}

// ── Image detection ──────────────────────────────────────────────────
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function isImageFile(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * Create a code-tools extension that provides file reading, writing,
 * editing, searching, and shell execution tools for coding agents.
 *
 * Tools provided:
 * - `read` — read a file's contents (text, base64 for binary, visual for images)
 * - `write` — create or overwrite a file (must read existing files first)
 * - `edit` — replace a string in a file (unique match required)
 * - `find_file_by_name` — find files by glob pattern
 * - `grep` — search file contents (ripgrep)
 * - `exec` — run a shell command
 * - `get_output` — read output from a backgrounded shell
 * - `kill_shell` — kill a background shell
 * - `write_to_process` — write to an interactive shell's stdin
 * - `todo_write` — track multi-step tasks
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   model,
 *   systemPrompt: 'You are a coding agent.',
 * })
 * agent.use(createCodeToolsExtension())
 * ```
 */
export default function createCodeToolsExtension(
  config?: CodeToolsConfig,
): Extension {
  const prefix = config?.toolPrefix ?? '';
  const toolName = (name: string) => prefix ? `${prefix}_${name}` : name;
  const maxReadSize = config?.maxReadSize ?? 1_048_576; // 1MB
  const maxReadLines = config?.maxReadLines ?? 2000;
  const maxLineLength = config?.maxLineLength ?? 2000;

  return {
    name: 'code-tools',
    priority: 50,

    install(agent) {
      // ── read ──────────────────────────────────────────────────────
      agent.tool({
        name: toolName('read'),
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

          if (stat.size > maxReadSize) {
            return {
              toolCallId: '',
              content: `File is too large (${stat.size} bytes, max ${maxReadSize}). Use offset and limit to read a portion, or use exec with head/tail.`,
            };
          }

          // Track that this file was read — edit and write require it.
          getReadSet(ctx.metadata).add(filePath);

          const buf = readFileSync(filePath);

          // ── Image files: return as base64 data URL ────────────────
          if (isImageFile(filePath)) {
            const ext = extname(filePath).toLowerCase();
            const mimeMap: Record<string, string> = {
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.gif': 'image/gif',
              '.webp': 'image/webp',
              '.bmp': 'image/bmp',
            };
            const mime = mimeMap[ext] ?? 'application/octet-stream';
            const base64 = buf.toString('base64');
            return {
              toolCallId: '',
              content: `File: ${filePath} (${stat.size}b, ${mime})\ndata:${mime};base64,${base64}`,
            };
          }

          // ── Binary files: return as base64 ────────────────────────
          if (!isTextFile(filePath)) {
            const base64 = buf.toString('base64');
            return {
              toolCallId: '',
              content: `File: ${filePath} (${stat.size}b, binary)\nbase64: ${base64}`,
            };
          }

          // ── Text files: return with line numbers ──────────────────
          const text = buf.toString('utf-8');
          let lines = text.split('\n');

          // Apply offset (1-based)
          const offset = Math.max(1, Number(args.offset ?? 1));
          const startIdx = offset - 1;
          lines = lines.slice(startIdx);

          // Apply limit
          const limit = Math.min(Number(args.limit ?? maxReadLines), maxReadLines);
          const truncated = lines.length > limit;
          lines = lines.slice(0, limit);

          // Format with line numbers, truncating long lines
          const formatted = lines.map((line, i) => {
            const lineNum = startIdx + i + 1;
            const truncatedLine = line.length > maxLineLength
              ? line.slice(0, maxLineLength) + ' [...truncated]'
              : line;
            return `${String(lineNum).padStart(6)}\t${truncatedLine}`;
          }).join('\n');

          const header = `File: ${filePath} (${stat.size}b)`;
          const footer = truncated
            ? `\n\n[showing lines ${offset}-${offset + limit - 1} of ${text.split('\n').length} total]`
            : '';

          return {
            toolCallId: '',
            content: `${header}\n${formatted}${footer}`,
          };
        },
      });
    },
  };
}
