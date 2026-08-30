import type { Model, ModelRequest, ModelResponse } from './model.js';
import type { Tool, ToolContext } from './tool.js';
import { toToolDefinition } from './tool.js';
import type { Extension } from './extension.js';
import type { HookContext, HookHandler, HookName, HookResult } from './hooks.js';
import { HookRegistry } from './hooks.js';
import type { AgentRequest, AgentResponse, TurnContext } from './context.js';
import { messageContentToText, type ToolCall, type ToolResult } from './types.js';
import { HookError } from './errors.js';
import type { RunHandle } from './handle.js';

/**
 * Context passed to a custom {@link ErrorPolicy} function.
 */
export interface ErrorPolicyContext {
  /** The error that was thrown during the turn. */
  error: unknown;
  /** The mutable turn state (includes metadata, messages so far, etc.). */
  turn: TurnContext;
}

/**
 * How the agent handles an error that no `onError` hook recovered from.
 *
 * - `'fallback'` (default) — return a graceful fallback response with
 *   `finishReason: 'error'`. The error is attached to
 *   `response.metadata.error` so observability extensions can see it.
 * - `'throw'` — rethrow the error. Use this when you want strict
 *   fail-fast behavior and prefer to handle errors at the call site.
 * - `function` — custom policy. Return an {@link AgentResponse} to
 *   recover, or `undefined` to rethrow. This runs *after* all `onError`
 *   hooks, so it only fires when no extension recovered.
 *
 * `onError` hooks always run first and take precedence — if a hook
 * returns `{ skip: true, value: AgentResponse }`, the error policy is
 * not consulted.
 */
export type ErrorPolicy =
  | 'throw'
  | 'fallback'
  | ((ctx: ErrorPolicyContext) => AgentResponse | undefined | Promise<AgentResponse | undefined>);

/** Default fallback message when `errorPolicy` is `'fallback'`. */
const DEFAULT_FALLBACK_MESSAGE = 'Sorry, I encountered an error. Please try again.';

/** Configuration for constructing an {@link Agent}. */
export interface AgentConfig {
  model: Model;
  systemPrompt?: string;
  tools?: Tool[];
  /** Default max LLM iterations per turn. Default: 25. */
  maxIterations?: number;
  /** Default temperature. */
  temperature?: number;
  /** Default max tokens. */
  maxTokens?: number;
  /**
   * Default reasoning effort for models that support thinking/reasoning mode.
   * Set to `'low'` for faster responses, `'high'` for standard reasoning,
   * or `'max'` for maximum reasoning effort.
   */
  reasoningEffort?: 'low' | 'high' | 'max';
  /**
   * Default provider-specific options passed through to the model adapter.
   * Use this for provider-specific features like DeepSeek's thinking mode toggle.
   */
  providerOptions?: Record<string, Record<string, unknown>>;
  /**
   * How to handle errors that no `onError` hook recovered from.
   *
   * Default: `'fallback'` — returns a graceful response instead of
   * throwing. Set to `'throw'` for strict fail-fast behavior, or pass
   * a function for custom recovery logic.
   *
   * `onError` hooks always run first and take precedence.
   */
  errorPolicy?: ErrorPolicy;
  /**
   * Message used by the built-in `'fallback'` error policy.
   * Default: `'Sorry, I encountered an error. Please try again.'`
   */
  fallbackMessage?: string;
}

const DEFAULT_MAX_ITERATIONS = 25;
const DEFAULT_ERROR_POLICY: ErrorPolicy = 'fallback';

/**
 * The core agent harness.
 *
 * Executes turns with a model, supports tool-call continuation, and is
 * extended via hooks and extensions.
 *
 * Agents are **steerable** and **haltable** — {@link Agent.run} returns a
 * {@link RunHandle} that exposes `steer()` and `halt()` controls tied to
 * that specific turn.
 */
export class Agent {
  private readonly registry = new HookRegistry();
  private readonly tools = new Map<string, Tool>();
  /** Maps tool name → extension that registered it (for unload). */
  private readonly toolOwners = new Map<string, string>();
  private readonly extensions = new Map<string, Extension>();

  private config: AgentConfig;

  /** Name of the extension currently being installed (for tool ownership tracking). */
  private installingExtension?: string;

