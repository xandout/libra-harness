import {
  parsePartialJson,
  pruneMessages,
  type AssistantContent,
  type FilePart,
  type ModelMessage,
  type UserContent,
} from 'ai';
import type { FileContentPart, Message, MessageContent, ReasoningContentPart, TextContentPart, ToolCall } from '../../types.js';
import type { MessageLedgerRecord, SessionRecord, SummaryLedgerRecord } from './ledger.js';

type AssistantPart = NonNullable<AssistantContent extends infer T
  ? T extends Array<infer P> ? P : never
  : never>;

export interface ProjectionIdentity {
  threadTs?: string;
  isDirect?: boolean;
}

export interface ProjectionPolicy {
  maxMessages: number;
  channelContextMessages: number;
  recentChannelMessages: number;
  toolCallRetention: number;
}

export function scopeKey(identity: ProjectionIdentity): string {
  return identity.threadTs ? `thread:${identity.threadTs}` : identity.isDirect ? 'direct' : 'channel';
}

export function selectScope(
  records: SessionRecord[],
  identity: ProjectionIdentity,
  policy?: Pick<ProjectionPolicy, 'channelContextMessages' | 'recentChannelMessages'>,
): MessageLedgerRecord[] {
  const messages = records.filter((record): record is MessageLedgerRecord => record.kind === 'message');
  if (identity.isDirect) return messages;
  if (!identity.threadTs) return messages.filter((record) => !record.threadTs);

  const parentIndex = messages.findIndex((record) => record.ts === identity.threadTs && !record.threadTs);
  const thread = messages.filter((record) => record.ts === identity.threadTs || record.threadTs === identity.threadTs);
  if (parentIndex < 0) return thread;

  const before = messages
    .slice(0, parentIndex)
    .filter((record) => !record.threadTs)
    .slice(-(policy?.channelContextMessages ?? 10));
  const threadIds = new Set(thread.map((record) => record.id));
  const lastThreadIndex = messages.reduce((last, record, index) => threadIds.has(record.id) ? index : last, parentIndex);
  const recent = messages
    .slice(lastThreadIndex + 1)
    .filter((record) => !record.threadTs)
    .slice(-(policy?.recentChannelMessages ?? 5));
  return [...before, ...thread, ...recent];
}

export function latestCheckpoint(records: SessionRecord[], scope: string): SummaryLedgerRecord | undefined {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (record.kind === 'summary' && record.scope === scope) return record;
  }
  return undefined;
}

export function applyCheckpoint(
  messages: MessageLedgerRecord[],
  checkpoint: SummaryLedgerRecord | undefined,
): { summary?: string; messages: MessageLedgerRecord[] } {
  if (!checkpoint) return { messages };
  const index = messages.findIndex((record) => record.id === checkpoint.throughRecordId);
  return index < 0
    ? { messages }
    : { summary: checkpoint.content, messages: messages.slice(index + 1) };
}

export function sliceAtTurnBoundary(messages: MessageLedgerRecord[], maxMessages: number): MessageLedgerRecord[] {
  if (messages.length <= maxMessages) return messages;
  let start = messages.length - maxMessages;
  while (start < messages.length && messages[start].role !== 'user' && messages[start].role !== 'system') start++;
  return messages.slice(start);
}

export function compactionChunk(messages: MessageLedgerRecord[], maxMessages: number): MessageLedgerRecord[] {
  if (messages.length < maxMessages) return [];
  const target = Math.max(1, Math.floor(maxMessages / 2));
  let end = Math.min(target, messages.length - 1);
  while (end < messages.length && messages[end].role !== 'user' && messages[end].role !== 'system') end++;
  return end > 0 && end < messages.length ? messages.slice(0, end) : [];
}

export async function projectContext(
  records: SessionRecord[],
  identity: ProjectionIdentity,
  policy: ProjectionPolicy,
): Promise<Message[]> {
  const selected = selectScope(records, identity);
  const checkpoint = latestCheckpoint(records, scopeKey(identity));
  const applied = applyCheckpoint(selected, checkpoint);
  const complete = dropIncompleteTrailingUsers(applied.messages);
  const window = sliceAtTurnBoundary(complete, policy.maxMessages - (applied.summary ? 1 : 0));
  const modelMessages = await recordsToModelMessages(window);
  const pruned = pruneMessages({
    messages: modelMessages,
    reasoning: 'all',
    toolCalls: `before-last-${policy.toolCallRetention}-messages`,
    emptyMessages: 'remove',
  });
  const messages = modelMessagesToLibra(pruned);
  return applied.summary ? [{ role: 'system', content: `[Conversation summary]\n\n${applied.summary}` }, ...messages] : messages;
}

export function transcriptForSummary(records: MessageLedgerRecord[]): string {
  return records
    .map((record) => {
      const tools = record.toolCalls?.length ? ` [called: ${record.toolCalls.map((call) => call.name).join(', ')}]` : '';
      return `[${record.role.toUpperCase()}${tools}]: ${contentToText(record.content)}`;
    })
    .join('\n\n');
}

