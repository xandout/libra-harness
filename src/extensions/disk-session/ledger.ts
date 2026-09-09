import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MessageContent, ToolCall } from '../../types.js';

export interface LedgerUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  reasoningTokens?: number;
}

interface LedgerRecordBase {
  id: string;
  sessionKey: string;
  turnId?: string;
  ts: string;
  threadTs?: string;
  recordedAt: string;
  meta?: Record<string, unknown>;
}

export interface MessageLedgerRecord extends LedgerRecordBase {
  kind: 'message';
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: MessageContent;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  usage?: LedgerUsage;
}

export interface SummaryLedgerRecord extends LedgerRecordBase {
  kind: 'summary';
  scope: string;
  throughRecordId: string;
  sourceRecordCount: number;
  content: string;
  model?: string;
  usage?: LedgerUsage;
  policyVersion: 1;
}

export interface EventLedgerRecord extends LedgerRecordBase {
  kind: 'event';
  event: 'control' | 'turn-complete' | 'turn-error';
  content: string;
  systemPrompt?: string;
  finishReason?: string;
}

export type SessionRecord = MessageLedgerRecord | SummaryLedgerRecord | EventLedgerRecord;

export type NewSessionRecord = SessionRecord extends infer Record
  ? Record extends SessionRecord
    ? Omit<Record, 'id' | 'recordedAt'> & { id?: string; recordedAt?: string }
    : never
  : never;

export class SessionLedger {
  private readonly records = new Map<string, SessionRecord[]>();

  constructor(
    private readonly dir: string,
    options: { loadOnStartup?: boolean | string; verbose?: boolean } = {},
  ) {
    mkdirSync(dir, { recursive: true });
    if (options.loadOnStartup !== false) {
      if (typeof options.loadOnStartup === 'string') {
        this.loadSession(options.loadOnStartup, options.verbose !== false);
      } else {
        this.load(options.verbose !== false);
      }
    }
  }

  append(record: NewSessionRecord): SessionRecord {
    const complete = {
      ...record,
      id: record.id ?? randomUUID(),
      recordedAt: record.recordedAt ?? new Date().toISOString(),
    } as SessionRecord;
    const session = this.records.get(complete.sessionKey) ?? [];
    session.push(complete);
    this.records.set(complete.sessionKey, session);
    appendFileSync(this.filePath(complete.sessionKey), `${JSON.stringify(complete)}\n`);
    return complete;
  }

  snapshot(sessionKey: string): SessionRecord[] {
    if (!this.records.has(sessionKey)) this.loadSession(sessionKey, false);
    return [...(this.records.get(sessionKey) ?? [])];
  }

  sessions(): string[] {
    return [...this.records.keys()];
  }

  private filePath(sessionKey: string): string {
    return join(this.dir, `${sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
  }

  private loadSession(sessionKey: string, verbose: boolean): void {
    const file = this.filePath(sessionKey);
    if (!existsSync(file)) return;
    const records: SessionRecord[] = [];
    try {
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as SessionRecord;
          if (record.sessionKey === sessionKey || this.filePath(record.sessionKey) === file) records.push(record);
        } catch {}
      }
    } catch {}
    if (records.length > 0) {
      this.records.set(records[0].sessionKey, records);
      if (verbose) console.log(`[disk-session] loaded ${records.length} record(s) for session ${sessionKey}`);
    }
  }

  private load(verbose: boolean): void {
    let count = 0;
    for (const file of readdirSync(this.dir).filter((name) => name.endsWith('.jsonl'))) {
      const sessionKey = file.slice(0, -'.jsonl'.length);
      const records: SessionRecord[] = [];
      try {
        for (const line of readFileSync(join(this.dir, file), 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line) as SessionRecord;
            if (record.sessionKey === sessionKey || this.filePath(record.sessionKey) === join(this.dir, file)) records.push(record);
          } catch {}
        }
      } catch {}
      if (records.length > 0) {
        this.records.set(records[0].sessionKey, records);
        count += records.length;
      }
    }
    if (verbose && count > 0) {
      console.log(`[disk-session] loaded ${this.records.size} session(s), ${count} record(s) from ${this.dir}`);
    }
  }
}