  // All currently-active handles. Used by the convenience steer()/halt()
  // methods so callers without a RunHandle can still control active turns.
  private readonly activeHandles = new Set<RunHandleInternal>();

  constructor(config: AgentConfig) {
    this.config = config;
    for (const tool of config.tools ?? []) {
      this.tools.set(tool.name, tool);
    }
  }

  // ── System Prompt ──────────────────────────────────────────────────

  /**
   * Append content to the system prompt. This is a one-time mutation
   * typically called by extensions at install time (e.g. the skills
   * extension appends preloaded skill content so it's always active).
   */
  appendSystemPrompt(content: string): void {
    const current = this.config.systemPrompt ?? '';
    this.config = {
      ...this.config,
      systemPrompt: current ? current + '\n\n' + content : content,
    };
  }

  // ── Extension & Hook Registration ──────────────────────────────────

  /** Install an extension. The extension's `install()` is called immediately. */
  use(extension: Extension): this {
    if (this.extensions.has(extension.name)) {
      throw new Error(`Extension "${extension.name}" is already installed`);
    }
    this.extensions.set(extension.name, extension);
    this.installingExtension = extension.name;
    try {
      extension.install(this);
    } finally {
      this.installingExtension = undefined;
    }
    return this;
  }

  /**
   * Uninstall an extension by name — removes its hooks, tools, and
   * registration. If the extension has a `close()` method, it is called
   * (awaited) so resources like MCP client connections are cleaned up.
   */
  async unload(name: string): Promise<this> {
    const extension = this.extensions.get(name);
    if (!extension) return this;
    this.registry.unregister(name);
    for (const [toolName, owner] of this.toolOwners) {
      if (owner === name) {
        this.tools.delete(toolName);
        this.toolOwners.delete(toolName);
      }
    }
    this.extensions.delete(name);
    if (typeof (extension as { close?: unknown }).close === 'function') {
      await (extension as unknown as { close: () => Promise<void> }).close();
    }
    return this;
  }

  /**
   * Register a hook at a lifecycle stage.
   *
   * The hook's priority is derived from the extension that registers it:
   * - During `install()` (inside `use()`), the installing extension's
   *   `priority` field is used.
   * - Outside `install()`, the priority of an installed extension with
   *   a matching `extensionName` is used.
   * - Otherwise, priority defaults to 0.
   *
   * Higher priority = runs first. Ties keep registration order.
   */
  hook(stage: HookName, extensionName: string, handler: HookHandler): this {
    const priority = this.resolveExtensionPriority(extensionName);
    this.registry.register(stage, extensionName, handler, priority);
    return this;
  }

  /**
   * Resolve the priority for a hook registered by `extensionName`.
   * During install, the installing extension's priority wins. Otherwise
   * look up the extension by name. Default: 0.
   */
  private resolveExtensionPriority(extensionName: string): number {
    if (this.installingExtension) {
      const ext = this.extensions.get(this.installingExtension);
      if (ext) return ext.priority ?? 0;
    }
    const ext = this.extensions.get(extensionName);
    if (ext) return ext.priority ?? 0;
    return 0;
  }

  /** Register a tool. Ownership is tracked for the currently-installing extension. */
  tool(tool: Tool): this {
    this.tools.set(tool.name, tool);
    if (this.installingExtension) {
      this.toolOwners.set(tool.name, this.installingExtension);
    }
    return this;
  }

  /** List all registered tool names. */
  getTools(): string[] {
    return [...this.tools.keys()];
  }

  // ── Convenience Steering & Halting ─────────────────────────────────

  /**
   * Inject a steering message into all active turns.
   *
   * Convenience method — operates on every currently-running turn. If you
   * have the {@link RunHandle} from `run()`, prefer calling
   * `handle.steer()` directly. Hooks should use `ctx.turn.steer()` to
   * target only their own turn.
   */
  steer(message: string): void {
    for (const h of this.activeHandles) h.steer(message);
  }

  /**
   * Halt all active turns.
   *
   * Convenience method — halts every currently-running turn. If you have
   * the {@link RunHandle} from `run()`, prefer calling `handle.halt()`
   * directly. Hooks should use `ctx.turn.halt()` to target only their own
   * turn.
   */
  halt(reason = 'halted'): void {
    for (const h of this.activeHandles) h.halt(reason);
  }

  /** Whether any turn is currently active. */
  get isRunning(): boolean {
    return this.activeHandles.size > 0;
  }

