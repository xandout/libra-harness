import type { AgentResponse } from './context.js';

/**
 * Controller for a running agent turn.
 *
 * Returned by {@link Agent.run}. The handle is **thenable** — you can
 * `await` it directly to get the final {@link AgentResponse} — but it also
 * exposes discrete controls for steering and halting the turn:
 *
 * ```typescript
 * const handle = agent.run({ message: 'Research this' })
 *
 * // Steer mid-turn (injects a user message before the next LLM iteration)
 * handle.steer('Focus on the financial aspects')
 *
 * // Halt mid-turn (cancels in-flight model calls, stops the loop)
 * handle.halt('user cancelled')
 *
 * // Or just await the result
 * const result = await handle
 * ```
 *
 * Each call to `agent.run()` returns its own independent handle. This means
 * multiple turns can run concurrently without clobbering each other's
 * steering/halting state.
 */
export interface RunHandle extends PromiseLike<AgentResponse> {
  /** The AbortSignal for this turn. Passed to model calls and tools. */
  readonly signal: AbortSignal;

  /** Whether the turn is still running. */
  readonly isRunning: boolean;

  /**
   * Inject a steering message into the turn.
   *
   * The message is added as a `user` message before the next LLM iteration,
   * allowing the caller to redirect the agent mid-turn. No-op if the turn
   * has already completed.
   */
  steer(message: string): void;

  /**
   * Halt the turn.
   *
   * Aborts any in-flight model call and stops the turn loop. The turn
   * resolves with `finishReason: 'halted'`. No-op if the turn has already
   * completed.
   *
   * **Propagation**: Halting cancels in-flight `fetch` calls to the model
   * and races against running tool executions. Tools that receive the
   * AbortSignal via {@link ToolContext.signal} should check it cooperatively
   * to clean up resources. A tool that ignores the signal may continue
   * running in the background, but the harness will not wait for it.
   */
  halt(reason?: string): void;

  /** The promise that resolves with the final response. */
  readonly done: Promise<AgentResponse>;
}