async function recordsToModelMessages(records: MessageLedgerRecord[]): Promise<ModelMessage[]> {
  const result: ModelMessage[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.role === 'user') {
      result.push({ role: 'user', content: toUserContent(record.content) });
    } else if (record.role === 'system') {
      result.push({ role: 'system', content: contentToText(record.content) });
    } else if (record.role === 'assistant') {
      const followingTools: MessageLedgerRecord[] = [];
      let cursor = index + 1;
      while (cursor < records.length && records[cursor].role === 'tool') followingTools.push(records[cursor++]);
      const fulfilled = new Set(followingTools.map((tool) => tool.toolCallId).filter(Boolean));
      const calls = (record.toolCalls ?? []).filter((call) => fulfilled.has(call.id));
      const content = await toAssistantContent(record.content, calls);
      if (content.length > 0) result.push({ role: 'assistant', content });
    } else if (record.toolCallId && record.name) {
      result.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: record.toolCallId,
          toolName: record.name,
          output: { type: 'text', value: contentToText(record.content) },
        }],
      });
    }
  }
  return result;
}

function modelMessagesToLibra(messages: ModelMessage[]): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      result.push({ role: 'system', content: message.content });
    } else if (message.role === 'user') {
      result.push({ role: 'user', content: fromModelContent(message.content) });
    } else if (message.role === 'assistant') {
      const parts = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
      const toolCalls: ToolCall[] = [];
      const content: Array<TextContentPart | ReasoningContentPart | FileContentPart> = [];
      for (const part of parts) {
        if (part.type === 'text') content.push({ type: 'text', text: part.text });
        else if (part.type === 'reasoning') content.push({ type: 'reasoning', text: part.text });
        else if (part.type === 'file') content.push(fromFilePart(part));
        else if (part.type === 'tool-call') toolCalls.push({ id: part.toolCallId, name: part.toolName, arguments: JSON.stringify(part.input ?? {}) });
      }
      result.push({ role: 'assistant', content: simplifyContent(content), ...(toolCalls.length ? { toolCalls } : {}) });
    } else {
      for (const part of message.content) {
        if (part.type !== 'tool-result') continue;
        const value = part.output.type === 'text' || part.output.type === 'error-text'
          ? part.output.value
          : JSON.stringify('value' in part.output ? part.output.value : part.output);
        result.push({ role: 'tool', content: value, toolCallId: part.toolCallId, name: part.toolName });
      }
    }
  }
  return result;
}

async function toAssistantContent(content: MessageContent, calls: ToolCall[]): Promise<AssistantContent> {
  const parts: AssistantPart[] = toContentParts(content);
  for (const call of calls) {
    const parsed = await parsePartialJson(call.arguments || '{}');
    parts.push({
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.name,
      input: parsed.state === 'failed-parse' ? {} : parsed.value ?? {},
    });
  }
  return parts;
}

function toUserContent(content: MessageContent): string | UserContent {
  if (typeof content === 'string') return content;
  const parts: Array<{ type: 'text'; text: string } | FilePart> = [];
  for (const part of content) {
    if (part.type === 'text') parts.push({ type: 'text', text: part.text });
    else if (part.type === 'file') parts.push(toFilePart(part));
  }
  return parts;
}

function toContentParts(content: MessageContent): AssistantPart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text' as const, text: part.text };
    if (part.type === 'reasoning') return { type: 'reasoning' as const, text: part.text };
    return toFilePart(part);
  });
}

function toFilePart(part: FileContentPart): FilePart {
  const data = part.data.type === 'url'
    ? new URL(part.data.url)
    : part.data.type === 'text'
      ? { type: 'text' as const, text: part.data.text }
      : part.data.data;
  return {
    type: 'file',
    mediaType: part.mediaType,
    ...(part.filename ? { filename: part.filename } : {}),
    data,
  };
}

function fromModelContent(content: string | UserContent): MessageContent {
  if (typeof content === 'string') return content;
  const parts: Array<TextContentPart | ReasoningContentPart | FileContentPart> = [];
  for (const part of content) {
    if (part.type === 'text') parts.push({ type: 'text', text: part.text });
    else if (part.type === 'file') parts.push(fromFilePart(part));
    else if (part.type === 'image') parts.push(fromImagePart(part));
  }
  return simplifyContent(parts);
}

function fromFilePart(part: FilePart): FileContentPart {
  const data = fileDataFromModel(part.data);
  return { type: 'file', mediaType: part.mediaType, ...(part.filename ? { filename: part.filename } : {}), data };
}

function fromImagePart(part: { mediaType?: string; image: FilePart['data'] }): FileContentPart {
  const data = fileDataFromModel(part.image);
  return { type: 'file', mediaType: part.mediaType ?? 'image', data };
}

function fileDataFromModel(data: FilePart['data']): FileContentPart['data'] {
  if (data instanceof URL) return { type: 'url', url: data.toString() };
  if (typeof data === 'string') return { type: 'data', data };
  if (data instanceof Uint8Array) return { type: 'data', data };
  if (data instanceof ArrayBuffer) return { type: 'data', data: new Uint8Array(data) };
  if (typeof data === 'object' && data !== null && 'type' in data) {
    if (data.type === 'url') return { type: 'url', url: data.url.toString() };
    if (data.type === 'text') return { type: 'text', text: data.text };
    if (data.type === 'data') {
      const raw = data.data;
      return { type: 'data', data: typeof raw === 'string' ? raw : raw instanceof Uint8Array ? raw : new Uint8Array(raw) };
    }
  }
  return { type: 'data', data: String(data) };
}

function simplifyContent(parts: Array<TextContentPart | ReasoningContentPart | FileContentPart>): MessageContent {
  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
}

function contentToText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content.map((part) => part.type === 'text' || part.type === 'reasoning' ? part.text : `[File: ${part.filename ?? part.mediaType}]`).join('\n');
}

function dropIncompleteTrailingUsers(records: MessageLedgerRecord[]): MessageLedgerRecord[] {
  const result = [...records];
  while (result.at(-1)?.role === 'user') result.pop();
  return result;
}