  // ── Turn Execution ─────────────────────────────────────────────────

  /**
   * Execute an agent turn.
   *
   * Returns a {@link RunHandle} that is thenable (so `await agent.run(req)`
   * still works) and exposes `steer()` and `halt()` controls for this
   * specific turn. Multiple turns can run concurrently — each gets its
   * own independent handle.
   */
  run(request: AgentRequest): RunHandle {
    const abort = new AbortController();
    const steeringQueue: string[] = [];

    // Link external signal if provided.
    if (request.signal) {
      if (request.signal.aborted) {
        abort.abort(request.signal.reason);
      } else {
        request.signal.addEventListener('abort', () => abort.abort(request.signal!.reason), { once: true });
      }
    }

    const maxIter = request.maxIterations ?? this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    const turn: TurnContext = {
      request,
      messages: [{ role: 'user', content: request.message }],
      tools: this.mergeTools(request.tools),
      systemPrompt: request.systemPrompt ?? this.config.systemPrompt,
      metadata: { ...request.metadata },
      signal: abort.signal,
      steer: () => {},
      halt: () => {},
    };

    const handle = new RunHandleImpl(abort, steeringQueue);
    this.activeHandles.add(handle);

    // Wire turn-level steer/halt to this handle.
    turn.steer = (msg: string) => handle.steer(msg);
    turn.halt = (reason?: string) => handle.halt(reason);

    // Kick off the turn. We store the promise on the handle so `handle.done`
    // and `await handle` both resolve to the same result.
    handle.done = this.executeTurn(turn, maxIter, steeringQueue).finally(() => {
      this.activeHandles.delete(handle);
    });

    return handle;
  }

  private mergeTools(extra?: Tool[]): Tool[] {
    const all = new Map(this.tools);
    for (const t of extra ?? []) all.set(t.name, t);
    return [...all.values()];
  }

