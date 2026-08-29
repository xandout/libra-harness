import type { TurnContext } from './context.js';
import type { ModelRequest, ModelResponse } from './model.js';
import type { ToolCall, ToolResult } from './types.js';

/**
 * Lifecycle stages where hooks can participate.
 *
 * The exact set may evolve; these map to the turn execution model:
 *
 * ```
 * beforeTurn → beforeContext → [beforeLLM → afterLLM → (beforeTool → afterTool)*]* → beforeResponse → afterTurn
 *
 * onError fires when any error is thrown during the turn (model error, hook
 * error, etc.). An onError hook can recover by returning
 * `{ skip: true, value: AgentResponse }`.
 * ```
 */
export type HookName =
  | 'beforeTurn'
  | 'beforeContext'
  | 'beforeLLM'
  | 'afterLLM'
  | 'beforeTool'
  | 'afterTool'
  | 'beforeResponse'
  | 'afterTurn'
  | 'onError';

/**
 * Data passed to a hook handler.
 *
 * `turn` is always present. Other fields are populated depending on the
 * stage so extensions can inspect what they need.
 */
export interface HookContext {
  /** The mutable turn state. */
  turn: TurnContext;
  /** Populated on beforeLLM/afterLLM. */
  modelRequest?: ModelRequest;
  /** Populated on afterLLM. */
  modelResponse?: ModelResponse;
  /** Populated on beforeTool/afterTool. */
  toolCall?: ToolCall;
  /** Populated on afterTool (and beforeTool if a prior hook set it). */
  toolResult?: ToolResult;
  /** Populated on onError — the error that was thrown. */
  error?: unknown;
}

/**
 * What a hook can return.
 *
 * - `skip: true` — short-circuit remaining hooks **and** the default
 *   action for this stage. The `value` (if provided) is used as the
 *   stage result where applicable.
 * - `value` — stage-specific override (e.g. a {@link ModelResponse} for
 *   beforeLLM, a {@link ToolResult} for beforeTool).
 */
export interface HookResult {
  skip?: boolean;
  value?: unknown;
}

/**
 * A hook handler. May mutate the context and/or return a {@link HookResult}.
 */
export type HookHandler = (ctx: HookContext) => Promise<HookResult | void>;

/**
 * An entry in the hook registry.
 */
export interface HookEntry {
  /** Name of the extension that registered this hook (for error reporting). */
  extensionName: string;
  handler: HookHandler;
  /**
   * Priority of the extension that registered this hook. Higher = runs
   * first. Ties are broken by registration order (stable sort).
   * Default: 0.
   */
  priority: number;
}

/**
 * Ordered registry of hooks per lifecycle stage.
 *
 * Hooks execute in priority order within each stage (higher priority
 * first), with registration order as the tiebreaker (stable sort).
 * A hook returning `{ skip: true }` short-circuits remaining hooks
 * in that stage.
 */
export class HookRegistry {
  private readonly hooks = new Map<HookName, HookEntry[]>();

  /**
   * Register a hook at a stage.
   *
   * @param priority Higher = runs first. Ties keep registration order.
   *   Default: 0.
   */
  register(stage: HookName, extensionName: string, handler: HookHandler, priority = 0): void {
    const entries = this.hooks.get(stage) ?? [];
    entries.push({ extensionName, handler, priority });
    this.hooks.set(stage, entries);
  }

  /**
   * Get all hooks for a stage, sorted by priority (descending) then
   * registration order (stable). This sort is computed on each call so
   * that hooks registered after an `unregister()` stay correctly
   * ordered.
   */
  entries(stage: HookName): HookEntry[] {
    const entries = this.hooks.get(stage);
    if (!entries || entries.length <= 1) return entries ?? [];
    // Stable sort by priority descending. Array.prototype.sort is
    // stable in V8 (Node 12+) and all modern engines.
    return [...entries].sort((a, b) => b.priority - a.priority);
  }

  /** Whether any hooks are registered at a stage. */
  has(stage: HookName): boolean {
    return (this.hooks.get(stage)?.length ?? 0) > 0;
  }

  /** Remove all hooks registered by an extension (across all stages). */
  unregister(extensionName: string): void {
    for (const [stage, entries] of this.hooks) {
      const filtered = entries.filter((e) => e.extensionName !== extensionName);
      if (filtered.length === 0) {
        this.hooks.delete(stage);
      } else {
        this.hooks.set(stage, filtered);
      }
    }
  }
}
