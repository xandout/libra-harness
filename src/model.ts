import type { Message, ToolDefinition } from './types.js';

/**
 * A partial output delta from a streaming model call.
 *
 * Emitted via {@link ModelRequest.onDelta} during generation. The core
 * does not interpret these — it simply forwards the callback to the
 * model provider. Extensions can subscribe by setting `onDelta` on
 * `ctx.modelRequest` in a `beforeLLM` hook.
 */
export interface ModelDelta {
  /** What kind of delta this is. */
  type: 'text' | 'reasoning' | 'tool-input';
  /** The partial content for this delta. */
  content: string;
  /** Tool call ID (only for `tool-input` deltas). */
  toolCallId?: string;
  /** Tool name (only for `tool-input` deltas). */
  toolName?: string;
}

/**
 * Request to a model provider.
 *
 * The provider translates this into whatever wire format it speaks.
 * If `onDelta` is provided, the provider should stream partial output
 * via that callback in addition to returning the final {@link ModelResponse}.
 */
export interface ModelRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  /** System instructions prepended to the conversation. */
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Optional callback for streaming deltas.
   *
   * When set, the model provider should use its streaming API and
   * invoke this callback for each text/reasoning/tool-input delta.
   * The final assembled {@link ModelResponse} is still returned.
   */
  onDelta?: (delta: ModelDelta) => void;
}

/** Why the model stopped generating. */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter';

/** Response from a model provider. */
export interface ModelResponse {
  /** The assistant message. May contain `toolCalls` when the model requests tools. */
  message: Message;
  finishReason: FinishReason;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    /** Prompt tokens served from the provider's cache (cache read/hit). */
    cachedPromptTokens?: number;
    /** Prompt tokens written to the provider's cache for future reuse. */
    cacheWriteTokens?: number;
    /** Reasoning/thinking tokens if the provider reports them separately. */
    reasoningTokens?: number;
  };
}

/**
 * Abstract model interface.
 *
 * Implementations are responsible for translating libra's {@link Message}
 * format to/from their wire format and for surfacing tool-call decisions
 * via {@link Message.toolCalls}.
 *
 * The built-in {@link AISdkModel} wraps any Vercel AI SDK provider. You can
 * also implement this interface directly for custom providers.
 */
export interface Model {
  generate(request: ModelRequest): Promise<ModelResponse>;
}
