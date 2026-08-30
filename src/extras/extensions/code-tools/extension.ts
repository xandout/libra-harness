import type { Extension } from '../../../extension.js';
import type { ToolFactory, ResolvedConfig } from './tools/shared.js';
import { readTool } from './tools/read.js';
import { writeTool, editTool } from './tools/write.js';

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

/**
 * Create a code-tools extension that provides file reading, writing,
 * editing, searching, and shell execution tools for coding agents.
 *
 * Tools provided:
 * - `read` — read a file's contents (text, base64 for binary, data URL for images)
 * - `write` — create or overwrite a file (must read existing files first)
 * - `edit` — replace a string in a file (unique match required, or replace_all)
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
  const resolved: ResolvedConfig = {
    toolPrefix: config?.toolPrefix ?? '',
    maxReadSize: config?.maxReadSize ?? 1_048_576, // 1MB
    maxReadLines: config?.maxReadLines ?? 2000,
    maxLineLength: config?.maxLineLength ?? 2000,
  };

  // All tool factories, grouped by category.
  const toolFactories: ToolFactory[] = [
    readTool,
    writeTool,
    editTool,
  ];

  return {
    name: 'code-tools',
    priority: 50,

    install(agent) {
      for (const factory of toolFactories) {
        agent.tool(factory(resolved));
      }
    },
  };
}
