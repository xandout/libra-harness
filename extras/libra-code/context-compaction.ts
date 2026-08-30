import type { Extension, Message } from '@xandout/libra-harness';

// ── Types ────────────────────────────────────────────────────────────
export interface CompactionConfig {
  /**
   * Maximum number of messages before compaction kicks in.
   * When the message count exceeds this, older messages are
   * summarized. Default: 40.
   */
  maxMessages?: number;
  /**
   * Number of recent messages to always keep verbatim (never compact).
   * This includes the current assistant turn, tool calls, and tool
   * results that are still in flight. Default: 12.
   */
  keepRecent?: number;
  /**
   * Maximum characters of a tool result to include verbatim. Longer
   * results are truncated with a notice. Default: 2000.
   */
  maxToolResultChars?: number;
  /**
   * Whether to truncate tool results on every LLM call (not just when
   * compaction triggers). Default: true. This keeps context small even
   * before the message threshold is reached.
   */
  alwaysTruncateToolResults?: boolean;
}

/**
 * Create a context-compaction extension.
 *
 * This extension reduces the amount of session data sent to the LLM
 * without halting the turn. It does two things:
 *
 * 1. **Truncates large tool results** — tool outputs (file reads, grep,
 *    exec, etc.) are capped at `maxToolResultChars`. This runs on every
 *    `beforeLLM` call so context stays small even mid-turn.
 *
 * 2. **Compacts old messages** — when the message count exceeds
 *    `maxMessages`, older messages (beyond the `keepRecent` window) are
 *    replaced with a compact summary. This runs on `beforeLLM` so it
 *    happens between iterations without halting.
 *
 * The compaction preserves:
 * - The system prompt (not in messages, handled separately)
 * - The most recent `keepRecent` messages verbatim
 * - Tool-call/tool-result pairing integrity (we never split a call
 *   from its result — we compact in whole conversation turns)
 *
 * The compaction strategy for old messages:
 * - User messages: kept as-is (they're usually short)
 * - Assistant messages with text: truncated to first 200 chars
 * - Assistant messages with tool calls: replaced with a one-line summary
 * - Tool results: replaced with a one-line summary
 */
export function createContextCompaction(config?: CompactionConfig): Extension {
  const maxMessages = config?.maxMessages ?? 40;
  const keepRecent = config?.keepRecent ?? 12;
  const maxToolResultChars = config?.maxToolResultChars ?? 2000;
  const alwaysTruncate = config?.alwaysTruncateToolResults ?? true;

  return {
    name: 'context-compaction',
    priority: 80, // Run after session loading but before the LLM call

    install(agent) {
      agent.hook('beforeLLM', 'context-compaction', async (ctx) => {
        const messages = ctx.turn.messages;
        if (!messages || messages.length === 0) return;

        // ── Step 1: Truncate large tool results ────────────────────
        // This runs on every beforeLLM call to keep context small.
        if (alwaysTruncate) {
          truncateToolResults(messages, maxToolResultChars);
        }

        // ── Step 2: Compact old messages if over threshold ─────────
        if (messages.length > maxMessages) {
          compactOldMessages(messages, maxMessages, keepRecent);
        }
      });
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Get text content from a message (handles string and array content). */
function messageText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
  }
  return '';
}

/** Truncate a string to maxLen, adding a notice if cut. */
function truncateStr(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const kept = text.slice(0, maxLen);
  const totalLines = text.split('\n').length;
  const keptLines = kept.split('\n').length;
  return `${kept}\n… (${totalLines - keptLines} more lines, ${text.length - maxLen} more chars truncated)`;
}

/**
 * Truncate large tool result messages in place.
 * Only modifies `tool` role messages.
 */
function truncateToolResults(messages: Message[], maxChars: number): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool') continue;

    const text = messageText(msg);
    if (text.length <= maxChars) continue;

    // Replace content with truncated version.
    msg.content = truncateStr(text, maxChars);
  }
}