  private async executeTurn(
    turn: TurnContext,
    maxIter: number,
    steeringQueue: string[],
  ): Promise<AgentResponse> {
    let iterations = 0;
    const allToolCalls: ToolCall[] = [];

    try {
    // beforeTurn — can modify messages, tools, metadata.
    await this.runHooks('beforeTurn', { turn });

    // beforeContext — last chance to modify context before the LLM loop.
    await this.runHooks('beforeContext', { turn });

    for (;;) {
      // ── Check halt ──
      if (turn.signal.aborted) {
        return await this.finishTurn(turn, '', 'halted', iterations, allToolCalls);
      }

      // ── Check max iterations ──
      if (iterations >= maxIter) {
        return await this.finishTurn(turn, '', 'max_iterations', iterations, allToolCalls);
      }

      // ── Drain steering messages ──
      this.drainSteering(turn, steeringQueue);

      // ── beforeLLM ──
      const modelRequest: ModelRequest = {
        messages: turn.messages,
        tools: turn.tools.length > 0 ? turn.tools.map(toToolDefinition) : undefined,
        systemPrompt: turn.systemPrompt,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        reasoningEffort: this.config.reasoningEffort,
        providerOptions: this.config.providerOptions,
        signal: turn.signal,
      };

      const beforeLLMResult = await this.runHooks('beforeLLM', { turn, modelRequest });

      // Halt may have been called during beforeLLM hooks.
      if (turn.signal.aborted) {
        return await this.finishTurn(turn, '', 'halted', iterations, allToolCalls);
      }

      let modelResponse: ModelResponse;

      if (beforeLLMResult.skipped && beforeLLMResult.value) {
        modelResponse = beforeLLMResult.value as ModelResponse;
      } else {
        try {
          modelResponse = await this.config.model.generate(modelRequest);
        } catch (err) {
          if (turn.signal.aborted) {
            return await this.finishTurn(turn, '', 'halted', iterations, allToolCalls);
          }
          throw err;
        }
      }

      // ── afterLLM ──
      await this.runHooks('afterLLM', { turn, modelRequest, modelResponse });

      iterations++;

      // Add the assistant message to the conversation.
      turn.messages.push(modelResponse.message);

      // ── Halt may have been called during afterLLM hooks ──
      if (turn.signal.aborted) {
        return await this.finishTurn(turn, messageContentToText(modelResponse.message.content), 'halted', iterations, allToolCalls);
      }

      // ── No tool calls → final response (unless steering pending) ──
      const toolCalls = modelResponse.message.toolCalls;
      if (!toolCalls || toolCalls.length === 0) {
        // If steering messages arrived during the LLM call, don't end
        // the turn — drain them and loop so the agent can respond.
        if (steeringQueue.length > 0) {
          this.drainSteering(turn, steeringQueue);
          continue;
        }
        return await this.finishTurn(turn, messageContentToText(modelResponse.message.content), 'stop', iterations, allToolCalls);
      }

      // ── Separate external (pass-through) from internal (execute) tool calls ──
      const externalCalls: ToolCall[] = [];
      const internalCalls: ToolCall[] = [];
      for (const tc of toolCalls) {
        const tool = turn.tools.find((t) => t.name === tc.name);
        if (tool?.external) externalCalls.push(tc);
        else internalCalls.push(tc);
      }

      // ── External tool calls → return to caller for execution ──
      if (externalCalls.length > 0) {
        allToolCalls.push(...externalCalls);
        // If there are also internal calls in this batch, execute those first
        // (the model may have mixed both in one response). The external calls
        // are still returned — the caller will see them and the internal results.
        if (internalCalls.length > 0) {
          allToolCalls.push(...internalCalls);
          if (turn.signal.aborted) {
            return await this.finishTurn(turn, '', 'halted', iterations, allToolCalls);
          }
          const mixedResults = await Promise.all(
            internalCalls.map(async (toolCall) => {
              const beforeToolCtx: HookContext = { turn, toolCall };
              const beforeToolResult = await this.runHooks('beforeTool', beforeToolCtx);
              let toolResult: ToolResult;
              if (beforeToolResult.skipped && beforeToolResult.value) {
                toolResult = beforeToolResult.value as ToolResult;
              } else {
                toolResult = await this.executeToolCall(toolCall, turn);
              }
              const afterToolCtx: HookContext = { turn, toolCall, toolResult };
              const afterToolResult = await this.runHooks('afterTool', afterToolCtx);
              if (afterToolResult.value) {
                toolResult = afterToolResult.value as ToolResult;
              }
              return { toolCall, toolResult };
            }),
          );
          for (const { toolCall, toolResult } of mixedResults) {
            turn.messages.push({
              role: 'tool',
              content: toolResult.content,
              toolCallId: toolCall.id,
              name: toolCall.name,
            });
          }
          // Drain steering after mixed tool results too.
          this.drainSteering(turn, steeringQueue);
        }
        // Return external tool calls to the caller. The assistant message
        // (with toolCalls) is already in turn.messages from the push above.
        return await this.finishTurn(turn, messageContentToText(modelResponse.message.content), 'tool_calls', iterations, allToolCalls, externalCalls);
      }

      // ── Execute internal tool calls ──
      allToolCalls.push(...internalCalls);

      // Check halt before starting the batch.
      if (turn.signal.aborted) {
        return await this.finishTurn(turn, '', 'halted', iterations, allToolCalls);
      }

      // Execute all internal tool calls in the batch concurrently.
      // Each tool call runs its beforeTool → execute → afterTool pipeline
      // independently. Results are collected in order and appended to
      // turn.messages after all complete, preserving the model's ordering.
      const results = await Promise.all(
        internalCalls.map(async (toolCall) => {
          // beforeTool — can short-circuit with a synthetic result.
          const beforeToolCtx: HookContext = { turn, toolCall };
          const beforeToolResult = await this.runHooks('beforeTool', beforeToolCtx);

          let toolResult: ToolResult;
          if (beforeToolResult.skipped && beforeToolResult.value) {
            toolResult = beforeToolResult.value as ToolResult;
          } else {
            toolResult = await this.executeToolCall(toolCall, turn);
          }

          // afterTool — can modify the result.
          const afterToolCtx: HookContext = { turn, toolCall, toolResult };
          const afterToolResult = await this.runHooks('afterTool', afterToolCtx);
          if (afterToolResult.value) {
            toolResult = afterToolResult.value as ToolResult;
          }

          return { toolCall, toolResult };
        }),
      );

      // Append results to messages in the original order.
      for (const { toolCall, toolResult } of results) {
        turn.messages.push({
          role: 'tool',
          content: toolResult.content,
          toolCallId: toolCall.id,
          name: toolCall.name,
        });
      }

      // ── Drain steering messages right after tool results ──
      // This ensures the model sees steering directives immediately
      // alongside tool results, rather than waiting for the next
      // loop iteration's drain at the top.
      this.drainSteering(turn, steeringQueue);

      // Loop continues — the model will see the tool results.
    }
    } catch (err) {
      if (turn.signal.aborted) {
        return await this.finishTurn(turn, '', 'halted', iterations, allToolCalls);
      }

      // Fire onError hooks — extensions can observe or recover.
      // Hooks take precedence over the error policy.
      const errorResult = await this.runHooks('onError', { turn, error: err });
      if (errorResult.skipped && errorResult.value) {
        const response = errorResult.value as AgentResponse;
        turn.response = response;
        await this.runHooks('afterTurn', { turn });
        return response;
      }

      // No hook recovered — apply the configured error policy.
      const policy = this.config.errorPolicy ?? DEFAULT_ERROR_POLICY;

      if (policy === 'throw') {
        throw err;
      }

      if (policy === 'fallback') {
        return await this.finishWithError(turn, err, iterations, allToolCalls);
      }

      // Custom policy function — return a response to recover,
      // return undefined to rethrow.
      const customResponse = await policy({ error: err, turn });
      if (customResponse) {
        turn.response = customResponse;
        await this.runHooks('afterTurn', { turn });
        return customResponse;
      }

      throw err;
    }
  }

