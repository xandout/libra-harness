import type { Extension } from '../../extension.js';
import type { Model } from '../../model.js';
import type { Message } from '../../types.js';
import { messageContentToText } from '../../types.js';
import {
  SessionLedger,
  type LedgerUsage,
  type MessageLedgerRecord,
  type SessionRecord,
} from './ledger.js';
import {
  applyCheckpoint,
  compactionChunk,
  latestCheckpoint,
  projectContext,
  scopeKey,
  selectScope,
  transcriptForSummary,
  type ProjectionPolicy,
} from './projector.js';

export interface SessionIdentity {
  key: string;
  messageTs: string;
  threadTs?: string;
  isDirect?: boolean;
}

export interface SessionResolver {
  resolve(metadata: Record<string, unknown>): SessionIdentity | undefined;
}

export interface DiskSessionConfig {
  sessionDir?: string;
  maxContextMessages?: number;
  autoSummarize?: boolean;
  model?: Model;
  channelContextMessages?: number;
  recentChannelMessages?: number;
  toolCallRetention?: number;
  verbose?: boolean;
  resolver?: SessionResolver;
}

export interface DiskSessionExtension extends Extension {
  getRecords(sessionKey?: string): SessionRecord[];
  getSessions(): string[];
  appendControl(sessionKey: string, content: string, ts?: string, threadTs?: string): void;
  appendMessage(sessionKey: string, content: string, opts?: {
    ts?: string;
    threadTs?: string;
    meta?: Record<string, unknown>;
  }): void;
}

const defaultResolver: SessionResolver = {
  resolve(metadata) {
    const session = metadata.session as SessionIdentity | undefined;
    if (session && typeof session.key === 'string') return session;
    const sessionId = metadata.sessionId;
    if (typeof sessionId === 'string' && sessionId) return { key: sessionId, messageTs: '' };
    return { key: 'default', messageTs: '' };
  },
};

export async function generateSessionSummary(
  model: Model,
  records: MessageLedgerRecord[],
): Promise<{ content: string; usage?: LedgerUsage }> {
  const response = await model.generate({
    messages: [{
      role: 'user',
      content: `Summarize this earlier conversation segment for continued agent work. Preserve user goals, decisions, file paths, code changes, commands, tool outputs, errors, and pending tasks. Omit filler.\n\n${transcriptForSummary(records)}`,
    }],
    systemPrompt: 'Produce a dense, precise context checkpoint. Output only the summary.',
  });
  const usage = response.usage ? {
    promptTokens: response.usage.promptTokens,
    completionTokens: response.usage.completionTokens,
    ...(response.usage.cachedPromptTokens !== undefined ? { cachedPromptTokens: response.usage.cachedPromptTokens } : {}),
    ...(response.usage.reasoningTokens !== undefined ? { reasoningTokens: response.usage.reasoningTokens } : {}),
  } : undefined;
  return { content: messageContentToText(response.message.content).trim(), ...(usage ? { usage } : {}) };
}

