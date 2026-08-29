import type { Extension } from '../../../extension.js';
import { messageContentToText } from '../../../types.js';
import { trace, context, SpanStatusCode, type Tracer, type Span } from '@opentelemetry/api';

/**
 * Config for the OpenTelemetry extension.
 *
 * The extension codes against `@opentelemetry/api` only. The host is
 * responsible for setting up an SDK and exporter (e.g.
 * `@opentelemetry/sdk-node`) before creating the agent — the extension
 * just acquires a tracer and creates spans.
 */
export interface OtelExtensionConfig {
  /**
   * Tracer to use. If omitted, acquires the global tracer registered
   * with `@opentelemetry/api` under the given `tracerName` (default:
   * `'libra'`). Most hosts register a global tracer provider and never
   * need to pass this.
   */
  tracer?: Tracer;
  /** Tracer name used with `trace.getTracer()`. Default: `'libra'`. */
  tracerName?: string;
  /**
   * Service name set as an attribute on the root turn span. Useful for
   * distinguishing multiple agents in the same process (e.g.
   * `'slack-bot'`, `'research-agent'`). Default: not set.
   */
  serviceName?: string;
  /**
   * Whether to record tool call arguments as span attributes. Default:
   * `false` — arguments may contain sensitive data. Enable only in
   * trusted environments.
   */
  recordToolArgs?: boolean;
  /**
   * Max length for tool result content recorded as a span event.
   * Default: 500. Set to 0 to disable result recording.
   */
  maxResultLength?: number;
  /**
   * Metadata keys to record as span attributes on the root `agent.turn`
   * span. This is how turns are correlated to sessions, channels, users,
   * etc. The extension reads `ctx.turn.metadata[key]` and sets
   * `libra.turn.<key>` on the span.
   *
   * Nested keys are supported via dot notation — e.g. `'slack.channelId'`
   * reads `metadata.slack.channelId` and records it as
   * `libra.turn.slack.channelId`.
   *
   * Default: `['sessionId']` — records the session ID if present.
   * The slack-bot overrides this to also record channel/thread/user info.
   *
   * Only string, number, and boolean values are recorded; objects and
   * arrays are skipped (OTel attributes are primitives).
   */
  metadataKeys?: string[];
}

/**
 * OpenTelemetry observability extension.
 *
 * Creates a span hierarchy that mirrors the agent turn lifecycle:
 *
 * ```
 * agent.turn (root span)
 *   ├── llm.request (per LLM call)
 *   ├── llm.request
 *   │   ├── tool.<name> (per tool call)
 *   │   └── tool.<name>
 *   └── llm.request
 * ```
 *
 * Spans are created using `@opentelemetry/api` — the host must register
 * a tracer provider (e.g. via `@opentelemetry/sdk-node`) for spans to
 * be collected and exported. If no provider is registered, the
 * extension is a no-op (the API returns no-op spans).
 *
 * ## Span attributes
 *
 * **agent.turn** (root):
 * - `libra.turn.finish_reason` — stop, halted, max_iterations, error
 * - `libra.turn.iterations` — number of LLM iterations
 * - `libra.turn.tool_calls` — total tool calls made
 * - `libra.turn.message_length` — input message length
 * - `libra.turn.duration_ms` — total turn duration
 * - `libra.service` — service name (if configured)
 * - `libra.turn.<key>` — one per configured `metadataKeys` (default:
 *   `libra.turn.sessionId`). Used to correlate turns to sessions,
 *   channels, users, etc. Supports dot notation (e.g.
 *   `slack.channelId` → `libra.turn.slack.channelId`).
 *
 * **llm.request**:
 * - `libra.llm.message_count` — messages sent to the model
 * - `libra.llm.tool_count` — tools available to the model
 * - `libra.llm.has_tool_calls` — whether the response requested tools
 * - `libra.llm.prompt_tokens` — prompt tokens (if reported by provider)
 * - `libra.llm.completion_tokens` — completion tokens (if reported)
 * - `libra.llm.cached_prompt_tokens` — cached prompt tokens (if reported)
 * - `libra.llm.reasoning_tokens` — reasoning tokens (if reported)
 *
 * **tool.\<name\>**:
 * - `libra.tool.name` — tool name
 * - `libra.tool.is_error` — whether the tool returned an error
 * - `libra.tool.args` — tool arguments JSON (if `recordToolArgs` enabled)
 *
 * ## Priority
 *
 * Uses priority 200 (higher than logger at 100) so spans start before
 * other extensions mutate state — timing reflects raw lifecycle cost.
 */
