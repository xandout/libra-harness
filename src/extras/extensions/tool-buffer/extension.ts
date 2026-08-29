import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Extension } from '../../../extension.js';
import type { Tool } from '../../../tool.js';
import type { ToolResult } from '../../../types.js';

/**
 * Config for the tool-buffer extension.
 */
export interface ToolBufferConfig {
  /**
   * Directory to store buffered tool outputs. Created if it doesn't exist.
   * Default: `./tool-buffers`.
   */
  bufferDir?: string;
  /**
   * Minimum content length (characters) to trigger buffering. Tool
   * results shorter than this are passed through unchanged. Default:
   * `2000`.
   */
  threshold?: number;
  /**
   * Tool names to buffer (whitelist). If set, only these tools are
   * buffered. If omitted, all tools are eligible. Default: all tools.
   */
  tools?: string[];
  /**
   * Tool names to exclude from buffering (blacklist). Takes precedence
   * over `tools`. Default: none.
   */
  excludeTools?: string[];
  /**
   * Whether to preserve the first N characters of the original content
   * in the pointer message, giving the LLM a preview without needing
   * to grep. Default: `200`.
   */
  previewLength?: number;
  /**
   * Prefix for buffer file names. A random ID is appended. Default:
   * `buffer_`.
   */
  filePrefix?: string;
  /**
   * Name of the no-buffer control tool exposed to the LLM. Default:
   * `no_buffer`.
   */
  noBufferToolName?: string;
}

// ── Turn-level flag keys (stored in turn.metadata) ──────────────────
// These are internal to the extension and not part of the public API.
const FLAG_NEXT = '_toolBuffer_skipNext';
const FLAG_TURN = '_toolBuffer_skipTurn';

/**
 * Tool-buffer extension — redirects large tool outputs to files.
 *
 * Hooks `afterTool` and checks the result content size. If it exceeds
 * the configured threshold, the content is written to a file in
 * `bufferDir` and the tool result is replaced with a pointer message:
 *
 * ```
 * [tool-buffer] Output saved to tool-buffers/buffer_a1b2c3.txt
 * (234 lines, 12.5 KB). Use grep to search within this file.
 *
 * Preview (first 200 chars):
 * {"jobs":[{"id":"JT-001","name":"Kitchen remodel"},…
 * ```
 *
 * This keeps the LLM context small when tools return large datasets
 * (e.g. list_jobs, list_messages, search results) while preserving
 * full access to the data via a grep tool or filesystem reads.
 *
 * By default, all tools are buffered. Use `excludeTools` to exempt
 * tools whose output the LLM always needs inline (e.g. read_file,
 * send_message, status checks). The LLM can also call `no_buffer`
 * at runtime to bypass buffering on demand.
 *
 * ## LLM-controlled bypass
 *
 * The extension registers a `no_buffer` tool that the LLM can call to
 * disable buffering on demand — either for the next tool call only or
 * for the rest of the turn. This gives the LLM real-time control without
 * any tool knowing about buffering.
 *
 * - `no_buffer({ scope: "next" })` — skip buffering for the next tool
 *   call only. The flag is cleared after one tool executes.
 * - `no_buffer({ scope: "turn" })` — skip buffering for all remaining
 *   tool calls in this turn.
 *
 * The LLM typically calls `no_buffer` before a tool whose full output
 * it needs inline (e.g. reading a file it intends to summarize).
 *
 * ## Priority
 *
 * Uses priority -50 (runs after most extensions) so it sees the final
 * tool result after other extensions have potentially modified it.
 */