export default function createDiskSessionExtension(config: DiskSessionConfig = {}): DiskSessionExtension {
  const ledger = new SessionLedger(config.sessionDir ?? './sessions', {
    loadOnStartup: false,
    verbose: config.verbose,
  });
  const resolver = config.resolver ?? defaultResolver;
  const policy: ProjectionPolicy = {
    maxMessages: config.maxContextMessages ?? 50,
    channelContextMessages: config.channelContextMessages ?? 10,
    recentChannelMessages: config.recentChannelMessages ?? 5,
    toolCallRetention: Math.max(1, config.toolCallRetention ?? 3),
  };
  const compactingScopes = new Set<string>();

  const identityFromTurn = (turn: { request: { metadata?: Record<string, unknown> } }) =>
    resolver.resolve(turn.request.metadata ?? {});

  const appendMessageRecord = (
    identity: SessionIdentity,
    turnId: string | undefined,
    message: Message,
    meta?: Record<string, unknown>,
    usage?: LedgerUsage,
    systemPrompt?: string,
  ) => ledger.append({
    kind: 'message',
    sessionKey: identity.key,
    turnId,
    role: message.role,
    content: message.content,
    ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.name ? { name: message.name } : {}),
    ts: identity.messageTs,
    ...(identity.threadTs ? { threadTs: identity.threadTs } : {}),
    ...(meta ? { meta } : {}),
    ...(usage ? { usage } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
  });

  return {
    name: 'disk-session',
    priority: -100,
    install(agent) {
      const summaryModel = config.model ?? (agent as unknown as { model?: Model }).model;

      agent.hook('beforeTurn', 'disk-session', async (ctx) => {
        const identity = identityFromTurn(ctx.turn);
        if (!identity) return;
        const turnId = crypto.randomUUID();
        ctx.turn.metadata._diskSessionTurnId = turnId;
        const scope = scopeKey(identity);
        let snapshot = ledger.snapshot(identity.key);

        if (config.autoSummarize !== false && summaryModel && !compactingScopes.has(`${identity.key}:${scope}`)) {
          const selected = selectScope(snapshot, identity, policy);
          const applied = applyCheckpoint(selected, latestCheckpoint(snapshot, scope));
          const chunk = compactionChunk(applied.messages, policy.maxMessages);
          if (chunk.length > 0) {
            const lockKey = `${identity.key}:${scope}`;
            compactingScopes.add(lockKey);
            try {
              const summary = await generateSessionSummary(summaryModel, chunk);
              if (summary.content) {
                ledger.append({
                  kind: 'summary',
                  sessionKey: identity.key,
                  turnId,
                  scope,
                  throughRecordId: chunk[chunk.length - 1].id,
                  sourceRecordCount: chunk.length,
                  content: summary.content,
                  ...(summary.usage ? { usage: summary.usage } : {}),
                  policyVersion: 1,
                  ts: identity.messageTs,
                  ...(identity.threadTs ? { threadTs: identity.threadTs } : {}),
                });
                snapshot = ledger.snapshot(identity.key);
                ctx.turn.metadata._autoCompacted = true;
              }
            } catch (error) {
              console.warn('[disk-session] summary checkpoint failed; using bounded raw context:', error);
            } finally {
              compactingScopes.delete(lockKey);
            }
          }
        }

        const history = await projectContext(snapshot, identity, policy);
        const meta = ctx.turn.metadata.sessionMeta as Record<string, unknown> | undefined;
        appendMessageRecord(
          identity,
          turnId,
          { role: 'user', content: ctx.turn.request.message },
          meta,
          undefined,
          ctx.turn.systemPrompt,
        );
        ctx.turn.messages = [...history, ...ctx.turn.messages];
        ctx.turn.metadata._diskSessionWrittenMessages = new Set(ctx.turn.messages);
      });

      agent.hook('beforeLLM', 'disk-session', async (ctx) => {
        const identity = identityFromTurn(ctx.turn);
        if (!identity) return;
        const written = ctx.turn.metadata._diskSessionWrittenMessages as Set<Message> | undefined;
        const turnId = ctx.turn.metadata._diskSessionTurnId as string | undefined;
        const meta = ctx.turn.metadata.sessionMeta as Record<string, unknown> | undefined;
        for (const message of ctx.turn.messages) {
          if (message.role === 'user' && !written?.has(message)) {
            appendMessageRecord(identity, turnId, message, meta);
            written?.add(message);
          }
        }
      });

      agent.hook('afterLLM', 'disk-session', async (ctx) => {
        const identity = identityFromTurn(ctx.turn);
        const response = ctx.modelResponse;
        if (!identity || !response?.message) return;
        const usage = response.usage ? {
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          ...(response.usage.cachedPromptTokens !== undefined ? { cachedPromptTokens: response.usage.cachedPromptTokens } : {}),
          ...(response.usage.reasoningTokens !== undefined ? { reasoningTokens: response.usage.reasoningTokens } : {}),
        } : undefined;
        appendMessageRecord(
          identity,
          ctx.turn.metadata._diskSessionTurnId as string | undefined,
          response.message,
          ctx.turn.metadata.sessionMeta as Record<string, unknown> | undefined,
          usage,
        );
      });

      agent.hook('afterTool', 'disk-session', async (ctx) => {
        const identity = identityFromTurn(ctx.turn);
        if (!identity || !ctx.toolCall || !ctx.toolResult) return;
        appendMessageRecord(
          identity,
          ctx.turn.metadata._diskSessionTurnId as string | undefined,
          {
            role: 'tool',
            content: ctx.toolResult.content,
            toolCallId: ctx.toolCall.id,
            name: ctx.toolCall.name,
          },
          ctx.turn.metadata.sessionMeta as Record<string, unknown> | undefined,
        );
      });

      agent.hook('afterTurn', 'disk-session', async (ctx) => {
        const identity = identityFromTurn(ctx.turn);
        if (!identity) return;
        const written = ctx.turn.metadata._diskSessionWrittenMessages as Set<Message> | undefined;
        for (const message of ctx.turn.messages) {
          if (message.role === 'user' && !written?.has(message)) {
            appendMessageRecord(
              identity,
              ctx.turn.metadata._diskSessionTurnId as string | undefined,
              message,
              ctx.turn.metadata.sessionMeta as Record<string, unknown> | undefined,
            );
            written?.add(message);
          }
        }
        ledger.append({
          kind: 'event',
          event: 'turn-complete',
          sessionKey: identity.key,
          turnId: ctx.turn.metadata._diskSessionTurnId as string | undefined,
          content: ctx.turn.response?.message ?? '',
          systemPrompt: ctx.turn.systemPrompt,
          finishReason: ctx.turn.response?.finishReason,
          ts: identity.messageTs,
          ...(identity.threadTs ? { threadTs: identity.threadTs } : {}),
        });
        delete ctx.turn.metadata._diskSessionWrittenMessages;
        delete ctx.turn.metadata._diskSessionTurnId;
      });

      agent.hook('onError', 'disk-session', async (ctx) => {
        const identity = identityFromTurn(ctx.turn);
        if (!identity) return;
        ledger.append({
          kind: 'event',
          event: 'turn-error',
          sessionKey: identity.key,
          turnId: ctx.turn.metadata._diskSessionTurnId as string | undefined,
          content: ctx.error instanceof Error ? `${ctx.error.name}: ${ctx.error.message}` : String(ctx.error),
          systemPrompt: ctx.turn.systemPrompt,
          ts: identity.messageTs,
          ...(identity.threadTs ? { threadTs: identity.threadTs } : {}),
        });
      });
    },
    getRecords(sessionKey = 'default') {
      return ledger.snapshot(sessionKey);
    },
    getSessions() {
      return ledger.sessions();
    },
    appendControl(sessionKey, content, ts = String(Date.now() / 1000), threadTs) {
      ledger.append({
        kind: 'event',
        event: 'control',
        sessionKey,
        content,
        ts,
        ...(threadTs ? { threadTs } : {}),
      });
    },
    appendMessage(sessionKey, content, opts = {}) {
      ledger.append({
        kind: 'message',
        role: 'system',
        sessionKey,
        content,
        ts: opts.ts ?? String(Date.now() / 1000),
        ...(opts.threadTs ? { threadTs: opts.threadTs } : {}),
        ...(opts.meta ? { meta: opts.meta } : {}),
      });
    },
  };
}

export type { SessionRecord } from './ledger.js';