/**
 * Compact old messages in place.
 *
 * Keeps the last `keepRecent` messages verbatim. For older messages:
 * - User messages: kept (usually short)
 * - Assistant text: truncated to 200 chars
 * - Assistant with tool calls: replaced with summary
 * - Tool results: replaced with summary
 *
 * Important: we must preserve tool-call/tool-result pairing. If we
 * compact an assistant message that has tool calls, we must also
 * compact the corresponding tool result messages. We handle this by
 * grouping messages into "conversation turns" — each turn is either:
 *   - A standalone user/assistant message, or
 *   - An assistant message with tool calls + its tool result messages
 *
 * We compact whole turns, never splitting them.
 */
function compactOldMessages(
  messages: Message[],
  maxMsgs: number,
  keepRecent: number,
): void {
  // Group messages into conversation turns.
  const turns: { start: number; end: number; messages: Message[] }[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // Assistant message with tool calls — find matching tool results.
      const callIds = new Set(msg.toolCalls.map((tc) => tc.id));
      let end = i + 1;
      while (end < messages.length && messages[end].role === 'tool' && callIds.has(messages[end].toolCallId ?? '')) {
        end++;
      }
      turns.push({ start: i, end, messages: messages.slice(i, end) });
      i = end;
    } else {
      // Standalone message.
      turns.push({ start: i, end: i + 1, messages: [msg] });
      i++;
    }
  }

  // Determine how many recent turns to keep verbatim.
  // We want at least `keepRecent` messages kept, so we count backwards.
  let keptMsgCount = 0;
  let keptTurnStart = turns.length;
  for (let t = turns.length - 1; t >= 0; t--) {
    keptMsgCount += turns[t].messages.length;
    keptTurnStart = t;
    if (keptMsgCount >= keepRecent) break;
  }

  // Compact turns before keptTurnStart.
  // CRITICAL: We must preserve tool-call/tool-result pairing. If we
  // strip toolCalls from an assistant message but keep the matching
  // tool result messages, the LLM API will reject the sequence.
  // So for assistant+tool-call turns, we replace the ENTIRE turn
  // (assistant + all its tool results) with a single assistant text
  // summary. This keeps the message sequence valid.
  const compacted: Message[] = [];
  for (let t = 0; t < keptTurnStart; t++) {
    const turn = turns[t];

    // If this turn is an assistant+tool-call turn, collapse it.
    if (turn.messages.length > 1 && turn.messages[0].role === 'assistant' && turn.messages[0].toolCalls) {
      const asstMsg = turn.messages[0];
      const toolNames = (asstMsg.toolCalls ?? []).map((tc) => tc.name).join(', ');
      const text = messageText(asstMsg);
      // Build a summary from the tool results too.
      const toolSummaries: string[] = [];
      for (let m = 1; m < turn.messages.length; m++) {
        const tr = turn.messages[m];
        const trText = messageText(tr);
        const firstLine = trText.split('\n')[0].slice(0, 80);
        toolSummaries.push(`  ${tr.name}: ${firstLine}`);
      }
      const summary = text
        ? `[Previously called ${toolNames}: ${truncateStr(text, 100)}]\n${toolSummaries.join('\n')}`
        : `[Previously called ${toolNames}]\n${toolSummaries.join('\n')}`;
      compacted.push({
        role: 'assistant',
        content: summary,
      });
      // Do NOT push the tool result messages — they're summarized above.
      continue;
    }

    // Standalone messages.
    for (const msg of turn.messages) {
      if (msg.role === 'user') {
        // Keep user messages — they're usually short and important.
        compacted.push(msg);
      } else if (msg.role === 'assistant') {
        // Assistant text-only — truncate.
        const text = messageText(msg);
        compacted.push({
          role: 'assistant',
          content: truncateStr(text, 200),
        });
      } else if (msg.role === 'tool') {
        // This shouldn't happen (tool messages should be part of a
        // tool-call turn above), but handle it safely by dropping
        // orphaned tool messages — keeping them would break the API.
        // Skip.
      } else {
        // System or other — keep as-is.
        compacted.push(msg);
      }
    }
  }

  // Append the kept-recent messages verbatim.
  for (let t = keptTurnStart; t < turns.length; t++) {
    compacted.push(...turns[t].messages);
  }

  // Replace the messages array content in place.
  messages.length = 0;
  messages.push(...compacted);
}
