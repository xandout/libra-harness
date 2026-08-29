import type { ToolDefinition, ToolResult } from './types.js';
import type { Agent } from './agent.js';

/** Context passed to a tool's execute function. */
export interface ToolContext {
  /** AbortSignal — aborted when the turn is halted. */
  signal: AbortSignal;
  /** Shared turn metadata bag. Extensions may read/write here. */
  metadata: Record<string, unknown>;
}

/**
 * A tool the agent can call.
 *
 * `parameters` is a JSON Schema object (OpenAI function parameters format).
 * `execute` receives parsed arguments and a context.
 *
 * Set `external: true` for tools whose calls should be returned to the caller
 * instead of executed internally. When the model calls an external tool, the
 * agent breaks its continuation loop and returns the tool call in the response
 * with `finishReason: 'tool_calls'`. The caller is responsible for executing
 * the tool and sending the result back in a subsequent request.
 */
export interface Tool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  /**
   * When true, the agent does not execute this tool. Instead, the tool call
   * is returned to the caller via `AgentResponse.toolCalls` with
   * `finishReason: 'tool_calls'`. The caller executes the tool and sends
   * the result back as a `tool` message in a follow-up request.
   */
  external?: boolean;
}

/** Convert a libra {@link Tool} to an OpenAI-compatible {@link ToolDefinition}. */
export function toToolDefinition(tool: Tool): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/**
 * Options for {@link createAgentTool}.
 */
export interface AgentToolOptions {
  /** Tool name as seen by the LLM. */
  name: string;
  /** Tool description as seen by the LLM. */
  description: string;
  /** JSON Schema for the tool's single `message` parameter. */
  parameters?: Record<string, unknown>;
  /** System prompt override for the inner agent's turns. */
  systemPrompt?: string;
  /** Max iterations for the inner agent's turns. */
  maxIterations?: number;
}

/**
 * Wrap an {@link Agent} as a {@link Tool} so an outer agent can delegate to it.
 *
 * The inner agent runs fully in-process. The outer agent's `AbortSignal` and
 * `metadata` are forwarded to the inner agent's turn, so:
 *
 * - If the outer turn is **halted**, the inner agent is also halted.
 * - The inner agent **shares metadata** with the outer turn (e.g. session ID,
 *   trace IDs, user context).
 * - If the inner agent is **halted** (via its own hooks or signal), the tool
 *   returns an error result so the outer agent can react.
 *
 * @example
 * ```typescript
 * const researchTool = createAgentTool(researchAgent, {
 *   name: 'research',
 *   description: 'Delegate a research question to a research agent',
 * })
 *
 * const outerAgent = new Agent({
 *   model,
 *   tools: [researchTool],
 * })
 * ```
 */
export function createAgentTool(agent: Agent, options: AgentToolOptions): Tool {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters ?? {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to send to the agent.',
        },
      },
      required: ['message'],
    },
    async execute(args, ctx) {
      const message = args.message != null
        ? String(args.message)
        : args.query != null
          ? String(args.query)
          : JSON.stringify(args);
      const result = await agent.run({
        message,
        signal: ctx.signal,
        metadata: ctx.metadata,
        ...(options.systemPrompt && { systemPrompt: options.systemPrompt }),
        ...(options.maxIterations !== undefined && { maxIterations: options.maxIterations }),
      });

      if (result.finishReason === 'halted') {
        return {
          toolCallId: '',
          content: 'Subagent was halted.',
          isError: true,
        };
      }

      return {
        toolCallId: '',
        content: result.message,
      };
    },
  };
}
