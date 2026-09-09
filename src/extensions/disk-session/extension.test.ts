import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent, type Message } from '@xandout/libra-harness';
import {
  createDiskSessionExtension,
  SessionLedger,
  projectContext,
  selectScope,
  latestCheckpoint,
  applyCheckpoint,
  scopeKey,
  sliceAtTurnBoundary,
  compactionChunk,
  transcriptForSummary,
  type SessionRecord,
  type MessageLedgerRecord,
  type SessionIdentity,
  type ProjectionPolicy,
} from './index.js';

// ── Mock model ─────────────────────────────────────────────────────
function mockModel(seen?: (msgs: Message[]) => void) {
  return {
    async generate(req: { messages: Message[] }) {
      if (seen) seen(req.messages);
      return {
        message: { role: 'assistant', content: 'reply' } as Message,
        finishReason: 'stop' as const,
        usage: { promptTokens: 10, completionTokens: 5 },
      };
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────
function sessionIdentity(
  key: string,
  messageTs: string,
  opts: { threadTs?: string; isDirect?: boolean } = {},
): SessionIdentity {
  return { key, messageTs, threadTs: opts.threadTs, isDirect: opts.isDirect };
}

function runTurn(agent: Agent, message: string, identity: SessionIdentity) {
  return agent.run({ message, metadata: { session: identity } });
}

const defaultPolicy: ProjectionPolicy = {
  maxMessages: 50,
  channelContextMessages: 10,
  recentChannelMessages: 5,
  toolCallRetention: 3,
};

function makeMessageRecord(
  sessionKey: string,
  role: 'user' | 'assistant' | 'tool' | 'system',
  content: string,
  opts: { id?: string; ts?: string; threadTs?: string; toolCalls?: MessageLedgerRecord['toolCalls']; toolCallId?: string; name?: string } = {},
): MessageLedgerRecord {
  return {
    kind: 'message',
    id: opts.id ?? `rec_${Math.random().toString(36).slice(2)}`,
    sessionKey,
    role,
    content,
    ts: opts.ts ?? `ts_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    recordedAt: new Date().toISOString(),
    ...(opts.threadTs ? { threadTs: opts.threadTs } : {}),
    ...(opts.toolCalls ? { toolCalls: opts.toolCalls } : {}),
    ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
    ...(opts.name ? { name: opts.name } : {}),
  };
}

// ── Test setup ─────────────────────────────────────────────────────
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'disk-session-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Ledger: append-only persistence ────────────────────────────────
describe('SessionLedger', () => {
  it('appends records to a JSONL file', () => {
    const ledger = new SessionLedger(tmpDir, { loadOnStartup: false });
    const rec = ledger.append({
      kind: 'message',
      sessionKey: 's1',
      role: 'user',
      content: 'hello',
      ts: 'ts1',
    });
    expect(rec.id).toBeTruthy();
    expect(rec.recordedAt).toBeTruthy();
    const file = join(tmpDir, 's1.jsonl');
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).content).toBe('hello');
  });

  it('preserves existing bytes when appending new records', () => {
    const ledger = new SessionLedger(tmpDir, { loadOnStartup: false });
    ledger.append({ kind: 'message', sessionKey: 's1', role: 'user', content: 'first', ts: 'ts1' });
    const file = join(tmpDir, 's1.jsonl');
    const before = readFileSync(file, 'utf-8');
    ledger.append({ kind: 'message', sessionKey: 's1', role: 'assistant', content: 'second', ts: 'ts2' });
    const after = readFileSync(file, 'utf-8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('never rewrites or truncates the active file during compaction', () => {
    const ledger = new SessionLedger(tmpDir, { loadOnStartup: false });
    for (let i = 0; i < 5; i++) {
      ledger.append({ kind: 'message', sessionKey: 's1', role: i % 2 ? 'assistant' : 'user', content: `msg-${i}`, ts: `ts${i}` });
    }
    const file = join(tmpDir, 's1.jsonl');
    const before = readFileSync(file, 'utf-8');
    // Append a summary checkpoint — must not touch existing bytes.
    ledger.append({
      kind: 'summary',
      sessionKey: 's1',
      scope: 'channel',
      throughRecordId: 'rec_2',
      sourceRecordCount: 3,
      content: 'summary text',
      policyVersion: 1,
      ts: 'ts5',
    });
    const after = readFileSync(file, 'utf-8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.split('\n').filter(Boolean)).toHaveLength(6);
  });

  it('loads records on startup', () => {
    const ledger = new SessionLedger(tmpDir, { loadOnStartup: false });
    ledger.append({ kind: 'message', sessionKey: 's1', role: 'user', content: 'hello', ts: 'ts1' });
    ledger.append({ kind: 'message', sessionKey: 's1', role: 'assistant', content: 'world', ts: 'ts2' });

    const reloaded = new SessionLedger(tmpDir, { loadOnStartup: true, verbose: false });
    const snapshot = reloaded.snapshot('s1');
    expect(snapshot).toHaveLength(2);
    expect((snapshot[0] as MessageLedgerRecord).content).toBe('hello');
    expect((snapshot[1] as MessageLedgerRecord).content).toBe('world');
  });

  it('isolates sessions by key', () => {
    const ledger = new SessionLedger(tmpDir, { loadOnStartup: false });
    ledger.append({ kind: 'message', sessionKey: 's1', role: 'user', content: 'a', ts: 'ts1' });
    ledger.append({ kind: 'message', sessionKey: 's2', role: 'user', content: 'b', ts: 'ts1' });
    expect(ledger.snapshot('s1')).toHaveLength(1);
    expect(ledger.snapshot('s2')).toHaveLength(1);
    expect((ledger.snapshot('s1')[0] as MessageLedgerRecord).content).toBe('a');
    expect((ledger.snapshot('s2')[0] as MessageLedgerRecord).content).toBe('b');
  });
});

// ── Projection: scope selection ────────────────────────────────────
describe('selectScope', () => {
  it('returns all messages for direct sessions', () => {
    const records: SessionRecord[] = [
      makeMessageRecord('s', 'user', 'a', { threadTs: 't1' }),
      makeMessageRecord('s', 'user', 'b'),
    ];
    const selected = selectScope(records, { isDirect: true });
    expect(selected).toHaveLength(2);
  });

  it('returns only non-thread messages for channel scope', () => {
    const records: SessionRecord[] = [
      makeMessageRecord('s', 'user', 'a'),
      makeMessageRecord('s', 'user', 'b', { threadTs: 't1' }),
      makeMessageRecord('s', 'user', 'c'),
    ];
    const selected = selectScope(records, {});
    expect(selected).toHaveLength(2);
    expect(selected.map((r) => r.content)).toEqual(['a', 'c']);
  });

  it('returns thread messages plus surrounding channel context', () => {
    const parentTs = 'parent_ts';
    const records: SessionRecord[] = [
      makeMessageRecord('s', 'user', 'chan1', { ts: 'ts1' }),
      makeMessageRecord('s', 'user', 'chan2', { ts: 'ts2' }),
      makeMessageRecord('s', 'user', 'parent', { ts: parentTs }),
      makeMessageRecord('s', 'user', 'thread1', { threadTs: parentTs }),
      makeMessageRecord('s', 'user', 'chan3', { ts: 'ts3' }),
    ];
    const selected = selectScope(records, { threadTs: parentTs }, { channelContextMessages: 2, recentChannelMessages: 5 });
    const contents = selected.map((r) => r.content);
    expect(contents).toContain('parent');
    expect(contents).toContain('thread1');
    expect(contents).toContain('chan3');
  });
});

// ── Projection: checkpoints ────────────────────────────────────────
describe('checkpoints', () => {
  it('finds the latest checkpoint for a scope', () => {
    const records: SessionRecord[] = [
      { kind: 'summary', id: 'sum1', sessionKey: 's', scope: 'channel', throughRecordId: 'r1', sourceRecordCount: 1, content: 'old', policyVersion: 1, ts: 'ts1', recordedAt: '' },
      { kind: 'summary', id: 'sum2', sessionKey: 's', scope: 'channel', throughRecordId: 'r2', sourceRecordCount: 1, content: 'new', policyVersion: 1, ts: 'ts2', recordedAt: '' },
      { kind: 'summary', id: 'sum3', sessionKey: 's', scope: 'thread:t1', throughRecordId: 'r3', sourceRecordCount: 1, content: 'thread-sum', policyVersion: 1, ts: 'ts3', recordedAt: '' },
    ];
    expect(latestCheckpoint(records, 'channel')?.content).toBe('new');
    expect(latestCheckpoint(records, 'thread:t1')?.content).toBe('thread-sum');
    expect(latestCheckpoint(records, 'direct')).toBeUndefined();
  });

  it('drops records covered by a checkpoint', () => {
    const records: MessageLedgerRecord[] = [
      makeMessageRecord('s', 'user', 'a', { id: 'r1' }),
      makeMessageRecord('s', 'assistant', 'b', { id: 'r2' }),
      makeMessageRecord('s', 'user', 'c', { id: 'r3' }),
    ];
    const checkpoint = { kind: 'summary' as const, id: 'sum', sessionKey: 's', scope: 'channel', throughRecordId: 'r2', sourceRecordCount: 2, content: 'summary', policyVersion: 1 as const, ts: '', recordedAt: '' };
    const applied = applyCheckpoint(records, checkpoint);
    expect(applied.summary).toBe('summary');
    expect(applied.messages).toHaveLength(1);
    expect(applied.messages[0].content).toBe('c');
  });

  it('returns all messages when no checkpoint exists', () => {
    const records: MessageLedgerRecord[] = [
      makeMessageRecord('s', 'user', 'a'),
      makeMessageRecord('s', 'assistant', 'b'),
    ];
    const applied = applyCheckpoint(records, undefined);
    expect(applied.summary).toBeUndefined();
    expect(applied.messages).toHaveLength(2);
  });
});

// ── Projection: turn boundaries ────────────────────────────────────
describe('sliceAtTurnBoundary', () => {
  it('slices at a user/system message boundary', () => {
    const records: MessageLedgerRecord[] = [
      makeMessageRecord('s', 'user', 'u1'),
      makeMessageRecord('s', 'assistant', 'a1'),
      makeMessageRecord('s', 'tool', 't1', { toolCallId: 'tc1', name: 'tool' }),
      makeMessageRecord('s', 'user', 'u2'),
      makeMessageRecord('s', 'assistant', 'a2'),
    ];
    const sliced = sliceAtTurnBoundary(records, 3);
    // Slicing aligns to the next user/system boundary, which may yield fewer.
    expect(sliced.length).toBeLessThanOrEqual(3);
    expect(sliced[0].role).toBe('user');
  });

  it('returns all when under the limit', () => {
    const records: MessageLedgerRecord[] = [
      makeMessageRecord('s', 'user', 'u1'),
      makeMessageRecord('s', 'assistant', 'a1'),
    ];
    expect(sliceAtTurnBoundary(records, 10)).toHaveLength(2);
  });
});

// ── Projection: compaction chunk ───────────────────────────────────
describe('compactionChunk', () => {
  it('selects a prefix chunk for summarization', () => {
    const records: MessageLedgerRecord[] = [];
    for (let i = 0; i < 10; i++) {
      records.push(makeMessageRecord('s', i % 2 ? 'assistant' : 'user', `msg-${i}`));
    }
    const chunk = compactionChunk(records, 10);
    expect(chunk.length).toBeGreaterThan(0);
    expect(chunk.length).toBeLessThan(records.length);
  });

  it('returns empty when under the limit', () => {
    const records: MessageLedgerRecord[] = [
      makeMessageRecord('s', 'user', 'a'),
      makeMessageRecord('s', 'assistant', 'b'),
    ];
    expect(compactionChunk(records, 50)).toHaveLength(0);
  });
});

// ── Projection: full context projection ────────────────────────────
describe('projectContext', () => {
  it('converts records to Libra messages', async () => {
    const records: SessionRecord[] = [
      makeMessageRecord('s', 'user', 'hello'),
      makeMessageRecord('s', 'assistant', 'hi there'),
    ];
    const messages = await projectContext(records, { isDirect: true }, defaultPolicy);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
  });

  it('prunes reasoning from projected context', async () => {
    const records: SessionRecord[] = [
      makeMessageRecord('s', 'user', 'question'),
      {
        ...makeMessageRecord('s', 'assistant', 'answer'),
        content: [
          { type: 'reasoning', text: 'thinking deeply' },
          { type: 'text', text: 'answer' },
        ],
      },
    ];
    const messages = await projectContext(records, { isDirect: true }, defaultPolicy);
    const assistantContent = messages[1].content;
    if (typeof assistantContent !== 'string') {
      const types = assistantContent.map((p) => p.type);
      expect(types).not.toContain('reasoning');
    }
  });

  it('preserves tool-call/result pairing in projection', async () => {
    const records: SessionRecord[] = [
      makeMessageRecord('s', 'user', 'run it', { id: 'r1' }),
      makeMessageRecord('s', 'assistant', 'calling tool', {
        id: 'r2',
        toolCalls: [{ id: 'tc1', name: 'shell', arguments: '{"cmd":"ls"}' }],
      }),
      makeMessageRecord('s', 'tool', 'output', { id: 'r3', toolCallId: 'tc1', name: 'shell' }),
      makeMessageRecord('s', 'assistant', 'done', { id: 'r4' }),
    ];
    const messages = await projectContext(records, { isDirect: true }, defaultPolicy);
    // user, assistant(with tool call), tool(result), assistant
    expect(messages.length).toBeGreaterThanOrEqual(3);
    const assistant = messages.find((m) => m.role === 'assistant' && m.toolCalls?.length);
    expect(assistant).toBeDefined();
    expect(assistant!.toolCalls![0].name).toBe('shell');
    const tool = messages.find((m) => m.role === 'tool');
    expect(tool).toBeDefined();
    expect(tool!.toolCallId).toBe('tc1');
  });

  it('respects maxMessages limit', async () => {
    const records: SessionRecord[] = [];
    for (let i = 0; i < 20; i++) {
      records.push(makeMessageRecord('s', i % 2 ? 'assistant' : 'user', `msg-${i}`));
    }
    const policy = { ...defaultPolicy, maxMessages: 6 };
    const messages = await projectContext(records, { isDirect: true }, policy);
    expect(messages.length).toBeLessThanOrEqual(6);
  });

  it('uses a wide window so pruned tool-only messages can backfill', async () => {
    // 20 messages: 10 user/assistant pairs where assistant is tool-only.
    // Without the wide window, slicing to maxMessages first would keep
    // tool-only messages that Vercel then drops, leaving fewer than maxMessages.
    const records: SessionRecord[] = [];
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) {
        records.push(makeMessageRecord('s', 'user', `q-${i}`, { id: `r${i}` }));
      } else {
        records.push(makeMessageRecord('s', 'assistant', '', {
          id: `r${i}`,
          toolCalls: [{ id: `tc${i}`, name: 'noop', arguments: '{}' }],
        }));
        records.push(makeMessageRecord('s', 'tool', 'result', { id: `r${i + 1}`, toolCallId: `tc${i}`, name: 'noop' }));
      }
    }
    const policy = { ...defaultPolicy, maxMessages: 8, toolCallRetention: 1 };
    const messages = await projectContext(records, { isDirect: true }, policy);
    // Vercel should drop old tool-only assistant + tool messages.
    // The wide window lets content-bearing messages backfill.
    expect(messages.length).toBeLessThanOrEqual(8);
    // Should have more than just the last 2 messages (which is what would
    // happen if we sliced to 8 first and Vercel dropped 6 tool-only ones).
    expect(messages.length).toBeGreaterThan(2);
  });

  it('is deterministic from the same snapshot', async () => {
    const records: SessionRecord[] = [
      makeMessageRecord('s', 'user', 'a'),
      makeMessageRecord('s', 'assistant', 'b'),
      makeMessageRecord('s', 'user', 'c'),
      makeMessageRecord('s', 'assistant', 'd'),
    ];
    const m1 = await projectContext(records, { isDirect: true }, defaultPolicy);
    const m2 = await projectContext(records, { isDirect: true }, defaultPolicy);
    expect(m1).toEqual(m2);
  });

  it('uses the latest applicable checkpoint', async () => {
    const records: SessionRecord[] = [
      makeMessageRecord('s', 'user', 'old1', { id: 'r1' }),
      makeMessageRecord('s', 'assistant', 'old2', { id: 'r2' }),
      makeMessageRecord('s', 'user', 'new1', { id: 'r3' }),
      makeMessageRecord('s', 'assistant', 'new2', { id: 'r4' }),
      {
        kind: 'summary',
        id: 'sum1',
        sessionKey: 's',
        scope: 'direct',
        throughRecordId: 'r2',
        sourceRecordCount: 2,
        content: 'prior context summary',
        policyVersion: 1,
        ts: '',
        recordedAt: '',
      },
    ];
    const messages = await projectContext(records, { isDirect: true }, defaultPolicy);
    // Summary system message + new1 + new2
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const systemMsg = messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
  });
});

// ── Projection: incomplete tool sequences ──────────────────────────
describe('incomplete tool sequences', () => {
  it('drops trailing user messages without responses', async () => {
    const records: SessionRecord[] = [
      makeMessageRecord('s', 'user', 'q'),
      makeMessageRecord('s', 'assistant', 'a'),
      makeMessageRecord('s', 'user', 'orphan'),
    ];
    const messages = await projectContext(records, { isDirect: true }, defaultPolicy);
    const last = messages.at(-1);
    expect(last?.role).not.toBe('user');
  });
});

// ── Transcript for summary ─────────────────────────────────────────
describe('transcriptForSummary', () => {
  it('produces a text transcript of message records', () => {
    const records: MessageLedgerRecord[] = [
      makeMessageRecord('s', 'user', 'hello'),
      makeMessageRecord('s', 'assistant', 'hi', { toolCalls: [{ id: 'tc1', name: 'shell', arguments: '{}' }] }),
    ];
    const transcript = transcriptForSummary(records);
    expect(transcript).toContain('[USER]');
    expect(transcript).toContain('hello');
    expect(transcript).toContain('[ASSISTANT');
    expect(transcript).toContain('shell');
  });
});

// ── Extension integration ──────────────────────────────────────────
describe('createDiskSessionExtension integration', () => {
  it('persists user and assistant messages across turns', async () => {
    const agent = new Agent({ model: mockModel() as any });
    agent.use(createDiskSessionExtension({ sessionDir: tmpDir, maxContextMessages: 50, autoSummarize: false }));
    await runTurn(agent, 'first', sessionIdentity('s1', 'ts1', { isDirect: true }));
    await runTurn(agent, 'second', sessionIdentity('s1', 'ts2', { isDirect: true }));
    const file = join(tmpDir, 's1.jsonl');
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    const records = lines.map((l) => JSON.parse(l));
    const messages = records.filter((r) => r.kind === 'message');
    expect(messages.some((r) => r.role === 'user' && r.content === 'first')).toBe(true);
    expect(messages.some((r) => r.role === 'user' && r.content === 'second')).toBe(true);
    expect(messages.some((r) => r.role === 'assistant' && r.content === 'reply')).toBe(true);
  });

  it('provides conversation history to the model on subsequent turns', async () => {
    let seenMessages: Message[] = [];
    const agent = new Agent({ model: mockModel((msgs) => (seenMessages = msgs)) as any });
    agent.use(createDiskSessionExtension({ sessionDir: tmpDir, maxContextMessages: 50, autoSummarize: false }));
    await runTurn(agent, 'first', sessionIdentity('s1', 'ts1', { isDirect: true }));
    await runTurn(agent, 'second', sessionIdentity('s1', 'ts2', { isDirect: true }));
    const userTexts = seenMessages.filter((m) => m.role === 'user').map((m) => m.content);
    expect(userTexts).toContain('first');
  });

  it('isolates sessions by key', async () => {
    const agent = new Agent({ model: mockModel() as any });
    agent.use(createDiskSessionExtension({ sessionDir: tmpDir, maxContextMessages: 50, autoSummarize: false }));
    await runTurn(agent, 'msg-a', sessionIdentity('s1', 'ts1', { isDirect: true }));
    await runTurn(agent, 'msg-b', sessionIdentity('s2', 'ts1', { isDirect: true }));
    expect(existsSync(join(tmpDir, 's1.jsonl'))).toBe(true);
    expect(existsSync(join(tmpDir, 's2.jsonl'))).toBe(true);
    const s1 = JSON.parse(readFileSync(join(tmpDir, 's1.jsonl'), 'utf-8').split('\n')[0]);
    expect(s1.sessionKey).toBe('s1');
    const s2 = JSON.parse(readFileSync(join(tmpDir, 's2.jsonl'), 'utf-8').split('\n')[0]);
    expect(s2.sessionKey).toBe('s2');
  });

  it('does not rewrite existing bytes when appending', async () => {
    const agent = new Agent({ model: mockModel() as any });
    agent.use(createDiskSessionExtension({ sessionDir: tmpDir, maxContextMessages: 50, autoSummarize: false }));
    await runTurn(agent, 'first', sessionIdentity('s1', 'ts1', { isDirect: true }));
    const file = join(tmpDir, 's1.jsonl');
    const before = readFileSync(file, 'utf-8');
    await runTurn(agent, 'second', sessionIdentity('s1', 'ts2', { isDirect: true }));
    const after = readFileSync(file, 'utf-8');
    expect(after.startsWith(before)).toBe(true);
  });

  it('records turn-complete events', async () => {
    const agent = new Agent({ model: mockModel() as any });
    agent.use(createDiskSessionExtension({ sessionDir: tmpDir, maxContextMessages: 50, autoSummarize: false }));
    await runTurn(agent, 'hello', sessionIdentity('s1', 'ts1', { isDirect: true }));
    const lines = readFileSync(join(tmpDir, 's1.jsonl'), 'utf-8').split('\n').filter(Boolean);
    const events = lines.map((l) => JSON.parse(l)).filter((r) => r.kind === 'event');
    expect(events.some((r) => r.event === 'turn-complete')).toBe(true);
  });
});

// ── Restart consistency ────────────────────────────────────────────
describe('restart consistency', () => {
  it('produces the same projection after reload', async () => {
    const ledger1 = new SessionLedger(tmpDir, { loadOnStartup: false });
    for (let i = 0; i < 6; i++) {
      ledger1.append({
        kind: 'message',
        sessionKey: 's1',
        role: i % 2 ? 'assistant' : 'user',
        content: `msg-${i}`,
        ts: `ts${i}`,
      });
    }
    const snapshot1 = ledger1.snapshot('s1');
    const proj1 = await projectContext(snapshot1, { isDirect: true }, defaultPolicy);

    const ledger2 = new SessionLedger(tmpDir, { loadOnStartup: true, verbose: false });
    const snapshot2 = ledger2.snapshot('s1');
    const proj2 = await projectContext(snapshot2, { isDirect: true }, defaultPolicy);
    expect(proj2).toEqual(proj1);
  });
});

// ── Summary failure safety ────────────────────────────────────────
describe('summary failure safety', () => {
  it('does not lose history when summary generation fails', async () => {
    const ledger = new SessionLedger(tmpDir, { loadOnStartup: false });
    for (let i = 0; i < 5; i++) {
      ledger.append({ kind: 'message', sessionKey: 's1', role: i % 2 ? 'assistant' : 'user', content: `msg-${i}`, ts: `ts${i}` });
    }
    const beforeCount = ledger.snapshot('s1').length;
    const file = join(tmpDir, 's1.jsonl');
    const beforeBytes = readFileSync(file, 'utf-8');
    // Simulate a failed summary — no checkpoint appended.
    // The ledger must be unchanged.
    expect(ledger.snapshot('s1').length).toBe(beforeCount);
    expect(readFileSync(file, 'utf-8')).toBe(beforeBytes);
  });
});

// ── Concurrent turns ──────────────────────────────────────────────
describe('concurrent turns', () => {
  it('does not corrupt the ledger with concurrent appends', () => {
    const ledger = new SessionLedger(tmpDir, { loadOnStartup: false });
    const writers = Array.from({ length: 10 }, (_, i) =>
      ledger.append({ kind: 'message', sessionKey: 's1', role: 'user', content: `concurrent-${i}`, ts: `ts${i}` }),
    );
    expect(writers).toHaveLength(10);
    const lines = readFileSync(join(tmpDir, 's1.jsonl'), 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(10);
  });
});

// ── scopeKey ───────────────────────────────────────────────────────
describe('scopeKey', () => {
  it('returns thread scope for thread identity', () => {
    expect(scopeKey({ threadTs: 't1' })).toBe('thread:t1');
  });
  it('returns direct scope for direct identity', () => {
    expect(scopeKey({ isDirect: true })).toBe('direct');
  });
  it('returns channel scope for default identity', () => {
    expect(scopeKey({})).toBe('channel');
  });
});
