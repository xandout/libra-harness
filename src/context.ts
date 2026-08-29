import type { Message, MessageContent, ToolCall } from './types.js';
import type { Tool } from './tool.js';

/**
 * The request that initiates an agent turn.
 */
export interface AgentRequest {
  /** The user's text or multimodal message. */
  message: MessageContent;
  /** Override the agent's system prompt for this turn. */
  systemPrompt?: string;
  /** Additional tools for this turn (merged with agent-level tools). */
  tools?: Tool[];
  /** Extra metadata available to hooks/extensions throughout the turn. */
  metadata?: Record<string, unknown>;
  /** Abort the turn by aborting this signal. */
  signal?: AbortSignal;
  /** Max LLM iterations before the turn is stopped. Default: 25. */
  maxIterations?: number;
}

/** Why a turn ended. */
export type TurnFinishReason =
  | 'stop' // model returned a final response
  | 'tool_calls' // model called an external tool; caller must execute and resume
  | 'halted' // aborted via signal or agent.halt()
  | 'max_iterations' // hit the iteration cap
  | 'error'; // unhandled error

/**
 * The result of an agent turn.
 */
export interface AgentResponse {
  role: 'assistant';
  /** Final text response from the model (may be empty if halted). */
  message: string;
  /** Tool calls made during the turn (for observation/logging). */
  toolCalls?: ToolCall[];
  /**
   * When `finishReason` is `'tool_calls'`, these are the external tool calls
   * the caller must execute and send back as `tool` messages in a follow-up
   * request. Internal tool calls (already executed) are in `toolCalls`.
   */
  pendingToolCalls?: ToolCall[];
  /** Why the turn ended. */
  finishReason: TurnFinishReason;
  /** Number of LLM iterations executed. */
  iterations: number;
  /** Shared metadata bag. */
  metadata: Record<string, unknown>;
}

/**
 * Mutable execution state for a single turn.
 *
 * Extensions receive this through hooks and may mutate it to influence
 * the turn. This represents **execution state**, not the whole application.
 * Do not use it as a service locator.
 */
export interface TurnContext {
  request: AgentRequest;
  /** The conversation messages for this turn (mutable). */
  messages: Message[];
  /** Tools available this turn (mutable). */
  tools: Tool[];
  /**
   * The resolved system prompt for this turn (per-turn override ?? agent config).
   * Available from beforeTurn onward — extensions can read it to audit
   * what instructions the model will operate under without waiting for
   * beforeLLM. May be undefined if no system prompt is configured.
   */
  systemPrompt?: string;
  /** The final response once the turn completes. */
  response?: AgentResponse;
  /** Shared metadata bag for extensions. */
  metadata: Record<string, unknown>;
  /** AbortSignal for this turn. */
  signal: AbortSignal;
  /** Inject a steering message into this turn before the next LLM iteration. */
  steer(message: string): void;
  /** Halt this turn. Resolves with finishReason 'halted'. */
  halt(reason?: string): void;
}
