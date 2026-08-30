import type { Extension } from '../../../extension.js';
import type { Model } from '../../../model.js';
import type { ToolFactory, ResolvedConfig } from './tools/shared.js';
import { readTool } from './tools/read.js';
import { writeTool, editTool } from './tools/write.js';
import { findFileByNameTool } from './tools/find.js';
import { grepTool } from './tools/grep.js';
import { codeSearchTool } from './tools/code-search.js';
import { ShellRegistry, execTool, getOutputTool, killShellTool, writeToProcessTool } from './tools/shell.js';
import type { ShellToolFactory } from './tools/shell.js';
import { TodoStore, todoWriteTool } from './tools/todo.js';

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
  /**
   * Directory for persisting backgrounded shell metadata and output.
   * Detached shells survive process exit and can be reconnected from
   * this directory by a future agent instance.
   * Default: ./.libra-shells
   */
  shellsDir?: string;
  /**
   * File path for persisting the todo list. When set, todos are loaded
   * on startup and saved on every update, surviving across separate
   * process invocations.
   * Default: undefined (todos are in-memory only)
   */
  todoFile?: string;
  /**
   * Model to use for the `code_search` subagent tool. When provided,
   * the `code_search` tool is registered — it spawns a read-only
   * subagent with read, grep, and find_file_by_name tools to explore
   * the codebase and answer natural language queries.
   * Default: undefined (code_search tool is not registered)
   */
  model?: Model;
  /**
   * Max iterations for the code_search subagent. Default: 10.
   */
  codeSearchMaxIterations?: number;
}

/**
 * Create a code-tools extension that provides file reading, writing,
 * editing, searching, and shell execution tools for coding agents.
 *
 * Tools provided:
 * - `read` — read a file's contents (text, base64 for binary, data URL for images)
 * - `write` — create or overwrite a file (must read existing files first)
 * - `edit` — replace a string in a file (unique match required, or replace_all)
 * - `find_file_by_name` — find files by glob pattern
 * - `grep` — search file contents (regex, glob filter, context lines, output modes)
 * - `code_search` — spawn a read-only subagent to explore the codebase (requires `model`)
 * - `exec` — run a shell command (with timeout, backgrounding)
 * - `get_output` — read output from a backgrounded shell
 * - `kill_shell` — kill a backgrounded shell
 * - `write_to_process` — write to an interactive shell's stdin
 * - `todo_write` — track multi-step tasks with a structured todo list
 *
 * Backgrounded shells persist across turns within the same agent and are
 * killed when the extension is unloaded.
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

  // Shell registry lives at the extension level so backgrounded shells
  // survive across turns. Detached shells are persisted to disk and
  // can be reconnected by a future process. Cleaned up on close().
  const registry = new ShellRegistry(config?.shellsDir);

  // Todo store lives at the extension level so the todo list persists
  // across turns. When todoFile is set, todos also persist to disk
  // and survive across separate process invocations.
  const todoStore = new TodoStore(config?.todoFile);

  // Standard tool factories (file + search tools).
  const toolFactories: ToolFactory[] = [
    readTool,
    writeTool,
    editTool,
    findFileByNameTool,
    grepTool,
  ];

  // Shell tool factories — receive the registry in addition to config.
  const shellToolFactories: ShellToolFactory[] = [
    execTool,
    getOutputTool,
    killShellTool,
    writeToProcessTool,
  ];

  return {
    name: 'code-tools',
    priority: 50,

    install(agent) {
      for (const factory of toolFactories) {
        agent.tool(factory(resolved));
      }
      for (const factory of shellToolFactories) {
        agent.tool(factory({ toolPrefix: resolved.toolPrefix, registry }));
      }
      agent.tool(todoWriteTool({ toolPrefix: resolved.toolPrefix, store: todoStore }));

      // code_search subagent tool — only registered when a model is provided.
      if (config?.model) {
        agent.tool(codeSearchTool({
          toolPrefix: resolved.toolPrefix,
          model: config.model,
          maxIterations: config.codeSearchMaxIterations,
        }));
      }
    },

    // Kill all backgrounded shells when the extension is unloaded.
    async close() {
      registry.close();
    },
  };
}