  /**
   * Build the response, run beforeResponse + afterTurn hooks, and return.
   * All turn exit paths go through here so extensions (session, memory,
   * observability) always get a chance to persist/observe.
   */
  private async finishTurn(
    turn: TurnContext,
    message: string,
    finishReason: AgentResponse['finishReason'],
    iterations: number,
    toolCalls: ToolCall[],
    pendingToolCalls?: ToolCall[],
  ): Promise<AgentResponse> {
    const response = this.buildResponse(turn, message, finishReason, iterations, toolCalls, pendingToolCalls);
    turn.response = response;

    // beforeResponse — can modify the final response.
    await this.runHooks('beforeResponse', { turn });
    // afterTurn — observe/persist.
    await this.runHooks('afterTurn', { turn });

    return turn.response;
  }

  /**
   * Build a fallback error response, run afterTurn hooks, and return.
   *
   * Used by the default `'fallback'` error policy when no `onError` hook
   * recovered. The error is attached to `response.metadata.error` so
   * observability extensions can inspect it via `afterTurn`.
   */
  private async finishWithError(
    turn: TurnContext,
    err: unknown,
    iterations: number,
    toolCalls: ToolCall[],
  ): Promise<AgentResponse> {
    const message = this.config.fallbackMessage ?? DEFAULT_FALLBACK_MESSAGE;
    const response = this.buildResponse(turn, message, 'error', iterations, toolCalls);
    // Attach the error so observability extensions can see what happened.
    response.metadata = { ...turn.metadata, error: err };
    turn.response = response;
    await this.runHooks('afterTurn', { turn });
    return response;
  }

  private async executeToolCall(toolCall: ToolCall, turn: TurnContext): Promise<ToolResult> {
    const tool = turn.tools.find((t) => t.name === toolCall.name);
    if (!tool) {
      return {
        toolCallId: toolCall.id,
        content: `Error: tool "${toolCall.name}" not found`,
        isError: true,
      };
    }

    let args: Record<string, unknown>;
    try {
      args = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
    } catch {
      return {
        toolCallId: toolCall.id,
        content: `Error: invalid JSON arguments: ${toolCall.arguments}`,
        isError: true,
      };
    }

    const toolCtx: ToolContext = {
      signal: turn.signal,
      metadata: turn.metadata,
    };

    try {
      // If already halted, don't invoke the tool at all.
      if (turn.signal.aborted) {
        return {
          toolCallId: toolCall.id,
          content: 'Tool execution halted',
          isError: true,
        };
      }
      // Race the tool execution against the abort signal. If the signal
      // fires, we stop waiting and return a halted result. The tool may
      // still be running in the background — tools that need to clean up
      // should check `ctx.signal` cooperatively.
      const result = await this.raceWithAbort(tool.execute(args, toolCtx), turn.signal);
      if (result) {
        result.toolCallId = toolCall.id;
        return result;
      }
      // Aborted — return a halted tool result.
      return {
        toolCallId: toolCall.id,
        content: 'Tool execution halted',
        isError: true,
      };
    } catch (err) {
      if (turn.signal.aborted) {
        return {
          toolCallId: toolCall.id,
          content: 'Tool execution halted',
          isError: true,
        };
      }
      // Tool errors become tool results so the model can react.
      const msg = err instanceof Error ? err.message : String(err);
      return {
        toolCallId: toolCall.id,
        content: `Tool error: ${msg}`,
        isError: true,
      };
    }
  }

