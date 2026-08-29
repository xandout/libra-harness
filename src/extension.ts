import type { Agent } from './agent.js';

/**
 * An extension adds behavior to an agent without requiring the core
 * to understand that behavior.
 *
 * `install` is called when the extension is added via `agent.use()`.
 * The extension typically registers hooks on the agent inside `install`.
 *
 * Example:
 * ```typescript
 * const loggingExtension: Extension = {
 *   name: 'logging',
 *   install(agent) {
 *     agent.hook('beforeLLM', 'logging', async (ctx) => {
 *       console.log('LLM call with', ctx.turn.messages.length, 'messages')
 *     })
 *   },
 * }
 * ```
 */
export interface Extension {
  /** Unique name for this extension (used in error reporting and ordering). */
  name: string;
  /** Called when the extension is installed via `agent.use()`. */
  install(agent: Agent): void;
  /**
   * Optional priority that controls hook execution order. Higher =
   * hooks run first within each lifecycle stage. Extensions with the
   * same priority retain registration order (stable sort). Default: 0.
   *
   * This applies to **all** registration paths:
   * - `agent.use(extension)` — hooks registered inside `install()`
   *   inherit the extension's priority.
   * - The extension loader (`loadExtensions` / `installExtensions`) —
   *   sorts extensions by priority before calling `use()`, and the
   *   priority is also passed through to each hook.
   * - Direct `agent.hook()` calls outside `use()` — look up the
   *   priority of an installed extension with a matching name, or
   *   default to 0.
   *
   * For directory-loaded extensions, the `priority` in
   * `extension.json` takes precedence over this field.
   *
   * Use this to ensure enrichment extensions (e.g. keyword extraction)
   * run before persistence extensions (e.g. session) without relying on
   * `use()` call order:
   *
   * ```typescript
   * const keywordLogger = { name: 'keyword-logger', priority: 10, install(a) { ... } };
   * const session = { name: 'session', priority: -100, install(a) { ... } };
   * // Hooks run keyword-logger first regardless of use() order.
   * agent.use(session).use(keywordLogger);
   * ```
   */
  priority?: number;
  /**
   * Optional cleanup method called when the extension is unloaded or
   * the agent shuts down. Use this to close connections, stop
   * processes, release resources, etc.
   */
  close?(): Promise<void>;
}
