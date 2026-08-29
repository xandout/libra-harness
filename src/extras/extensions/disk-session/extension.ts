import { readFileSync, appendFileSync, mkdirSync, readdirSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Extension } from '@xandout/libra-harness';
import type { Message, MessageContent, Role, ToolCall } from '@xandout/libra-harness';

/**
 * A single record in a session's JSONL log.
 *
 * Maps directly to a Message plus correlation metadata. The system
 * prompt that was active for a turn is captured on the user record's
 * `systemPrompt` field. Background channel messages (observed but not
 * directed at the agent) are stored as `system` records so the agent
 * sees them as context, not as messages to respond to.
 */
export interface SessionRecord {
  role: 'user' | 'assistant' | 'tool' | 'control' | 'system';
  content: MessageContent;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  /** Message correlation id (e.g. a Slack message timestamp, a Discord message id). */
  ts: string;
  /** Thread parent correlation id — undefined for top-level messages. */
  threadTs?: string;
  /** ISO timestamp for internal tracking. */
  recordedAt: string;
  /**
   * The system prompt that was active for this turn. Persisted on the
   * user record (the first record of each turn) so every turn's JSONL
   * entry shows exactly what instructions the model was operating under.
   * Absent on assistant, tool, and control records. Lets you audit
   * "why did the model respond this way?" without replaying config +
   * extension state.
   */
  systemPrompt?: string;
  /** Token usage from the LLM provider (accumulated across iterations). */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    iterations: number;
    /** Prompt tokens served from provider cache (accumulated). */
    cachedPromptTokens?: number;
    /** Reasoning/thinking tokens (accumulated). */
    reasoningTokens?: number;
  };
  /**
   * Generic enrichment bag. Populated opaquely from
   * `ctx.turn.metadata.sessionMeta` — any extension may write into
   * that metadata key during `beforeTurn`/`afterLLM` and disk-session
   * persists it here without inspecting the contents. Keys are owned
   * by the extension that writes them (e.g. `keywords`, `sentiment`).
   */
  meta?: Record<string, unknown>;
}

/**
 * Identifies which session a turn belongs to.
 *
 * The host (or a resolver) produces this from turn metadata — the
 * disk-session extension never reads host-specific types directly.
 */
export interface SessionIdentity {
  /** Stable session key — used as the JSONL filename and in-memory cache key. e.g. 'slack_C1', 'dm_U1', 'issue_42'.
   * Should be filesystem-safe (alphanumeric, underscore, hyphen). Characters outside [a-zA-Z0-9_-] are replaced with '_' for the filename, so keys with colons or dots won't round-trip identically through a restart. */
  key: string;
  /** Correlation id for the incoming message (persisted as `record.ts`). */
  messageTs: string;
  /** Parent correlation id — when set, this message is a reply in a thread/sub-conversation. Persisted as `record.threadTs` and used as the context fork point. */
  threadTs?: string;
  /** True for 1:1 conversations (DMs) — disables thread forking, uses simple last-N history. */
  isDirect?: boolean;
}

/**
 * Extracts a {@link SessionIdentity} from turn metadata.
 *
 * The host supplies a resolver so disk-session doesn't need to know
 * about Slack channels, Discord channels, or any other host concept.
 * Return `undefined` to skip session handling for a turn.
 */
export interface SessionResolver {
  resolve(metadata: Record<string, unknown>): SessionIdentity | undefined;
}

export interface DiskSessionConfig {
  /** Directory for session JSONL files. Default: ./sessions */
  sessionDir?: string;
  /**
   * Max records to keep in memory per session. Older records are
   * evicted from the cache but remain in the JSONL file.
   * Default: 1000.
   */
  maxRecords?: number;
  /**
   * Max messages to include in the agent's context per turn.
   * Default: 50.
   */
  maxContextMessages?: number;
  /**
   * Number of top-level (non-thread) messages to include as channel
   * context when forking a thread. These are messages that came BEFORE
   * the thread parent — what the channel was discussing when the thread
   * started. Default: 10.
   */
  channelContextMessages?: number;
  /**
   * Number of recent top-level messages to include after the last thread
   * reply. This gives the agent awareness of what's happened in the
   * channel since the thread was last active (e.g. if someone comes back
   * to a thread a week later, the agent sees recent channel activity).
   * Default: 5.
   */
  recentChannelMessages?: number;
  /** Load existing JSONL files into memory on startup. Default: true. */
  loadOnStartup?: boolean;
  /**
   * Resolve a {@link SessionIdentity} from turn metadata. Default:
   * reads `metadata.session` as a `SessionIdentity`, falls back to
   * `metadata.sessionId` as a plain key, then to `'default'`.
   */
  resolver?: SessionResolver;
}

