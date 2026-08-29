import type { Extension } from '../../../extension.js';
import { messageContentToText } from '../../../types.js';

/**
 * Log level for the logging extension.
 *
 * - `'info'` — turn start/finish, errors (high-level lifecycle)
 * - `'debug'` — per-LLM-call and per-tool-call details (verbose)
 */
export type LogLevel = 'info' | 'debug';

/**
 * Config for the logging extension.
 *
 * Passed by the extension loader from the host's config object.
 * Keys should be declared in extension.json's `configKeys`.
 */
export interface LoggingExtensionConfig {
  /**
   * Custom log function. Default: `console.log`.
   * Useful for routing logs to a file, transport, or structured logger.
   */
  logFunction?: (...args: unknown[]) => void;
  /**
   * Custom error function. Default: `console.error`.
   */
  errorFunction?: (...args: unknown[]) => void;
  /**
   * Prefix for log lines. Default: `"[logging]"`.
   */
  logPrefix?: string;
  /**
   * Minimum log level to emit. Default: `'info'`.
   *
   * Set to `'debug'` to see per-LLM-call and per-tool-call details.
   * If the `DEBUG` environment variable is set, defaults to `'debug'`.
   */
  level?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = { info: 0, debug: 1 };

/**
 * Logging extension — logs each lifecycle stage.
 *
 * Observes every hook stage (beforeTurn, beforeLLM, afterLLM, beforeTool,
 * afterTool, onError, afterTurn) without mutating anything. Accepts
 * optional config for custom log/error functions, a prefix, and a log level.
 *
 * Log levels:
 * - **info** (default): turn start/finish, errors
 * - **debug**: per-LLM-call and per-tool-call details
 *
 * If the `DEBUG` environment variable is set and no explicit `level` is
 * provided, the level defaults to `'debug'`.
 */
export default function createLoggingExtension(
  config?: LoggingExtensionConfig,
): Extension {
  const log = config?.logFunction ?? console.log;
  const error = config?.errorFunction ?? console.error;
  const prefix = config?.logPrefix ?? '[logging]';
  const level: LogLevel = config?.level ?? (process.env.DEBUG ? 'debug' : 'info');

  const shouldLog = (target: LogLevel): boolean =>
    LEVEL_ORDER[target] <= LEVEL_ORDER[level];

  return {
    name: 'logging',
    priority: 100,
    install(agent) {
      agent.hook('beforeTurn', 'logging', async (ctx) => {
        log(`${prefix} turn started`);
        if (shouldLog('debug')) {
          log(`${prefix} message: "${messageContentToText(ctx.turn.request.message)}"`);
        }
      });
      agent.hook('beforeLLM', 'logging', async (ctx) => {
        if (!shouldLog('debug')) return;
        log(`${prefix} LLM call #${ctx.turn.messages.length} messages`);
      });
      agent.hook('afterLLM', 'logging', async (ctx) => {
        if (!shouldLog('debug')) return;
        const calls = ctx.modelResponse?.message.toolCalls;
        if (calls?.length) {
          log(`${prefix} model requested tools: ${calls.map((c) => c.name).join(', ')}`);
        } else {
          log(`${prefix} model returned final response`);
        }
      });
      agent.hook('beforeTool', 'logging', async (ctx) => {
        if (!shouldLog('debug')) return;
        log(`${prefix} executing tool: ${ctx.toolCall?.name}`);
      });
      agent.hook('afterTool', 'logging', async (ctx) => {
        if (!shouldLog('debug')) return;
        log(`${prefix} tool result: ${ctx.toolResult?.content}`);
      });
      agent.hook('onError', 'logging', async (ctx) => {
        error(`${prefix} error:`, ctx.error);
      });
      agent.hook('afterTurn', 'logging', async (ctx) => {
        log(`${prefix} turn finished: ${ctx.turn.response?.finishReason}`);
      });
    },
  };
}
