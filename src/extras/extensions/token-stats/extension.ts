import type { Extension } from '../../../extension.js';

/**
 * Config for the token-stats extension.
 */
export interface TokenStatsConfig {
  /**
   * The model's maximum context window in tokens. Used to compute the
   * context window usage percentage. If omitted, the percentage is
   * not shown. Default: not set.
   *
   * For DeepSeek v4: 131072 (128K). Check your provider's docs.
   */
  contextWindow?: number;
  /**
   * Whether to use Slack italic formatting (`_text_`) for the stats
   * line. Default: `true`.
   */
  slackItalics?: boolean;
  /**
   * Label for the stats line. Default: `📊`.
   */
  label?: string;
}

// Metadata key for accumulated usage across LLM calls in a turn.
const USAGE_KEY = '_tokenStats_usage';

interface AccumulatedUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  calls: number;
}

/**
 * Token-stats extension — appends a stats line to the agent's final
 * response message.
 *
 * Accumulates token usage across all LLM calls in a turn (via
 * `afterLLM`), then appends a summary to `turn.response.message` in
 * `beforeResponse`. The stats include:
 *
 * - Total prompt + completion tokens
 * - Cached and reasoning tokens (if reported)
 * - Number of LLM calls / iterations
 * - Context window usage percentage (if `contextWindow` is configured)
 *
 * ## Example output (Slack italics)
 *
 * ```
 * _📊 105,445 prompt + 2,324 completion · 1,503 reasoning · 3 LLM calls · 82% of 128K context_
 * ```
 *
 * ## Priority
 *
 * Uses priority -100 (runs late, after most extensions) so it sees
 * the final response after other extensions have potentially modified
 * it. The `afterLLM` accumulator runs at the same priority.
 */
export default function createTokenStatsExtension(
  config?: TokenStatsConfig,
): Extension {
  const contextWindow = config?.contextWindow;
  const slackItalics = config?.slackItalics ?? true;
  const label = config?.label ?? '📊';

  return {
    name: 'token-stats',
    priority: -100,
    install(agent) {
      // ── afterLLM: accumulate usage ────────────────────────────────
      agent.hook('afterLLM', 'token-stats', async (ctx) => {
        const usage = ctx.modelResponse?.usage;
        if (!usage) return;

        const meta = ctx.turn.metadata;
        const acc = (meta[USAGE_KEY] as AccumulatedUsage) ?? {
          promptTokens: 0,
          completionTokens: 0,
          cachedPromptTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          calls: 0,
        };

        acc.promptTokens += usage.promptTokens ?? 0;
        acc.completionTokens += usage.completionTokens ?? 0;
        acc.cachedPromptTokens += usage.cachedPromptTokens ?? 0;
        acc.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
        acc.reasoningTokens += usage.reasoningTokens ?? 0;
        acc.calls += 1;

        meta[USAGE_KEY] = acc;
      });

      // ── beforeResponse: append stats to the final message ─────────
      agent.hook('beforeResponse', 'token-stats', async (ctx) => {
        const response = ctx.turn.response;
        if (!response) return;

        const acc = ctx.turn.metadata[USAGE_KEY] as AccumulatedUsage | undefined;
        if (!acc || acc.calls === 0) return;

        const parts: string[] = [
          `${fmt(acc.promptTokens)} prompt + ${fmt(acc.completionTokens)} completion`,
        ];

        if (acc.cachedPromptTokens > 0 || acc.cacheWriteTokens > 0) {
          const cacheParts: string[] = [];
          if (acc.cachedPromptTokens > 0) cacheParts.push(`${fmt(acc.cachedPromptTokens)} read`);
          if (acc.cacheWriteTokens > 0) cacheParts.push(`${fmt(acc.cacheWriteTokens)} written`);
          parts.push(`cache: ${cacheParts.join(', ')}`);
        }
        if (acc.reasoningTokens > 0) {
          parts.push(`${fmt(acc.reasoningTokens)} reasoning`);
        }

        parts.push(`${acc.calls} LLM call${acc.calls > 1 ? 's' : ''}`);

        if (contextWindow) {
          const pct = ((acc.promptTokens / contextWindow) * 100).toFixed(0);
          parts.push(`${pct}% of ${fmt(contextWindow)} context`);
        }

        const line = parts.join(' · ');
        const formatted = slackItalics ? `_${label} ${line}_` : `${label} ${line}`;

        response.message = `${response.message}\n\n${formatted}`;
      });
    },
  };
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