export default function createToolBufferExtension(
  config?: ToolBufferConfig,
): Extension {
  const bufferDir = config?.bufferDir ?? './tool-buffers';
  const threshold = config?.threshold ?? 2000;
  const whitelist = config?.tools ? new Set(config.tools) : undefined;
  const blacklist = config?.excludeTools ? new Set(config.excludeTools) : undefined;
  const previewLength = config?.previewLength ?? 200;
  const filePrefix = config?.filePrefix ?? 'buffer_';
  const noBufferToolName = config?.noBufferToolName ?? 'no_buffer';

  // Ensure buffer directory exists at setup time.
  if (!existsSync(bufferDir)) {
    mkdirSync(bufferDir, { recursive: true });
  }

  function shouldBuffer(toolName: string): boolean {
    if (blacklist?.has(toolName)) return false;
    if (whitelist && !whitelist.has(toolName)) return false;
    return true;
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ── no_buffer tool ────────────────────────────────────────────────
  const noBufferTool: Tool = {
    name: noBufferToolName,
    description:
      'Disable tool output buffering. Call this before a tool whose full output you need inline ' +
      '(e.g. reading a file you intend to summarize or quote). ' +
      'scope "next" skips buffering for the next tool call only. ' +
      'scope "turn" skips buffering for all remaining tool calls this turn.',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['next', 'turn'],
          description: '"next" = skip buffering for the next tool call only (default). "turn" = skip for all remaining tool calls this turn.',
          default: 'next',
        },
      },
    },
    async execute(args, ctx) {
      const scope = (args.scope as string) ?? 'next';
      if (scope === 'turn') {
        ctx.metadata[FLAG_TURN] = true;
      } else {
        ctx.metadata[FLAG_NEXT] = true;
      }
      return {
        toolCallId: '',
        content: `Buffering disabled for ${scope === 'turn' ? 'the rest of this turn' : 'the next tool call'}.`,
      };
    },
  };

  return {
    name: 'tool-buffer',
    priority: -50,
    install(agent) {
      // Register the no_buffer tool so the LLM can call it.
      agent.tool(noBufferTool);

      agent.hook('afterTool', 'tool-buffer', async (ctx) => {
        if (!ctx.toolCall || !ctx.toolResult) return;

        // The no_buffer tool itself is never buffered.
        if (ctx.toolCall.name === noBufferToolName) return;

        const toolName = ctx.toolCall.name;
        const result = ctx.toolResult;
        const meta = ctx.turn.metadata;

        // Check bypass flags set by the no_buffer tool.
        const skipTurn = meta[FLAG_TURN] === true;
        const skipNext = meta[FLAG_NEXT] === true;

        if (skipTurn || skipNext) {
          // Clear the one-shot flag (turn flag persists).
          if (skipNext) delete meta[FLAG_NEXT];
          return;
        }

        // Don't buffer error results — the LLM needs to see those inline.
        if (result.isError) return;

        // Don't buffer empty or short results.
        const content = result.content;
        if (!content || content.length < threshold) return;

        // Check whitelist/blacklist.
        if (!shouldBuffer(toolName)) return;

        // Generate a unique filename.
        const id = randomBytes(4).toString('hex');
        const fileName = `${filePrefix}${id}.txt`;
        const filePath = join(bufferDir, fileName);

        // Write the full content to the buffer file.
        try {
          writeFileSync(filePath, content, 'utf-8');
        } catch (err) {
          // If we can't write, pass the result through unchanged.
          // Don't break the tool call over a buffering failure.
          return;
        }

        // Build the pointer message.
        const lineCount = content.split('\n').length;
        const sizeBytes = Buffer.byteLength(content, 'utf-8');
        const preview = content.slice(0, previewLength);
        const previewTruncated = content.length > previewLength ? '…' : '';

        const pointer = [
          `[tool-buffer] Output saved to ${filePath}`,
          `(${lineCount} lines, ${formatSize(sizeBytes)}). Use grep to search within this file.`,
          '',
          `If you need the full output inline, call no_buffer({ scope: "next" }) and re-run this tool.`,
          '',
          `Preview (first ${previewLength} chars):`,
          preview + previewTruncated,
        ].join('\n');

        // Replace the tool result with the pointer.
        const bufferedResult: ToolResult = {
          toolCallId: result.toolCallId,
          content: pointer,
          isError: false,
        };

        return { skip: true, value: bufferedResult };
      });
    },
  };
}
