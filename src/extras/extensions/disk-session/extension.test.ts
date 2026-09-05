import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent, messageContentToText, type Message } from '@xandout/libra-harness';
import { createDiskSessionExtension, type SessionRecord, type SessionIdentity } from './index.js';

// ── Mock model ─────────────────────────────────────────────────────
// Returns a fixed assistant message. Optionally logs what the agent sees.
function mockModel(seen?: (msgs: Message[]) => void) {
  return {
    async generate(req: { messages: Message[] }) {
      if (seen) seen(req.messages);
      return {
        message: { role: 'assistant', content: 'reply' },
        finishReason: 'stop' as const,
        usage: { promptTokens: 0, completionTokens: 0 },
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
  return {
    key,
    messageTs,
    threadTs: opts.threadTs,
    isDirect: opts.isDirect,
  };
}

function runTurn(
  agent: Agent,
  message: string,
  identity: SessionIdentity,
) {
  return agent.run({ message, metadata: { session: identity } });
}

// ── Test setup ─────────────────────────────────────────────────────
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'disk-session-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeExt(opts?: Record<string, unknown>) {
  return createDiskSessionExtension({ sessionDir: tmpDir, ...opts });
}

function makeAgent(ext: ReturnType<typeof makeExt>, seen?: (msgs: Message[]) => void) {
  const agent = new Agent({ model: mockModel(seen) as never });
  agent.use(ext);
  return agent;
}

function readJsonl(sessionKey: string): SessionRecord[] {
  const path = join(tmpDir, `${sessionKey}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SessionRecord);
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

describe('disk-session', () => {
  // ── Basic persistence ───────────────────────────────────────────

  it('persists user and assistant messages to JSONL after a turn', async () => {
    const ext = makeExt();
    const agent = makeAgent(ext);

    await runTurn(agent, 'hello', sessionIdentity('C1', '1001'));

    const records = ext.getRecords('C1');
    expect(records).toHaveLength(2);
    expect(records[0].role).toBe('user');
    expect(records[0].content).toBe('hello');
    expect(records[1].role).toBe('assistant');
    expect(records[1].content).toBe('reply');

    const fileRecords = readJsonl('C1');
    expect(fileRecords).toHaveLength(2);
    expect(fileRecords[0].content).toBe('hello');
  });

  it('persists user message to disk immediately (before agent runs)', async () => {
    const ext = makeExt();
    // Model that never resolves — simulates a crash mid-turn
    const hangingAgent = new Agent({
      model: {
        async generate() {
          return new Promise(() => {}); // never resolves
        },
      } as never,
    });
    hangingAgent.use(ext);

    // Start the turn but don't await it
    const turnPromise = runTurn(hangingAgent, 'important message', sessionIdentity('C1', '1001'));

    // Give beforeTurn a tick to run
    await new Promise((r) => setTimeout(r, 50));

    // The user message should already be on disk, even though
    // the agent hasn't finished (and never will)
    const fileRecords = readJsonl('C1');
    expect(fileRecords.length).toBeGreaterThanOrEqual(1);
    expect(fileRecords[0].role).toBe('user');
    expect(fileRecords[0].content).toBe('important message');

    // Clean up the hanging promise
    (turnPromise as { halt?: () => void }).halt?.();
  });

  it('does not persist system messages', async () => {
    const ext = makeExt();
    const agent = makeAgent(ext);
    agent.hook('beforeContext', 'test', async (ctx) => {
      ctx.turn.messages.push({ role: 'system', content: 'ephemeral' });
    });

    await runTurn(agent, 'hello', sessionIdentity('C1', '1001'));

    const records = ext.getRecords('C1');
    expect(records.every((r) => (r.role as string) !== 'system')).toBe(true);
  });

  // ── History loading ─────────────────────────────────────────────

  it('loads session history on subsequent turns', async () => {
    const ext = makeExt();
    const agent = makeAgent(ext);
    let seenMsgs: Message[] = [];

    await runTurn(agent, 'first', sessionIdentity('C1', '1001'));
    agent.hook('beforeContext', 'capture', async (ctx) => {
      seenMsgs = ctx.turn.messages.map((m) => ({ role: m.role, content: m.content }));
    });
    await runTurn(agent, 'second', sessionIdentity('C1', '1002'));

    // Should see: [first, reply, second]
    expect(seenMsgs.map((m) => m.content)).toContain('first');
    expect(seenMsgs.map((m) => m.content)).toContain('reply');
    expect(seenMsgs.map((m) => m.content)).toContain('second');
  });

  it('starts with empty context for a new session', async () => {
    const ext = makeExt();
    let seenMsgs: Message[] = [];
    const agent = makeAgent(ext, (msgs) => { seenMsgs = msgs; });

    await runTurn(agent, 'hello', sessionIdentity('NEW', '1001'));

    // Only the user message (no history)
    expect(seenMsgs.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  // ── Thread forking ──────────────────────────────────────────────

  it('forks thread context: channel context before parent + thread history', async () => {
    const ext = makeExt({ channelContextMessages: 5, recentChannelMessages: 0 });
    let seenMsgs: Message[] = [];
    const agent = makeAgent(ext);

    // Top-level message A (will be thread parent)
    await runTurn(agent, 'top A', sessionIdentity('C1', '1001'));
    // Top-level message B (comes after A)
    await runTurn(agent, 'top B', sessionIdentity('C1', '1002'));

    // Thread reply on A (threadTs=1001)
    agent.hook('beforeContext', 'capture', async (ctx) => {
      seenMsgs = ctx.turn.messages.map((m) => ({ role: m.role, content: m.content }));
    });
    await runTurn(agent, 'thread reply', sessionIdentity('C1', '1003', { threadTs: '1001' }));

    const contents = seenMsgs.map((m) => m.content);
    // Should see: [top A, reply, thread reply] — NOT top B
    expect(contents).toContain('top A');
    expect(contents).toContain('thread reply');
    expect(contents).not.toContain('top B');
  });

  it('accumulates thread history across multiple thread replies', async () => {
    const ext = makeExt({ channelContextMessages: 5 });
    let seenMsgs: Message[] = [];
    const agent = makeAgent(ext);

    await runTurn(agent, 'parent', sessionIdentity('C1', '1001'));
    await runTurn(agent, 'reply 1', sessionIdentity('C1', '1002', { threadTs: '1001' }));

    agent.hook('beforeContext', 'capture', async (ctx) => {
      seenMsgs = ctx.turn.messages.map((m) => ({ role: m.role, content: m.content }));
    });
    await runTurn(agent, 'reply 2', sessionIdentity('C1', '1003', { threadTs: '1001' }));

    const contents = seenMsgs.map((m) => m.content);
    expect(contents).toContain('parent');
    expect(contents).toContain('reply 1');
    expect(contents).toContain('reply 2');
  });

  it('isolates threads from each other', async () => {
    const ext = makeExt({ channelContextMessages: 5, recentChannelMessages: 0 });
    let seenMsgs: Message[] = [];
    const agent = makeAgent(ext);

    // Thread 1
    await runTurn(agent, 'thread1 parent', sessionIdentity('C1', '1001'));
    await runTurn(agent, 'thread1 reply', sessionIdentity('C1', '1002', { threadTs: '1001' }));

    // Thread 2
    await runTurn(agent, 'thread2 parent', sessionIdentity('C1', '1003'));
    await runTurn(agent, 'thread2 reply', sessionIdentity('C1', '1004', { threadTs: '1003' }));

    // New reply in thread 1 — should NOT see thread 2 messages
    agent.hook('beforeContext', 'capture', async (ctx) => {
      seenMsgs = ctx.turn.messages.map((m) => ({ role: m.role, content: m.content }));
    });
    await runTurn(agent, 'thread1 reply 2', sessionIdentity('C1', '1005', { threadTs: '1001' }));

    const contents = seenMsgs.map((m) => m.content);
    expect(contents).toContain('thread1 parent');
    expect(contents).toContain('thread1 reply');
    expect(contents).not.toContain('thread2 parent');
    expect(contents).not.toContain('thread2 reply');
  });

  // ── Concurrent turns (snapshot isolation) ───────────────────────

  it('concurrent turns do not see each other\'s assistant responses', async () => {
    const ext = makeExt();
    const seenByTurn: Message[][] = [];
    const agent = makeAgent(ext, (msgs) => {
      seenByTurn.push(msgs.map((m) => ({ role: m.role, content: m.content })));
    });

    // Seed one exchange
    await runTurn(agent, 'seed', sessionIdentity('C1', '1001'));

    // Run two turns concurrently
    await Promise.all([
      runTurn(agent, 'from A', sessionIdentity('C1', '1002')),
      runTurn(agent, 'from B', sessionIdentity('C1', '1003')),
    ]);

    // seenByTurn[0] is the seed turn, [1] and [2] are the concurrent turns
    const turnA = seenByTurn[1];
    const turnB = seenByTurn[2];

    const aContents = turnA.map((m) => m.content);
    const bContents = turnB.map((m) => m.content);

    // Both see the seed
    expect(aContents).toContain('seed');
    expect(bContents).toContain('seed');

    // Neither sees the other's assistant response.
    // (User messages may be visible since they're persisted immediately
    // in beforeTurn — that's correct, they're real channel messages.
    // But the assistant response from a concurrent turn should never
    // leak into another turn's context.)
    const aAssistantMsgs = turnA.filter((m) => m.role === 'assistant').map((m) => m.content);
    const bAssistantMsgs = turnB.filter((m) => m.role === 'assistant').map((m) => m.content);

    // Each turn should have exactly one assistant message (its own reply)
    expect(aAssistantMsgs).toHaveLength(1);
    expect(bAssistantMsgs).toHaveLength(1);
    // Both replies are 'reply' (from the mock), but they're from
    // this turn, not the other turn. The key invariant: neither
    // turn has MORE than one assistant message (which would indicate
    // it saw the other turn's response).
  });

  it('concurrent turns both append to the log without clobbering', async () => {
    const ext = makeExt();
    const agent = makeAgent(ext);

    await runTurn(agent, 'seed', sessionIdentity('C1', '1001'));

    await Promise.all([
      runTurn(agent, 'from A', sessionIdentity('C1', '1002')),
      runTurn(agent, 'from B', sessionIdentity('C1', '1003')),
    ]);

    const records = ext.getRecords('C1');
    // seed (2) + A (2) + B (2) = 6
    expect(records).toHaveLength(6);
    const contents = records.map((r) => r.content);
    expect(contents).toContain('seed');
    expect(contents).toContain('from A');
    expect(contents).toContain('from B');
  });

  // ── Disk persistence ────────────────────────────────────────────

  it('appends to JSONL file (never rewrites)', async () => {
    const ext = makeExt();
    const agent = makeAgent(ext);

    await runTurn(agent, 'first', sessionIdentity('C1', '1001'));

    // Read the file after turn 1
    const fileAfter1 = readJsonl('C1');
    expect(fileAfter1).toHaveLength(2);

    await runTurn(agent, 'second', sessionIdentity('C1', '1002'));

    // Read the file after turn 2 — should have 4 records (appended)
    const fileAfter2 = readJsonl('C1');
    expect(fileAfter2).toHaveLength(4);
    // First 2 records unchanged (append-only)
    expect(fileAfter2[0]).toEqual(fileAfter1[0]);
    expect(fileAfter2[1]).toEqual(fileAfter1[1]);
  });

  it('reloads sessions from disk on startup', async () => {
    const ext1 = makeExt();
    const agent1 = makeAgent(ext1);

    await runTurn(agent1, 'persisted', sessionIdentity('C1', '1001'));

    // Create a new extension pointing at the same dir — should load
    const ext2 = makeExt();
    const records = ext2.getRecords('C1');
    expect(records).toHaveLength(2);
    expect(records[0].content).toBe('persisted');
  });

  it('separates sessions by key', async () => {
    const ext = makeExt();
    const agent = makeAgent(ext);

    await runTurn(agent, 'in C1', sessionIdentity('C1', '1001'));
    await runTurn(agent, 'in C2', sessionIdentity('C2', '1001'));

    expect(ext.getRecords('C1')).toHaveLength(2);
    expect(ext.getRecords('C2')).toHaveLength(2);
    expect(ext.getRecords('C1')[0].content).toBe('in C1');
    expect(ext.getRecords('C2')[0].content).toBe('in C2');
    expect(ext.getSessions()).toContain('C1');
    expect(ext.getSessions()).toContain('C2');
  });

  // ── DM / direct sessions ────────────────────────────────────────

  it('treats direct sessions as simple last-N history (no forking)', async () => {
    const ext = makeExt({ maxContextMessages: 10 });
    let seenMsgs: Message[] = [];
    const agent = makeAgent(ext);

    await runTurn(agent, 'dm 1', sessionIdentity('D1', '1001', { isDirect: true }));
    await runTurn(agent, 'dm 2', sessionIdentity('D1', '1002', { isDirect: true }));

    agent.hook('beforeContext', 'capture', async (ctx) => {
      seenMsgs = ctx.turn.messages.map((m) => ({ role: m.role, content: m.content }));
    });
    await runTurn(agent, 'dm 3', sessionIdentity('D1', '1003', { isDirect: true }));

    const contents = seenMsgs.map((m) => m.content);
    // Should see all prior DM messages (simple last-N)
    expect(contents).toContain('dm 1');
    expect(contents).toContain('dm 2');
    expect(contents).toContain('dm 3');
  });

  // ── Record metadata ─────────────────────────────────────────────

  it('tags records with ts and threadTs', async () => {
    const ext = makeExt();
    const agent = makeAgent(ext);

    await runTurn(agent, 'top', sessionIdentity('C1', '1001'));
    await runTurn(agent, 'thread', sessionIdentity('C1', '1002', { threadTs: '1001' }));

    const records = ext.getRecords('C1');
    // Top-level: no threadTs
    expect(records[0].ts).toBe('1001');
    expect(records[0].threadTs).toBeUndefined();
    // Thread: has threadTs
    expect(records[2].ts).toBe('1002');
    expect(records[2].threadTs).toBe('1001');
  });

  // ── Clearing ────────────────────────────────────────────────────

  it('clears a single session', async () => {
    const ext = makeExt();
    const agent = makeAgent(ext);

    await runTurn(agent, 'in C1', sessionIdentity('C1', '1001'));
    await runTurn(agent, 'in C2', sessionIdentity('C2', '1001'));

    ext.clear('C1');
    expect(ext.getRecords('C1')).toHaveLength(0);
    expect(ext.getRecords('C2')).toHaveLength(2);
  });

  it('clears all sessions', async () => {
    const ext = makeExt();
    const agent = makeAgent(ext);

    await runTurn(agent, 'in C1', sessionIdentity('C1', '1001'));
    await runTurn(agent, 'in C2', sessionIdentity('C2', '1001'));

    ext.clearAll();
    expect(ext.getRecords('C1')).toHaveLength(0);
    expect(ext.getRecords('C2')).toHaveLength(0);
    expect(ext.getSessions()).toHaveLength(0);
  });

  // ── Max context trimming ────────────────────────────────────────

  it('trims context to maxContextMessages for top-level', async () => {
    const ext = makeExt({ maxContextMessages: 4 });
    let seenMsgs: Message[] = [];
    const agent = makeAgent(ext);

    // 5 top-level turns = 10 records (user + assistant each)
    for (let i = 1; i <= 5; i++) {
      agent.hook('beforeContext', 'capture', async (ctx) => {
        seenMsgs = ctx.turn.messages.map((m) => ({ role: m.role, content: m.content }));
      });
      await runTurn(agent, `msg${i}`, sessionIdentity('C1', `100${i}`));
    }

    // The 5th turn should see at most 4 history messages + 1 new = 5
    // (maxContextMessages limits the history, not the total)
    const userMsgs = seenMsgs.filter((m) => m.role === 'user');
    // Should not see msg1 (trimmed), should see msg3, msg4, msg5
    expect(userMsgs.map((m) => m.content)).not.toContain('msg1');
  });

  // ── Fallback when parent not in cache ───────────────────────────

  it('falls back to last-N when thread parent is not in cache', async () => {
    const ext = makeExt({ maxRecords: 4, channelContextMessages: 5 });
    let seenMsgs: Message[] = [];
    const agent = makeAgent(ext);

    // Fill cache so the parent gets evicted
    await runTurn(agent, 'parent', sessionIdentity('C1', '1001'));
    await runTurn(agent, 'msg2', sessionIdentity('C1', '1002'));
    await runTurn(agent, 'msg3', sessionIdentity('C1', '1003'));

    // parent (ts=1001) should be evicted from in-memory cache (maxRecords=4,
    // but we have 6 records: 3 user + 3 assistant). Actually with maxRecords=4,
    // the first 2 records (parent user + parent assistant) get evicted.

    agent.hook('beforeContext', 'capture', async (ctx) => {
      seenMsgs = ctx.turn.messages.map((m) => ({ role: m.role, content: m.content }));
    });
    // Thread reply on the evicted parent
    await runTurn(agent, 'thread reply', sessionIdentity('C1', '1004', { threadTs: '1001' }));

    // Should not crash, should fall back to last-N
    const contents = seenMsgs.map((m) => m.content);
    expect(contents).toContain('thread reply');
  });

  // ── Recent channel context for thread revivals ─────────────────

  it('includes recent top-level messages after the last thread reply', async () => {
    // 3 top-level turns after thread = 6 records. Use 10 to see all.
    const ext = makeExt({ channelContextMessages: 5, recentChannelMessages: 10 });
    let seenMsgs: Message[] = [];
    const agent = makeAgent(ext);

    // Thread parent + one reply
    await runTurn(agent, 'thread parent', sessionIdentity('C1', '1001'));
    await runTurn(agent, 'thread reply 1', sessionIdentity('C1', '1002', { threadTs: '1001' }));

    // Top-level messages after the thread (channel moved on)
    await runTurn(agent, 'top after 1', sessionIdentity('C1', '1003'));
    await runTurn(agent, 'top after 2', sessionIdentity('C1', '1004'));
    await runTurn(agent, 'top after 3', sessionIdentity('C1', '1005'));

    // Come back to the thread a "week later"
    agent.hook('beforeContext', 'capture', async (ctx) => {
      seenMsgs = ctx.turn.messages.map((m) => ({ role: m.role, content: m.content }));
    });
    await runTurn(agent, 'we solved this', sessionIdentity('C1', '1006', { threadTs: '1001' }));

    const contents = seenMsgs.map((m) => m.content);

    // Sees the thread history
    expect(contents).toContain('thread parent');
    expect(contents).toContain('thread reply 1');
    expect(contents).toContain('we solved this');

    // Also sees recent top-level messages that happened after the thread
    expect(contents).toContain('top after 1');
    expect(contents).toContain('top after 2');
    expect(contents).toContain('top after 3');
  });

  it('limits recent channel messages to recentChannelMessages count', async () => {
    // 5 top-level turns = 10 records. recentChannelMessages=4 gives
    // last 4 records = 2 full turns (after 4 + after 5).
    const ext = makeExt({ channelContextMessages: 5, recentChannelMessages: 4 });
    let seenMsgs: Message[] = [];
    const agent = makeAgent(ext);

    await runTurn(agent, 'parent', sessionIdentity('C1', '1001'));
    await runTurn(agent, 'thread reply', sessionIdentity('C1', '1002', { threadTs: '1001' }));

    // 5 top-level messages after the thread
    await runTurn(agent, 'after 1', sessionIdentity('C1', '1003'));
    await runTurn(agent, 'after 2', sessionIdentity('C1', '1004'));
    await runTurn(agent, 'after 3', sessionIdentity('C1', '1005'));
    await runTurn(agent, 'after 4', sessionIdentity('C1', '1006'));
    await runTurn(agent, 'after 5', sessionIdentity('C1', '1007'));

    agent.hook('beforeContext', 'capture', async (ctx) => {
      seenMsgs = ctx.turn.messages.map((m) => ({ role: m.role, content: m.content }));
    });
    await runTurn(agent, 'revival', sessionIdentity('C1', '1008', { threadTs: '1001' }));

    const contents = seenMsgs.map((m) => m.content);

    // Should see only the last 4 records (2 turns: after 4 + after 5)
    expect(contents).not.toContain('after 1');
    expect(contents).not.toContain('after 2');
    expect(contents).not.toContain('after 3');
    expect(contents).toContain('after 4');
    expect(contents).toContain('after 5');
  });

  // ── Tool-call intermediate filtering ────────────────────────────

  it('preserves tool-call intermediates but slices at turn boundaries to prevent split sequences', async () => {
    // If a tool call pair (assistant+tool) spans the boundary of the
    // channelContextMessages window, the tool message would be sliced mid-sequence
    // if we just did a naive .slice(). With sliceAtTurnBoundary, it skips forward
    // to the next user message, dropping the partial turn entirely rather than splitting it.
    const ext = makeExt({ channelContextMessages: 3, recentChannelMessages: 0 }); // 3 ensures it cuts into the 4-message turn
    let seenMsgs: Message[] = [];

    // Create a tool-call exchange early in the channel (NOT the thread parent)
    const toolModel = {
      async generate(req: { messages: Message[] }) {
        const hasToolResult = req.messages.some((m) => m.role === 'tool');
        if (!hasToolResult) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'tc1', name: 'test_tool', arguments: '{}' }],
            },
            finishReason: 'tool_calls' as const,
            usage: { promptTokens: 0, completionTokens: 0 },
          };
        }
        return {
          message: { role: 'assistant', content: 'tool result summary' },
          finishReason: 'stop' as const,
          usage: { promptTokens: 0, completionTokens: 0 },
        };
      },
    };
    const toolAgent = new Agent({ model: toolModel as never });
    toolAgent.use(ext);
    toolAgent.tool({
      name: 'test_tool',
      description: 'test',
      parameters: { type: 'object', properties: {} },
      async execute() { return { toolCallId: 'tc1', content: 'tool output' }; },
    });

    // Turn 1: tool call exchange (produces user+assistant[tool]+tool+assistant records = 4 records)
    await toolAgent.run({
      message: 'use the tool',
      metadata: { session: { key: 'C1', messageTs: '1001' } },
    });

    // Turn 2: thread parent (a regular message, no tool calls)
    const regAgent = makeAgent(ext);
    await runTurn(regAgent, 'thread parent', sessionIdentity('C1', '1002'));

    // Now thread reply on ts=1002
    // The topLevelBefore messages before the parent are the 4 messages from Turn 1.
    // We configured channelContextMessages: 3.
    // If we took the last 3 messages of Turn 1, we would get [assistant, tool, assistant].
    // But sliceAtTurnBoundary will see it starts with 'assistant', skip forward looking for
    // a 'user' or 'system', find none, and return an empty array.
    regAgent.hook('beforeContext', 'capture', async (ctx) => {
      seenMsgs = ctx.turn.messages.map((m) => ({ role: m.role, content: m.content }));
    });
    await runTurn(regAgent, 'thread reply', sessionIdentity('C1', '1005', { threadTs: '1002' }));

    // Because the context window (3) starts in the middle of Turn 1,
    // sliceAtTurnBoundary will drop it entirely.
    const toolMsgs = seenMsgs.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(0);

    // No assistant messages from Turn 1 should be present.
    const emptyAssistantMsgs = seenMsgs.filter((m) => m.role === 'assistant' && !messageContentToText(m.content).trim());
    expect(emptyAssistantMsgs).toHaveLength(0);

    // But the thread messages should still be there
    const contents = seenMsgs.map((m) => m.content);
    expect(contents).toContain('thread parent');
    expect(contents).toContain('thread reply');
  });

  // ── Enrichment bag (sessionMeta → record.meta) ──────────────────
  // disk-session persists `ctx.turn.metadata.sessionMeta` opaquely as
  // `record.meta`. It does not inspect or interpret the contents — any
  // extension that writes into the bag before disk-session's
  // beforeTurn hook runs will have its data persisted.

  it('persists sessionMeta as record.meta on the user record', async () => {
    const ext = makeExt();
    // Register the enricher BEFORE disk-session so its beforeTurn
    // hook runs first (hooks run in registration order within a stage).
    const agent = new Agent({ model: mockModel() as never });
    agent.hook('beforeTurn', 'enricher', async (ctx) => {
      ctx.turn.metadata.sessionMeta = { keywords: { terms: ['MCP', 'auth'] } };
    });
    agent.use(ext);

    await runTurn(agent, 'find MCP auth docs', sessionIdentity('C1', '1001'));

    const records = ext.getRecords('C1');
    expect(records[0].role).toBe('user');
    expect(records[0].meta).toEqual({ keywords: { terms: ['MCP', 'auth'] } });

    // Also persisted to disk.
    const fileRecords = readJsonl('C1');
    expect(fileRecords[0].meta).toEqual({ keywords: { terms: ['MCP', 'auth'] } });
  });

  it('persists sessionMeta on assistant records too', async () => {
    const ext = makeExt();
    const agent = new Agent({ model: mockModel() as never });
    agent.hook('beforeTurn', 'enricher', async (ctx) => {
      ctx.turn.metadata.sessionMeta = { topic: 'testing' };
    });
    agent.use(ext);

    await runTurn(agent, 'hello', sessionIdentity('C1', '1001'));

    const records = ext.getRecords('C1');
    expect(records).toHaveLength(2);
    expect(records[0].meta).toEqual({ topic: 'testing' });
    expect(records[1].meta).toEqual({ topic: 'testing' });
  });

  it('omits meta when sessionMeta is absent', async () => {
    const ext = makeExt();
    const agent = makeAgent(ext);

    await runTurn(agent, 'hello', sessionIdentity('C1', '1001'));

    const records = ext.getRecords('C1');
    expect(records[0].meta).toBeUndefined();
  });

  // ── Custom resolver ──────────────────────────────────────────────

  it('supports a custom resolver for host-specific identity extraction', async () => {
    // Simulate a host that stores identity under a host-specific key.
    const ext = createDiskSessionExtension({
      sessionDir: tmpDir,
      resolver: {
        resolve(metadata) {
          const host = metadata.myPlatform as { channelId: string; ts: string; thread?: string } | undefined;
          if (!host) return undefined;
          return { key: `mp_${host.channelId}`, messageTs: host.ts, threadTs: host.thread };
        },
      },
    });
    const agent = makeAgent(ext);

    await agent.run({
      message: 'hello',
      metadata: { myPlatform: { channelId: 'X1', ts: '2001' } },
    });

    const records = ext.getRecords('mp_X1');
    expect(records).toHaveLength(2);
    expect(records[0].content).toBe('hello');
  });

  it('skips session handling when resolver returns undefined', async () => {
    const ext = createDiskSessionExtension({
      sessionDir: tmpDir,
      resolver: {
        resolve() { return undefined; },
      },
    });
    const agent = makeAgent(ext);

    await agent.run({ message: 'hello', metadata: {} });

    // No records persisted
    expect(ext.getSessions()).toHaveLength(0);
  });

  it('falls back to metadata.sessionId when no session identity is present', async () => {
    const ext = makeExt();
    const agent = makeAgent(ext);

    await agent.run({ message: 'hello', metadata: { sessionId: 'fallback-key' } });

    const records = ext.getRecords('fallback-key');
    expect(records).toHaveLength(2);
    expect(records[0].content).toBe('hello');
  });

  it('uses "default" key when no session metadata is present', async () => {
    const ext = makeExt();
    const agent = makeAgent(ext);

    await agent.run({ message: 'hello', metadata: {} });

    const records = ext.getRecords('default');
    expect(records).toHaveLength(2);
    expect(records[0].content).toBe('hello');
  });

  it('persists the system prompt on the user record', async () => {
    const ext = makeExt();
    const agent = new Agent({
      model: mockModel() as never,
      systemPrompt: 'You are a test agent. Be concise.',
    });
    agent.use(ext);

    await runTurn(agent, 'hello', sessionIdentity('s1', 't1'));

    const records = ext.getRecords('s1');
    expect(records).toHaveLength(2);
    expect(records[0].role).toBe('user');
    expect(records[0].systemPrompt).toBe('You are a test agent. Be concise.');
    expect(records[1].role).toBe('assistant');
    expect(records[1].systemPrompt).toBeUndefined();
  });

  it('captures system prompt after appendSystemPrompt modifies it', async () => {
    const ext = makeExt();
    const agent = new Agent({
      model: mockModel() as never,
      systemPrompt: 'Base prompt.',
    });
    agent.appendSystemPrompt('Appended skill content.');
    agent.use(ext);

    await runTurn(agent, 'hello', sessionIdentity('s1', 't1'));

    const records = ext.getRecords('s1');
    expect(records[0].systemPrompt).toBe('Base prompt.\n\nAppended skill content.');
  });

  // ── Background messages (appendMessage) ────────────────────────

  it('appendMessage persists a system record to memory and disk', () => {
    const ext = makeExt();
    ext.appendMessage('s1', '[U1]: anyone seen the invoice?', {
      ts: '1001',
      meta: { sender: 'U1', channelId: 'C1' },
    });

    const records = ext.getRecords('s1');
    expect(records).toHaveLength(1);
    expect(records[0].role).toBe('system');
    expect(records[0].content).toBe('[U1]: anyone seen the invoice?');
    expect(records[0].ts).toBe('1001');
    expect(records[0].meta).toEqual({ sender: 'U1', channelId: 'C1' });

    // Persisted to disk.
    const onDisk = readJsonl('s1');
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].role).toBe('system');
    expect(onDisk[0].content).toBe('[U1]: anyone seen the invoice?');
  });

  it('background system messages appear in LLM context when agent is triggered', async () => {
    const seen = (msgs: Message[]) => {
      capturedMsgs = [...msgs];
    };
    let capturedMsgs: Message[] = [];
    const ext = makeExt();
    const agent = makeAgent(ext, seen);

    // Simulate background chatter — messages the bot observed but
    // weren't directed at it.
    ext.appendMessage('s1', '[U1]: anyone seen the Johnson invoice?');
    ext.appendMessage('s1', '[U2]: I think it\'s in the shared drive');

    // Now the agent is triggered.
    await runTurn(agent, '[U1]: @bot what\'s the status of the Johnson job?', sessionIdentity('s1', 't3'));

    // The LLM should see: [system, system, user]
    // The two background messages as system context, then the trigger.
    expect(capturedMsgs).toHaveLength(3);
    expect(capturedMsgs[0].role).toBe('system');
    expect(capturedMsgs[0].content).toBe('[U1]: anyone seen the Johnson invoice?');
    expect(capturedMsgs[1].role).toBe('system');
    expect(capturedMsgs[1].content).toBe('[U2]: I think it\'s in the shared drive');
    expect(capturedMsgs[2].role).toBe('user');
    expect(capturedMsgs[2].content).toBe('[U1]: @bot what\'s the status of the Johnson job?');
  });

  it('background system messages are not double-persisted by afterTurn', async () => {
    const ext = makeExt();
    const agent = makeAgent(ext);

    ext.appendMessage('s1', '[U1]: background chatter', { ts: 't1' });
    await runTurn(agent, '[U2]: @bot hello', sessionIdentity('s1', 't2'));

    // Should be: [system (background), user (trigger), assistant (reply)]
    // NOT: [system, user, system, user, assistant] — the background
    // system message is NOT in turn.messages so afterTurn can't see it.
    const records = ext.getRecords('s1');
    expect(records).toHaveLength(3);
    expect(records[0].role).toBe('system');
    expect(records[0].content).toBe('[U1]: background chatter');
    expect(records[1].role).toBe('user');
    expect(records[2].role).toBe('assistant');
  });
});