/**
 * Default resolver: reads `metadata.session` as a `SessionIdentity`,
 * falls back to `metadata.sessionId` as a plain key, then to `'default'`.
 */
const defaultResolver: SessionResolver = {
  resolve(metadata) {
    const session = metadata.session as SessionIdentity | undefined;
    if (session && typeof session.key === 'string') return session;
    const sessionId = metadata.sessionId as string | undefined;
    if (sessionId) return { key: sessionId, messageTs: '' };
    return { key: 'default', messageTs: '' };
  },
};

/**
 * Disk-backed session extension.
 *
 * ## Architecture
 *
 * **One JSONL file per session** (`<sessionKey>.jsonl`). Append-only —
 * every message the agent sees (human or bot, top-level or threaded) is
 * appended. This log is the source of truth.
 *
 * **Snapshot at beforeTurn**: when a turn starts, the extension takes a
 * read-only snapshot of the session log at that moment. The turn runs
 * against the snapshot. Concurrent turns each take their own snapshot
 * and don't see each other's in-progress work.
 *
 * **Fork for threads**: when a thread reply comes in (identity has
 * `threadTs`), the snapshot is filtered to include only:
 *   1. Top-level messages before the thread parent (channel context)
 *   2. All messages in that thread (parent + replies)
 *   3. Recent top-level messages after the last thread reply
 *
 * **Append after turn**: when the turn finishes, new messages (user +
 * assistant + tool calls) are appended to the session log. No data is
 * ever rewritten or reordered.
 *
 * **Stable prefix for LLM caching**: the messages array is built as
 *   [system prompt] + [stable session history] + [new user message]
 * The session history grows monotonically (append-only), so earlier
 * tokens stay cached upstream. Per-turn metadata is injected at the end
 * of the context (by a host-side `beforeContext` hook), not the
 * beginning, to preserve the cache prefix.
 *
 * ## Host integration
 *
 * The host supplies a {@link SessionResolver} (or writes
 * `metadata.session`) so the extension knows which session a turn
 * belongs to. The extension itself is host-agnostic — it doesn't know
 * about Slack, Discord, or any other platform.
 */
