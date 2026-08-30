import type { Extension } from '@xandout/libra-harness';

// ── Types ────────────────────────────────────────────────────────────
export interface SessionStats {
  /** Total prompt tokens across all LLM calls (cumulative). */
  promptTokens: number;
  /** Total completion tokens across all LLM calls (cumulative). */
  completionTokens: number;
  /** Cached prompt tokens (cache reads). */
  cachedPromptTokens: number;
  /** Cache write tokens. */
  cacheWriteTokens: number;
  /** Reasoning/thinking tokens. */
  reasoningTokens: number;
  /** Total LLM calls this session. */
  llmCalls: number;
  /** Total turns this session. */
  turns: number;
  /** Total tool calls this session. */
  toolCalls: number;
  /** Tool errors this session. */
  toolErrors: number;
  /** Last prompt token count from the most recent LLM call. */
  lastPromptTokens: number;
  /** Last completion token count from the most recent LLM call. */
  lastCompletionTokens: number;
}

function snapshot(stats: SessionStats) {
  return {
    promptTokens: stats.promptTokens,
    completionTokens: stats.completionTokens,
    cachedPromptTokens: stats.cachedPromptTokens,
    cacheWriteTokens: stats.cacheWriteTokens,
    reasoningTokens: stats.reasoningTokens,
    llmCalls: stats.llmCalls,
    turns: stats.turns,
    toolCalls: stats.toolCalls,
    toolErrors: stats.toolErrors,
    lastPromptTokens: stats.lastPromptTokens,
    lastCompletionTokens: stats.lastCompletionTokens,
  };
}

export function createSessionStats(
  stats: SessionStats,
): Extension {
  return {
    name: 'session-stats',
    priority: 95,
    install(agent) {
      // Track turns.
      agent.hook('beforeTurn', 'session-stats', async (ctx) => {
        stats.turns += 1;
        // Write stats to journal if available (worker mode).
        const journal = ctx.turn.metadata['__journal'] as any;
        journal?.append('stats', { stats: snapshot(stats) });
      });

      // Accumulate token usage from each LLM call.
      agent.hook('afterLLM', 'session-stats', async (ctx) => {
        const usage = ctx.modelResponse?.usage;
        if (!usage) return;

        stats.promptTokens += usage.promptTokens ?? 0;
        stats.completionTokens += usage.completionTokens ?? 0;
        stats.cachedPromptTokens += usage.cachedPromptTokens ?? 0;
        stats.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
        stats.reasoningTokens += usage.reasoningTokens ?? 0;
        stats.llmCalls += 1;
        stats.lastPromptTokens = usage.promptTokens ?? 0;
        stats.lastCompletionTokens = usage.completionTokens ?? 0;

        // Write stats to journal if available (worker mode).
        const journal = ctx.turn.metadata['__journal'] as any;
        journal?.append('stats', { stats: snapshot(stats) });
      });

      // Track tool calls.
      agent.hook('afterTool', 'session-stats', async (ctx) => {
        const toolResult = ctx.toolResult;
        if (!toolResult) return;
        stats.toolCalls += 1;
        if (toolResult.isError) stats.toolErrors += 1;

        // Write stats to journal if available (worker mode).
        const journal = ctx.turn.metadata['__journal'] as any;
        journal?.append('stats', { stats: snapshot(stats) });
      });
    },
  };
}
