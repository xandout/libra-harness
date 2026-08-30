import { Agent } from '../../../../agent.js';
import type { Model } from '../../../../model.js';
import type { Tool } from '../../../../tool.js';
import { makeToolName } from './shared.js';
import { readTool } from './read.js';
import { findFileByNameTool } from './find.js';
import { grepTool } from './grep.js';

// ── Config for the code_search tool ──────────────────────────────────
export interface CodeSearchConfig {
  /** Tool name prefix (same as the parent extension). */
  toolPrefix: string;
  /** Model to use for the subagent. Required. */
  model: Model;
  /** Max iterations for the subagent. Default: 10. */
  maxIterations?: number;
}

// ── code_search tool ─────────────────────────────────────────────────
// Spawns a read-only subagent with read, grep, and find_file_by_name
// tools. The subagent explores the codebase to answer a natural
// language query, then returns a summary. This keeps exploration
// traffic out of the main agent's context.
export function codeSearchTool(cfg: CodeSearchConfig): Tool {
  const prefix = cfg.toolPrefix;
  const maxIter = cfg.maxIterations ?? 10;

  // Build the subagent once — it's stateless between calls since
  // each run() gets its own turn context.
  const subagent = new Agent({
    model: cfg.model,
    systemPrompt:
      'You are a code search assistant. You have read-only tools: read, grep, find_file_by_name. ' +
      'Use them to explore the codebase and answer the user\'s question concisely. ' +
      'Report file paths, line numbers, and relevant code snippets. ' +
      'Do not modify any files. Be thorough but concise.',
    maxIterations: maxIter,
  });

  // Register read-only tools on the subagent.
  const resolved = { toolPrefix: '', maxReadSize: 1_048_576, maxReadLines: 2000, maxLineLength: 2000 };
  subagent.tool(readTool(resolved));
  subagent.tool(findFileByNameTool(resolved));
  subagent.tool(grepTool(resolved));

  return {
    name: makeToolName(prefix, 'code_search'),
    description:
      'Search the codebase using a natural language query. Spawns a read-only subagent ' +
      'with read, grep, and find_file_by_name tools that explores the code and returns ' +
      'a summary with file paths, line numbers, and relevant snippets. ' +
      'Use this for complex exploration tasks like "find where authentication is handled" ' +
      'or "what files implement the agent turn loop". ' +
      'The subagent runs independently — its exploration does not clutter your context.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query describing what to find in the codebase.',
        },
        path: {
          type: 'string',
          description: 'Directory to search in. Default: current working directory.',
        },
      },
      required: ['query'],
    },
    async execute(args, ctx) {
      const query = String(args.query ?? '');
      if (!query) {
        return { toolCallId: '', content: 'Error: query is required' };
      }

      const searchPath = String(args.path ?? process.cwd());
      const fullQuery = `Search in ${searchPath}: ${query}`;

      try {
        const result = await subagent.run({
          message: fullQuery,
          signal: ctx.signal,
          metadata: ctx.metadata,
        });

        if (result.finishReason === 'halted') {
          return {
            toolCallId: '',
            content: 'Code search was halted.',
            isError: true,
          };
        }

        return {
          toolCallId: '',
          content: result.message || 'No results found.',
        };
      } catch (err) {
        return {
          toolCallId: '',
          content: `Code search failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}