export default function createDiskSessionExtension(
  config?: DiskSessionConfig,
): Extension & {
  getRecords(sessionKey?: string): SessionRecord[];
  getSessions(): string[];
  clear(sessionKey?: string): void;
  clearAll(): void;
  appendControl(sessionKey: string, content: string, ts?: string, threadTs?: string): void;
  appendMessage(sessionKey: string, content: string, opts?: {
    ts?: string;
    threadTs?: string;
    meta?: Record<string, unknown>;
  }): void;
} {
  const dir = config?.sessionDir ?? './sessions';
  const maxRecords = config?.maxRecords ?? 1000;
  const maxContextMessages = config?.maxContextMessages ?? 50;
  const channelContextMessages = config?.channelContextMessages ?? 10;
  const recentChannelMessages = config?.recentChannelMessages ?? 5;
  const loadOnStartup = config?.loadOnStartup ?? true;
  const resolver = config?.resolver ?? defaultResolver;

  mkdirSync(dir, { recursive: true });

  // In-memory cache: sessionKey → SessionRecord[]
  // This is the live log. Reads take a snapshot (copy); writes append.
  const store = new Map<string, SessionRecord[]>();

  // ── Load existing sessions from disk ──────────────────────────
  if (loadOnStartup) {
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      let totalRecords = 0;
      for (const file of files) {
        try {
          const raw = readFileSync(join(dir, file), 'utf-8');
          const lines = raw.split('\n').filter((l) => l.trim());
          const records = lines.map((l) => JSON.parse(l) as SessionRecord);
          const sessionKey = file.replace(/\.jsonl$/, '');
          store.set(sessionKey, records.slice(-maxRecords));
          totalRecords += records.length;
        } catch {
          // Skip corrupt files.
        }
      }
      if (store.size > 0) {
        console.log(
          `[disk-session] loaded ${store.size} session(s), ${totalRecords} record(s) from ${dir}`,
        );
      }
    } catch {
      // Directory doesn't exist — start empty.
    }
  }

  function filePath(sessionKey: string): string {
    const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(dir, `${safe}.jsonl`);
  }

  function appendToFile(sessionKey: string, records: SessionRecord[]): void {
    if (records.length === 0) return;
    const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    try {
      appendFileSync(filePath(sessionKey), lines);
    } catch (err) {
      console.error(`[disk-session] failed to append to ${sessionKey}:`, err);
    }
  }

  // ── Convert between Message and SessionRecord ──────────────────
  function toMessage(r: SessionRecord): Message {
    return {
      // `toMessage` is only called on records that passed
      // `isConversationMessage`, which excludes 'control' (and 'tool').
      role: r.role as Role,
      content: r.content,
      ...(r.toolCalls ? { toolCalls: r.toolCalls } : {}),
      ...(r.toolCallId ? { toolCallId: r.toolCallId } : {}),
      ...(r.name ? { name: r.name } : {}),
    };
  }

  function toRecord(msg: Message, ts: string, threadTs?: string): SessionRecord {
    return {
      role: msg.role as SessionRecord['role'],
      content: msg.content,
      ...(msg.toolCalls ? { toolCalls: msg.toolCalls } : {}),
      ...(msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
      ...(msg.name ? { name: msg.name } : {}),
      ts,
      ...(threadTs ? { threadTs } : {}),
      recordedAt: new Date().toISOString(),
    };
  }

  // Filter for context windows: only keep user messages, system
  // messages (background channel context), and assistant messages with
  // text content (not tool-call intermediates or control records).
  // Tool messages, control records, and assistant messages that only
  // contain toolCalls are turn-internal mechanics — including them
  // without the full tool-call flow produces invalid message sequences
  // for the LLM. Control records (e.g. /halt) are persisted for audit
  // but never shown to the model.
  const isConversationMessage = (r: SessionRecord): boolean => {
    if (r.role === 'tool') return false;
    if (r.role === 'control') return false;
    // Drop any assistant message that has tool_calls — even if it also
    // has text content. Keeping it without the matching tool response
    // messages produces an invalid sequence for the LLM.
    if (r.role === 'assistant' && r.toolCalls?.length) return false;
    return true; // user, system, assistant (without tool calls)
  };

  // ── Build context (the "fork") from a snapshot ────────────────
  // The snapshot is a read-only copy of the session records at the
  // moment the turn started. This function builds the messages array
  // that the agent will see.
  //
  // For top-level messages and DMs: last N records (simple slice).
  // For thread replies: channel context before parent + thread history.
  function buildContext(
    snapshot: SessionRecord[],
    threadTs: string | undefined,
    isDirect: boolean,
  ): Message[] {
    if (snapshot.length === 0) return [];

    // DM or top-level message: last N messages, but filter out
    // tool-call intermediates that might get split by the slice.
    if (isDirect || !threadTs) {
      return snapshot
        .filter(isConversationMessage)
        .slice(-maxContextMessages)
        .map(toMessage);
    }

    // Thread: fork from channel context.
    const parentIdx = snapshot.findIndex((r) => r.ts === threadTs);

    if (parentIdx === -1) {
      // Parent not in snapshot (evicted from cache or very old).
      // Fall back to last N messages.
      return snapshot
        .filter(isConversationMessage)
        .slice(-maxContextMessages)
        .map(toMessage);
    }

    // Top-level messages before the parent (channel context at fork point).
    const topLevelBefore = snapshot
      .slice(0, parentIdx)
      .filter((r) => !r.threadTs && isConversationMessage(r))
      .slice(-channelContextMessages);

    // All messages in this thread (including the parent).
    // Filter out tool-call intermediates — they produce invalid message
    // sequences if they get split or truncated by the context window.
    const threadMessages = snapshot
      .filter(
        (r) => (r.ts === threadTs || r.threadTs === threadTs) && isConversationMessage(r),
      );

    // Recent top-level messages after the last thread reply.
    // This gives the agent awareness of what's happened in the channel
    // since the thread was last active — without pulling in the entire
    // channel history. Find the last thread message's index in the
    // snapshot by ts, then take top-level messages after it.
    const lastThreadTs = threadMessages[threadMessages.length - 1]?.ts ?? threadTs;
    let lastThreadIdx = parentIdx;
    for (let i = snapshot.length - 1; i >= 0; i--) {
      if (snapshot[i].ts === lastThreadTs) {
        lastThreadIdx = i;
        break;
      }
    }
    const recentTopLevel = recentChannelMessages > 0
      ? snapshot
          .slice(lastThreadIdx + 1)
          .filter((r) => !r.threadTs && isConversationMessage(r))
          .slice(-recentChannelMessages)
      : [];

    return [...topLevelBefore, ...threadMessages, ...recentTopLevel].map(toMessage);
  }

  // ── Resolve session identity from turn metadata ───────────────
  function identityFromCtx(ctx: { turn: { request: { metadata?: Record<string, unknown> } } }): SessionIdentity | undefined {
    return resolver.resolve(ctx.turn.request.metadata ?? {});
  }

  return {
    name: 'disk-session',
    priority: -100,
    install(agent) {
      // ── beforeTurn: take snapshot, build context, prepend ─────
      // The snapshot is a copy of the session records at this moment.
      // Concurrent turns each get their own snapshot — they don't
      // see each other's in-progress work.
      agent.hook('beforeTurn', 'disk-session', async (ctx) => {
        const identity = identityFromCtx(ctx);
        if (!identity) return;
        const { key, messageTs, threadTs, isDirect } = identity;
        const isDm = isDirect ?? false;

        // Snapshot: copy the current records (read-only).
        const liveRecords = store.get(key) ?? [];
        const snapshot = [...liveRecords];

        // Build the forked context from the snapshot.
        const history = buildContext(snapshot, threadTs, isDm);

        // ── Persist the user message immediately ────────────────
        // Write the incoming user message to disk NOW, before the
        // agent runs. If the process crashes mid-turn, the user's
        // message is already saved. The assistant response is
        // appended later in afterTurn.
        //
        // The system prompt is captured at afterTurn (not here) because
        // beforeContext hooks (which run after beforeTurn) may modify
        // ctx.turn.systemPrompt. Recording it here would miss those
        // modifications. See afterTurn for the capture.
        //
        // Enrichment bag: any extension that ran before us in
        // beforeTurn may have written into `sessionMeta`. We persist
        // it opaquely — disk-session does not inspect the contents.
        const sessionMeta = ctx.turn.metadata.sessionMeta as
          | Record<string, unknown>
          | undefined;
        const userRecord = {
          ...toRecord(
            { role: 'user', content: ctx.turn.request.message },
            messageTs,
            threadTs,
          ),
          ...(sessionMeta ? { meta: sessionMeta } : {}),
        };
        const records = store.get(key) ?? [];
        records.push(userRecord);
        if (records.length > maxRecords) {
          records.splice(0, records.length - maxRecords);
        }
        store.set(key, records);
        appendToFile(key, [userRecord]);

        // Track how many history messages we prepended so afterTurn
        // knows where new messages start. +1 for the user message
        // we just added to the log (it's in the snapshot but not in
        // the history we built — the history was built from the
        // snapshot BEFORE adding the user record).
        ctx.turn.metadata['_diskSessionHistoryLen'] = history.length;

        if (history.length > 0) {
          ctx.turn.messages = [...history, ...ctx.turn.messages];
        }
      });

      // ── afterLLM: accumulate token usage across iterations ─────
      // Each LLM call returns usage (prompt/completion tokens). We
      // accumulate them across all iterations in the turn so the final
      // assistant record has the total cost.
      agent.hook('afterLLM', 'disk-session', async (ctx) => {
        const usage = ctx.modelResponse?.usage;
        if (!usage) return;
        const prev = (ctx.turn.metadata['_diskSessionUsage'] as {
          promptTokens: number;
          completionTokens: number;
          iterations: number;
          cachedPromptTokens?: number;
          reasoningTokens?: number;
        }) ?? { promptTokens: 0, completionTokens: 0, iterations: 0 };
        ctx.turn.metadata['_diskSessionUsage'] = {
          promptTokens: prev.promptTokens + usage.promptTokens,
          completionTokens: prev.completionTokens + usage.completionTokens,
          iterations: prev.iterations + 1,
          ...(usage.cachedPromptTokens && {
            cachedPromptTokens: (prev.cachedPromptTokens ?? 0) + usage.cachedPromptTokens,
          }),
          ...(usage.reasoningTokens && {
            reasoningTokens: (prev.reasoningTokens ?? 0) + usage.reasoningTokens,
          }),
        };
      });

      // ── afterTurn: append assistant response + tool calls ─────
      // The user message was already persisted in beforeTurn.
      // Here we only append the NEW non-user, non-system messages
      // (assistant responses, tool calls, tool results).
      agent.hook('afterTurn', 'disk-session', async (ctx) => {
        const identity = identityFromCtx(ctx);
        if (!identity) return;
        const { key, messageTs, threadTs } = identity;

        const historyLen = (ctx.turn.metadata['_diskSessionHistoryLen'] as number) ?? 0;
        delete ctx.turn.metadata['_diskSessionHistoryLen'];

        // ── Compaction: rotate the session file ──────────────────
        // When metadata.compacting is set, this turn was a compaction
        // request (triggered by /compact). The agent's response is the
        // summary. Instead of appending to the old session, we:
        //   1. Rename the old JSONL file with a timestamp suffix
        //   2. Seed a new session with the summary as the first record
        // The compaction request/response are already in the old file
        // (written by beforeTurn + the normal append below would have
        // run, but we return early before that).
        const isCompacting = ctx.turn.request.metadata?.compacting === true;

        if (isCompacting) {
          const summary = ctx.turn.response?.message ?? '';

          // Archive the old file with a timestamp suffix.
          const oldPath = filePath(key);
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const archivedName = `${key.replace(/[^a-zA-Z0-9_-]/g, '_')}_${timestamp}.jsonl`;
          const archivedPath = join(dir, archivedName);

          if (existsSync(oldPath)) {
            renameSync(oldPath, archivedPath);
          }

          // Seed the new session with the summary.
          const summaryRecord: SessionRecord = {
            role: 'assistant',
            content: `[Session summary — prior conversation compacted ${new Date().toISOString()}]\n\n${summary}`,
            ts: messageTs || String(Date.now() / 1000),
            recordedAt: new Date().toISOString(),
          };

          store.set(key, [summaryRecord]);
          appendToFile(key, [summaryRecord]);

          // Store the archived filename so the host can report it.
          ctx.turn.metadata['_compactArchivedFile'] = archivedName;
          return;
        }

        // Messages: [history...] [system?] [user msg] [assistant] [tool calls...]
        // The beforeContext hook may have inserted a system message.
        // Skip it when counting new messages.
        const systemMsgCount = ctx.turn.messages[historyLen]?.role === 'system' ? 1 : 0;
        const newStart = historyLen + systemMsgCount;
        const newMessages = ctx.turn.messages.slice(newStart);

        // Only persist non-user, non-system messages here.
        // The user message was already written in beforeTurn.
        const filteredMessages = newMessages.filter(
          (m) => m.role !== 'system' && m.role !== 'user',
        );

        if (filteredMessages.length === 0) return;

        // Pull accumulated usage for this turn (set by afterLLM hook).
        const usage = ctx.turn.metadata['_diskSessionUsage'] as SessionRecord['usage'] | undefined;
        delete ctx.turn.metadata['_diskSessionUsage'];

        // Enrichment bag (same convention as beforeTurn): any
        // extension may have written into `sessionMeta` during the
        // turn. Persist it opaquely on each new record.
        const sessionMeta = ctx.turn.metadata.sessionMeta as
          | Record<string, unknown>
          | undefined;

        // Convert to records with correlation metadata.
        const newRecords = filteredMessages.map((msg) => {
          const record = {
            ...toRecord(msg, messageTs, threadTs),
            ...(sessionMeta ? { meta: sessionMeta } : {}),
          };
          // Attach usage to the LAST assistant record (the final response).
          // Intermediate assistant records (tool-call requests) don't get usage.
          return record;
        });

        // Attach accumulated usage to the last assistant record.
        if (usage) {
          let lastAssistantIdx = -1;
          for (let i = newRecords.length - 1; i >= 0; i--) {
            if (newRecords[i].role === 'assistant') {
              lastAssistantIdx = i;
              break;
            }
          }
          if (lastAssistantIdx !== -1) {
            newRecords[lastAssistantIdx].usage = usage;
          }
        }

        // Append to in-memory log.
        const records = store.get(key) ?? [];
        records.push(...newRecords);

        // ── Backfill system prompt on the last user record ───────
        // The system prompt wasn't available at beforeTurn (beforeContext
        // hooks hadn't run yet). Now it's final, so update the last user
        // record in the in-memory store and append a correction record
        // to the JSONL so the audit trail has the complete prompt.
        const finalSystemPrompt = ctx.turn.systemPrompt;
        if (finalSystemPrompt) {
          for (let i = records.length - 1; i >= 0; i--) {
            if (records[i].role === 'user') {
              records[i].systemPrompt = finalSystemPrompt;
              break;
            }
          }
          // Append a lightweight audit record so the JSONL file also
          // has the final system prompt (the user record in the file
          // was written without it at beforeTurn).
          appendToFile(key, [{
            role: 'control',
            content: '',
            recordedAt: new Date().toISOString(),
            systemPrompt: finalSystemPrompt,
          } as SessionRecord]);
        }

        // Trim in-memory cache (file keeps full history).
        if (records.length > maxRecords) {
          records.splice(0, records.length - maxRecords);
        }
        store.set(key, records);

        // Append to JSONL file (append-only, never rewritten).
        appendToFile(key, newRecords);
      });
    },

    /** Get all records for a session. */
    getRecords(sessionKey: string = 'default'): SessionRecord[] {
      return store.get(sessionKey) ?? [];
    },

    /**
     * Append a control record (e.g. /halt) to the session log.
     * Control records are persisted to disk but never included in the
     * LLM context — they're for audit/logging only.
     */
    appendControl(sessionKey: string, content: string, ts?: string, threadTs?: string): void {
      const record: SessionRecord = {
        role: 'control',
        content,
        ts: ts ?? String(Date.now() / 1000),
        ...(threadTs ? { threadTs } : {}),
        recordedAt: new Date().toISOString(),
      };
      const records = store.get(sessionKey);
      if (records) {
        records.push(record);
        if (records.length > maxRecords) {
          store.set(sessionKey, records.slice(-maxRecords));
        }
      } else {
        store.set(sessionKey, [record]);
      }
      appendToFile(sessionKey, [record]);
    },

    /**
     * Append a background message to the session log. Stored as a
     * `system` record so the agent sees it as context ("here's what
     * the channel discussed") rather than a message to respond to.
     *
     * Unlike `appendControl`, system records ARE included in the LLM
     * context window — they appear in the conversation history when
     * the agent is triggered, giving it awareness of recent channel
     * activity without needing to be mentioned on every message.
     *
     * The host should include sender info in the content (e.g.
     * `[U123]: hey anyone seen the invoice?`) so the agent can
     * distinguish who said what. Additional metadata (files, blocks,
     * etc.) goes in `opts.meta` and is persisted to the JSONL for
     * audit/debugging but not shown to the LLM.
     */
    appendMessage(
      sessionKey: string,
      content: string,
      opts?: { ts?: string; threadTs?: string; meta?: Record<string, unknown> },
    ): void {
      const record: SessionRecord = {
        role: 'system',
        content,
        ts: opts?.ts ?? String(Date.now() / 1000),
        ...(opts?.threadTs ? { threadTs: opts.threadTs } : {}),
        recordedAt: new Date().toISOString(),
        ...(opts?.meta ? { meta: opts.meta } : {}),
      };
      const records = store.get(sessionKey);
      if (records) {
        records.push(record);
        if (records.length > maxRecords) {
          store.set(sessionKey, records.slice(-maxRecords));
        }
      } else {
        store.set(sessionKey, [record]);
      }
      appendToFile(sessionKey, [record]);
    },

    /** List all session keys. */
    getSessions(): string[] {
      return Array.from(store.keys());
    },

    /** Clear a single session (memory + disk). */
    clear(sessionKey: string = 'default') {
      store.delete(sessionKey);
      const path = filePath(sessionKey);
      if (existsSync(path)) {
        try {
          writeFileSync(path, '');
        } catch {
          // ignore
        }
      }
    },

    /** Clear all sessions. */
    clearAll() {
      for (const key of store.keys()) {
        const path = filePath(key);
        if (existsSync(path)) {
          try {
            writeFileSync(path, '');
          } catch {
            // ignore
          }
        }
      }
      store.clear();
    },
  };
}
