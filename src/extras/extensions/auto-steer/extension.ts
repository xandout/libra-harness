import type { Extension } from '../../../extension.js';

/**
 * Config for the auto-steer extension.
 */
export interface AutoSteerConfig {
  /**
   * The max iterations the agent is configured for. The extension steers
   * at `threshold` iterations before this limit. Default: 25 (matching
   * the agent's default).
   */
  maxIterations?: number;
  /**
   * How many iterations before the limit to steer. Default: 3.
   * With maxIterations=25 and threshold=3, the steer fires at iteration 22.
   */
  threshold?: number;
  /**
   * The steering message to inject. Default: a prompt to wrap up.
   */
  steerMessage?: string;
}

/**
 * Create an auto-steer extension.
 *
 * Watches iteration count and steers the agent to wrap up when it's
 * approaching the max iterations limit. This prevents the agent from
 * hitting the limit with no response — instead of silently running out
 * of turns, the agent gets a nudge like "You're running low on turns,
 * summarize and respond now."
 *
 * Tracks iterations by counting `afterLLM` hook calls per turn. The
 * count resets on each `beforeTurn`.
 *
 * @example
 * ```typescript
 * import { createAutoSteerExtension } from 'libra-harness/extras/auto-steer';
 *
 * const autoSteer = createAutoSteerExtension({
 *   maxIterations: 15,
 *   threshold: 3,
 * });
 * agent.use(autoSteer);
 * ```
 */
export default function createAutoSteerExtension(
  config?: AutoSteerConfig,
): Extension {
  const maxIter = config?.maxIterations ?? 25;
  const threshold = config?.threshold ?? 3;
  const steerAt = maxIter - threshold;
  const message = config?.steerMessage ??
    "You're running low on turns. Stop calling tools and respond to the user now with what you have so far. Be concise.";

  let iterationCount = 0;
  let steered = false;

  return {
    name: 'auto-steer',
    priority: 90,
    install(agent) {
      // Reset counter at the start of each turn.
      agent.hook('beforeTurn', 'auto-steer', async () => {
        iterationCount = 0;
        steered = false;
      });

      // Count LLM calls and steer when approaching the limit.
      agent.hook('afterLLM', 'auto-steer', async (ctx) => {
        iterationCount++;

        if (!steered && iterationCount >= steerAt) {
          steered = true;
          ctx.turn.steer(message);
        }
      });
    },
  };
}