  /**
   * Race a promise against an abort signal. Returns `undefined` if the
   * signal fires first (meaning "halted"). The original promise is NOT
   * cancelled — it may continue running in the background.
   */
  private async raceWithAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal,
  ): Promise<T | undefined> {
    if (signal.aborted) return undefined;
    return Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        signal.addEventListener('abort', () => resolve(undefined), { once: true });
      }),
    ]);
  }

  private drainSteering(turn: TurnContext, steeringQueue: string[]): void {
    while (steeringQueue.length > 0) {
      const msg = steeringQueue.shift()!;
      // Inject a system directive + user message pair. The system
      // message tells the model to treat the steering as an
      // interruption; the user message carries the actual content.
      // Models deprioritize mid-conversation system messages, so we
      // pair it with a user message (which models can't ignore) and
      // use the system message to frame it as a hard redirect.
      turn.messages.push({
        role: 'system',
        content: '[steering] The user has sent a new directive. You must address it immediately. Do not continue the previous task — pivot to the user\'s new request now.',
      });
      turn.messages.push({
        role: 'user',
        content: `[steering] ${msg}`,
      });
    }
  }

  private buildResponse(
    turn: TurnContext,
    message: string,
    finishReason: AgentResponse['finishReason'],
    iterations: number,
    toolCalls: ToolCall[],
    pendingToolCalls?: ToolCall[],
  ): AgentResponse {
    return {
      role: 'assistant',
      message,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      ...(pendingToolCalls && pendingToolCalls.length > 0 && { pendingToolCalls }),
      finishReason,
      iterations,
      metadata: turn.metadata,
    };
  }

  private async runHooks(
    stage: HookName,
    ctx: HookContext,
  ): Promise<{ skipped: boolean; value?: unknown }> {
    for (const entry of this.registry.entries(stage)) {
      try {
        const result: HookResult | void = await entry.handler(ctx);
        if (result?.skip) {
          return { skipped: true, value: result.value };
        }
      } catch (err) {
        if (ctx.turn.signal.aborted) return { skipped: false };
        if (stage === 'onError') throw err;
        throw new HookError(
          `Hook "${stage}" from extension "${entry.extensionName}" failed: ${err instanceof Error ? err.message : String(err)}`,
          stage,
          entry.extensionName,
          err,
        );
      }
    }
    return { skipped: false };
  }
}

// ── RunHandle Implementation ─────────────────────────────────────────

/** Internal interface shared between Agent and RunHandleImpl. */
interface RunHandleInternal extends RunHandle {
  done: Promise<AgentResponse>;
}

/**
 * Concrete implementation of {@link RunHandle}.
 *
 * Thenable so `await handle` works, but also exposes discrete controls.
 */
class RunHandleImpl implements RunHandleInternal {
  private readonly abort: AbortController;
  private readonly steeringQueue: string[];
  private _done?: Promise<AgentResponse>;

  constructor(abort: AbortController, steeringQueue: string[]) {
    this.abort = abort;
    this.steeringQueue = steeringQueue;
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get isRunning(): boolean {
    return !this.abort.signal.aborted && this._done !== undefined;
  }

  get done(): Promise<AgentResponse> {
    if (!this._done) {
      throw new Error('RunHandle: done accessed before run() was called');
    }
    return this._done;
  }

  set done(promise: Promise<AgentResponse>) {
    this._done = promise;
  }

  steer(message: string): void {
    if (!this.abort.signal.aborted) {
      this.steeringQueue.push(message);
    }
  }

  halt(reason = 'halted'): void {
    this.abort.abort(reason);
  }

  // Thenable — allows `await handle` to work.
  then<TResult1 = AgentResponse, TResult2 = never>(
    onfulfilled?: ((value: AgentResponse) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.done.then(onfulfilled, onrejected);
  }
}