/**
 * Resolve a dot-notation path from a metadata object.
 * e.g. 'slack.channelId' → metadata.slack.channelId
 * Returns undefined if any segment is missing or not an object.
 */
function resolveMetaPath(meta: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = meta;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export default function createOtelExtension(
  config?: OtelExtensionConfig,
): Extension {
  const tracer = config?.tracer ?? trace.getTracer(config?.tracerName ?? 'libra');
  const serviceName = config?.serviceName;
  const recordToolArgs = config?.recordToolArgs ?? false;
  const maxResultLength = config?.maxResultLength ?? 500;
  const metadataKeys = config?.metadataKeys ?? ['sessionId'];

  // Per-turn span state, keyed by the turn object identity. This avoids
  // relying on turn.metadata (which other extensions may clear or mutate)
  // and naturally supports concurrent turns.
  const turnSpans = new WeakMap<object, Span>();
  // The active LLM span for the current iteration. Stored in a per-turn
  // WeakMap so tool spans are created as children of the right LLM span.
  const llmSpans = new WeakMap<object, Span>();
  // Timing for stages that don't have a natural span (beforeTurn → afterTurn
  // is the root span, but we also record per-stage durations as events).
  const stageTimings = new WeakMap<object, Map<string, number>>();

  function getTiming(turn: object, stage: string): number | undefined {
    return stageTimings.get(turn)?.get(stage);
  }

  function setTiming(turn: object, stage: string, time: number): void {
    let map = stageTimings.get(turn);
    if (!map) {
      map = new Map();
      stageTimings.set(turn, map);
    }
    map.set(stage, time);
  }

  return {
    name: 'otel',
    priority: 200,
    install(agent) {
      // ── beforeTurn: start root span ──────────────────────────────
      agent.hook('beforeTurn', 'otel', async (ctx) => {
        const span = tracer.startSpan('agent.turn');
        const turnObj = ctx.turn;
        turnSpans.set(turnObj, span);

        if (serviceName) {
          span.setAttribute('libra.service', serviceName);
        }
        span.setAttribute('libra.turn.message_length', messageContentToText(ctx.turn.request.message).length);

        // Record metadata keys as span attributes for session/channel
        // correlation. Supports dot notation for nested keys (e.g.
        // 'slack.channelId' → metadata.slack.channelId).
        const meta = ctx.turn.metadata;
        for (const key of metadataKeys) {
          const value = resolveMetaPath(meta, key);
          if (value !== undefined && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
            span.setAttribute(`libra.turn.${key}`, value);
          }
        }

        setTiming(turnObj, 'beforeTurn', performance.now());

        // Set the span as active so child spans (LLM, tools) are
        // parented to it automatically via context.
        context.active();
      });

      // ── beforeContext: record timing ─────────────────────────────
      agent.hook('beforeContext', 'otel', async (ctx) => {
        setTiming(ctx.turn, 'beforeContext', performance.now());
      });

      // ── beforeLLM: start LLM child span ──────────────────────────
      agent.hook('beforeLLM', 'otel', async (ctx) => {
        const turnObj = ctx.turn;
        const rootSpan = turnSpans.get(turnObj);
        if (!rootSpan) return;

        // Start the LLM span as a child of the root span.
        const llmSpan = tracer.startSpan(
          'llm.request',
          undefined,
          trace.setSpan(context.active(), rootSpan),
        );
        llmSpans.set(turnObj, llmSpan);

        if (ctx.modelRequest) {
          llmSpan.setAttribute('libra.llm.message_count', ctx.modelRequest.messages.length);
          llmSpan.setAttribute('libra.llm.tool_count', ctx.modelRequest.tools?.length ?? 0);
        }
      });

      // ── afterLLM: end LLM span, record usage ─────────────────────
      agent.hook('afterLLM', 'otel', async (ctx) => {
        const turnObj = ctx.turn;
        const llmSpan = llmSpans.get(turnObj);
        if (!llmSpan) return;

        const resp = ctx.modelResponse;
        if (resp) {
          const toolCalls = resp.message.toolCalls;
          llmSpan.setAttribute('libra.llm.has_tool_calls', !!toolCalls?.length);

          if (resp.usage) {
            llmSpan.setAttribute('libra.llm.prompt_tokens', resp.usage.promptTokens);
            llmSpan.setAttribute('libra.llm.completion_tokens', resp.usage.completionTokens);
            if (resp.usage.cachedPromptTokens) {
              llmSpan.setAttribute('libra.llm.cached_prompt_tokens', resp.usage.cachedPromptTokens);
            }
            if (resp.usage.reasoningTokens) {
              llmSpan.setAttribute('libra.llm.reasoning_tokens', resp.usage.reasoningTokens);
            }
          }

          if (resp.finishReason) {
            llmSpan.setAttribute('libra.llm.finish_reason', resp.finishReason);
          }
        }

        llmSpan.end();
        llmSpans.delete(turnObj);
      });

      // ── beforeTool: start tool child span ────────────────────────
      agent.hook('beforeTool', 'otel', async (ctx) => {
        const turnObj = ctx.turn;
        const toolName = ctx.toolCall?.name ?? 'unknown';
        const parentSpan = llmSpans.get(turnObj) ?? turnSpans.get(turnObj);
        if (!parentSpan) return;

        const toolSpan = tracer.startSpan(
          `tool.${toolName}`,
          undefined,
          trace.setSpan(context.active(), parentSpan),
        );

        // Stash the tool span on the turn's metadata so afterTool can
        // find it. Use a unique key per tool call id to handle batches.
        if (ctx.toolCall) {
          const key = `_otel_tool_span_${ctx.toolCall.id}`;
          ctx.turn.metadata[key] = toolSpan;
        }

        toolSpan.setAttribute('libra.tool.name', toolName);
        if (recordToolArgs && ctx.toolCall) {
          try {
            toolSpan.setAttribute('libra.tool.args', ctx.toolCall.arguments);
          } catch {
            // Args may not be serializable — skip.
          }
        }
      });

      // ── afterTool: end tool span, record result ──────────────────
      agent.hook('afterTool', 'otel', async (ctx) => {
        if (!ctx.toolCall) return;
        const key = `_otel_tool_span_${ctx.toolCall.id}`;
        const toolSpan = ctx.turn.metadata[key] as Span | undefined;
        if (!toolSpan) return;

        if (ctx.toolResult) {
          const isError = !!(ctx.toolResult as { isError?: boolean }).isError;
          toolSpan.setAttribute('libra.tool.is_error', isError);

          if (maxResultLength > 0 && ctx.toolResult.content) {
            const content = ctx.toolResult.content;
            const truncated = content.length > maxResultLength
              ? content.slice(0, maxResultLength) + '…'
              : content;
            toolSpan.addEvent('tool.result', { 'libra.tool.result': truncated });
          }

          if (isError) {
            toolSpan.setStatus({ code: SpanStatusCode.ERROR });
          }
        }

        toolSpan.end();
        delete ctx.turn.metadata[key];
      });

      // ── onError: record exception on root span ───────────────────
      agent.hook('onError', 'otel', async (ctx) => {
        const rootSpan = turnSpans.get(ctx.turn);
        if (!rootSpan) return;

        const err = ctx.error;
        const message = err instanceof Error ? err.message : String(err);
        rootSpan.recordException(err instanceof Error ? err : new Error(message));
        rootSpan.setStatus({ code: SpanStatusCode.ERROR, message });
      });

      // ── afterTurn: end root span with final attributes ────────────
      agent.hook('afterTurn', 'otel', async (ctx) => {
        const turnObj = ctx.turn;
        const rootSpan = turnSpans.get(turnObj);
        if (!rootSpan) return;

        const resp = ctx.turn.response;
        if (resp) {
          rootSpan.setAttribute('libra.turn.finish_reason', resp.finishReason);
          rootSpan.setAttribute('libra.turn.iterations', resp.iterations);
          rootSpan.setAttribute('libra.turn.tool_calls', resp.toolCalls?.length ?? 0);
        }

        // Record total turn duration as an attribute.
        const startTime = getTiming(turnObj, 'beforeTurn');
        if (startTime) {
          const durationMs = performance.now() - startTime;
          rootSpan.setAttribute('libra.turn.duration_ms', Math.round(durationMs));
        }

        rootSpan.end();
        turnSpans.delete(turnObj);
      });
    },
  };
}
