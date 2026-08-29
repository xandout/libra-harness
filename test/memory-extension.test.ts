import { describe, it, expect, vi } from 'vitest';
import { Agent, type Extension, type Message } from '../src/index.js';
import { MockModel, textResponse } from './helpers.js';
import {
  createMemoryExtension,
  createLlmExtractor,
  type Memory,
  type MemoryStore,
  type MemoryInput,
  type MemoryPatch,
  type MemoryQuery,
  type ExtractedMemory,
  type ExtractorInput,
  type MemoryExtractor,
  type MemoryRetriever,
} from '../src/extras/extensions/memory/index.js';

// ─────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * In-memory mock store for testing. Tracks all operations.
 */
class MockStore implements MemoryStore {
  private memories = new Map<string, Memory>();
  private counter = 0;
  readonly operations: { op: string; id?: string; content?: string; scope?: string }[] = [];

  async save(input: MemoryInput): Promise<Memory> {
    const id = `mem_${++this.counter}`;
    const now = new Date().toISOString();
    const memory: Memory = {
      id,
      content: input.content,
      scope: input.scope,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };
    this.memories.set(id, memory);
    this.operations.push({ op: 'save', id, content: input.content, scope: input.scope });
    return memory;
  }

  async get(id: string): Promise<Memory | null> {
    return this.memories.get(id) ?? null;
  }

  async search(query: MemoryQuery): Promise<Memory[]> {
    const all = [...this.memories.values()].filter((m) => m.scope === query.scope);
    // Simple: return all matching, optionally limited.
    const limited = query.maxResults ? all.slice(0, query.maxResults) : all;
    this.operations.push({ op: 'search', scope: query.scope });
    return limited;
  }

  async update(id: string, patch: MemoryPatch): Promise<Memory> {
    const existing = this.memories.get(id);
    if (!existing) throw new Error(`Memory ${id} not found`);
    const updated: Memory = {
      ...existing,
      ...(patch.content !== undefined && { content: patch.content }),
      ...(patch.metadata !== undefined && { metadata: { ...existing.metadata, ...patch.metadata } }),
      updatedAt: new Date().toISOString(),
    };
    this.memories.set(id, updated);
    this.operations.push({ op: 'update', id, content: patch.content });
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.memories.delete(id);
    this.operations.push({ op: 'delete', id });
  }

  async listByScope(scope: string): Promise<Memory[]> {
    return [...this.memories.values()].filter((m) => m.scope === scope);
  }

  /** Seed a memory directly (for test setup). */
  seed(memory: Partial<Memory> & { content: string; scope: string }): Memory {
    const id = memory.id ?? `mem_${++this.counter}`;
    const now = new Date().toISOString();
    const full: Memory = {
      id,
      content: memory.content,
      scope: memory.scope,
      createdAt: memory.createdAt ?? now,
      updatedAt: memory.updatedAt ?? now,
      metadata: memory.metadata,
    };
    this.memories.set(id, full);
    return full;
  }

  /** Get all stored memories (for assertions). */
  all(): Memory[] {
    return [...this.memories.values()];
  }
}

/**
 * A mock extractor that returns scripted extractions.
 */
class ScriptedExtractor implements MemoryExtractor {
  constructor(private extractions: ExtractedMemory[] | ((input: ExtractorInput) => ExtractedMemory[])) {}

  async extract(input: ExtractorInput): Promise<ExtractedMemory[]> {
    return typeof this.extractions === 'function' ? this.extractions(input) : this.extractions;
  }
}

/** A store that always throws on search. */
class FailingSearchStore extends MockStore {
  async search(): Promise<Memory[]> {
    throw new Error('search failed');
  }
}

/** A store that always throws on listByScope. */
class FailingListStore extends MockStore {
  async listByScope(): Promise<Memory[]> {
    throw new Error('listByScope failed');
  }
}

/** A store that throws on save. */
class FailingSaveStore extends MockStore {
  async save(input: MemoryInput): Promise<Memory> {
    this.operations.push({ op: 'save', content: input.content, scope: input.scope });
    throw new Error('save failed');
  }
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe('Memory Extension', () => {
  // ── 1. Basic injection and extraction ──────────────────────────

  it('1. injects memories in beforeContext and extracts in afterTurn', async () => {
    const store = new MockStore();
    store.seed({ id: 'mem_1', content: 'User likes dark mode', scope: 's1' });

    const extractor = new ScriptedExtractor([
      { action: 'create', content: 'User asked about themes' },
    ]);

    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });
    agent.use(createMemoryExtension({ store, extractor }));

    const result = await agent.run({
      message: 'What themes are available?',
      metadata: { sessionId: 's1' },
    });

    // Memory was injected as a system message at index 0.
    expect(model.receivedCalls[0].messages[0]).toEqual({
      role: 'system',
      content: 'Relevant memories from prior conversations:\n1. User likes dark mode',
    });

    // Extraction was applied — a new memory was saved.
    expect(store.operations).toContainEqual(
      expect.objectContaining({ op: 'save', content: 'User asked about themes', scope: 's1' }),
    );

    // Turn completed normally.
    expect(result.message).toBe('ok');
    expect(result.finishReason).toBe('stop');
  });

  // ── 2. Extractor receives existing memories ────────────────────

  it('2. extractor receives existing memories for dedup context', async () => {
    const store = new MockStore();
    store.seed({ id: 'mem_1', content: 'User name is Kristi', scope: 's1' });

    let receivedExisting: Memory[] | undefined;
    const extractor: MemoryExtractor = {
      async extract(input) {
        receivedExisting = input.existingMemories;
        return [];
      },
    };

    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });
    agent.use(createMemoryExtension({ store, extractor }));

    await agent.run({ message: 'Hi', metadata: { sessionId: 's1' } });

    expect(receivedExisting).toHaveLength(1);
    expect(receivedExisting![0].content).toBe('User name is Kristi');
  });

  // ── 3. Create, update, and delete operations ───────────────────

  it('3. applies create, update, and delete operations to the store', async () => {
    const store = new MockStore();
    const existing = store.seed({ id: 'mem_1', content: 'User prefers light mode', scope: 's1' });
    store.seed({ id: 'mem_2', content: 'Old project note', scope: 's1' });

    const extractor = new ScriptedExtractor([
      { action: 'create', content: 'User now prefers dark mode' },
      { action: 'update', content: 'User prefers dark mode (updated)', targetId: existing.id },
      { action: 'delete', targetId: 'mem_2' },
    ]);

    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });
    agent.use(createMemoryExtension({ store, extractor }));

    await agent.run({ message: 'Switch to dark mode', metadata: { sessionId: 's1' } });

    expect(store.operations).toContainEqual(expect.objectContaining({ op: 'save', content: 'User now prefers dark mode' }));
    expect(store.operations).toContainEqual(expect.objectContaining({ op: 'update', id: 'mem_1', content: 'User prefers dark mode (updated)' }));
    expect(store.operations).toContainEqual(expect.objectContaining({ op: 'delete', id: 'mem_2' }));

    // mem_2 should be gone.
    expect(await store.get('mem_2')).toBeNull();
    // mem_1 should have updated content.
    const updated = await store.get('mem_1');
    expect(updated?.content).toBe('User prefers dark mode (updated)');
  });

  // ── 4. Retrieval failure is non-fatal ──────────────────────────

  it('4. retrieval failure proceeds without memories', async () => {
    const store = new FailingSearchStore();
    const extractor = new ScriptedExtractor([]);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });
    agent.use(createMemoryExtension({ store, extractor }));

    const result = await agent.run({ message: 'Hi', metadata: { sessionId: 's1' } });

    // Turn completed normally — no memory injected.
    expect(result.message).toBe('ok');
    expect(result.finishReason).toBe('stop');
    // No system message was prepended.
    expect(model.receivedCalls[0].messages[0].role).toBe('user');
    // Error was logged.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[memory] retrieval failed'), expect.any(Error));

    errorSpy.mockRestore();
  });

  // ── 5. Extraction failure is non-fatal ─────────────────────────

  it('5. extraction failure does not affect the turn response', async () => {
    const store = new MockStore();
    const extractor: MemoryExtractor = {
      async extract() {
        throw new Error('extractor crashed');
      },
    };

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const model = new MockModel([textResponse('all good')]);
    const agent = new Agent({ model });
    agent.use(createMemoryExtension({ store, extractor }));

    const result = await agent.run({ message: 'Hi', metadata: { sessionId: 's1' } });

    // Response is unaffected.
    expect(result.message).toBe('all good');
    expect(result.finishReason).toBe('stop');
    // No memories were saved.
    expect(store.operations.filter((o) => o.op === 'save')).toHaveLength(0);
    // Error was logged.
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[memory] extraction failed'), expect.any(Error));

    errorSpy.mockRestore();
  });

  // ── 6. Session-scoped isolation ────────────────────────────────

  it('6. memories from session A are not retrieved in session B', async () => {
    const store = new MockStore();
    store.seed({ id: 'mem_a', content: 'Session A secret', scope: 'sessionA' });
    store.seed({ id: 'mem_b', content: 'Session B secret', scope: 'sessionB' });

    const extractor = new ScriptedExtractor([]);

    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });
    agent.use(createMemoryExtension({ store, extractor }));

    // Run in session A.
    await agent.run({ message: 'Hi', metadata: { sessionId: 'sessionA' } });
    // Session A should only see its own memory.
    expect(model.receivedCalls[0].messages[0]).toEqual({
      role: 'system',
      content: 'Relevant memories from prior conversations:\n1. Session A secret',
    });

    // Run in session B.
    model.responses.push(textResponse('ok'));
    await agent.run({ message: 'Hi', metadata: { sessionId: 'sessionB' } });
    // Session B should only see its own memory.
    expect(model.receivedCalls[1].messages[0]).toEqual({
      role: 'system',
      content: 'Relevant memories from prior conversations:\n1. Session B secret',
    });
  });

  // ── 7. Ordering with session extension ─────────────────────────

  it('7. memory system message is at index 0, session history follows', async () => {
    const store = new MockStore();
    store.seed({ id: 'mem_1', content: 'Remembered fact', scope: 's1' });

    const extractor = new ScriptedExtractor([]);

    // Simple in-memory session extension (like mem-session).
    const sessionStore = new Map<string, Message[]>();
    const sessionExt: Extension = {
      name: 'test-session',
      priority: -100,
      install(a) {
        a.hook('beforeTurn', 'test-session', async (ctx) => {
          const sid = (ctx.turn.request.metadata?.sessionId as string) ?? 'default';
          const history = sessionStore.get(sid);
          if (history) {
            ctx.turn.messages = [...history, ...ctx.turn.messages];
          }
        });
        a.hook('afterTurn', 'test-session', async (ctx) => {
          const sid = (ctx.turn.request.metadata?.sessionId as string) ?? 'default';
          sessionStore.set(sid, [...ctx.turn.messages]);
        });
      },
    };

    // Seed session history.
    sessionStore.set('s1', [
      { role: 'user', content: 'previous message' },
      { role: 'assistant', content: 'previous reply' },
    ]);

    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });
    agent.use(sessionExt);
    agent.use(createMemoryExtension({ store, extractor }));

    await agent.run({ message: 'new message', metadata: { sessionId: 's1' } });

    const msgs = model.receivedCalls[0].messages;
    // [memory system] [session history...] [user message]
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('Remembered fact');
    expect(msgs[1].content).toBe('previous message');
    expect(msgs[2].content).toBe('previous reply');
    expect(msgs[3].content).toBe('new message');
  });

  // ── 8. Empty extraction ────────────────────────────────────────

  it('8. empty extraction results in no store writes', async () => {
    const store = new MockStore();
    const extractor = new ScriptedExtractor([]);

    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });
    agent.use(createMemoryExtension({ store, extractor }));

    await agent.run({ message: 'Hi', metadata: { sessionId: 's1' } });

    expect(store.operations.filter((o) => o.op === 'save')).toHaveLength(0);
    expect(store.operations.filter((o) => o.op === 'update')).toHaveLength(0);
    expect(store.operations.filter((o) => o.op === 'delete')).toHaveLength(0);
  });

  // ── 9. Malformed extractor output ──────────────────────────────

  it('9. extractor returning non-array is treated as empty', async () => {
    const store = new MockStore();
    const extractor: MemoryExtractor = {
      async extract() {
        // Return a non-array — should be treated as empty.
        return { not: 'an array' } as unknown as ExtractedMemory[];
      },
    };

    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });
    agent.use(createMemoryExtension({ store, extractor }));

    // This shouldn't crash — the extension just iterates over what it gets.
    // If it's not iterable, it should throw, but that's caught by the
    // extraction try/catch.
    await agent.run({ message: 'Hi', metadata: { sessionId: 's1' } });

    expect(store.operations.filter((o) => o.op === 'save')).toHaveLength(0);
  });

  // ── 10. Multiple agents with independent memory ────────────────

  it('10. two agents with separate stores do not interfere', async () => {
    const storeA = new MockStore();
    const storeB = new MockStore();
    storeA.seed({ id: 'a1', content: 'Agent A fact', scope: 's1' });
    storeB.seed({ id: 'b1', content: 'Agent B fact', scope: 's1' });

    const extractor = new ScriptedExtractor([]);

    const modelA = new MockModel([textResponse('from A')]);
    const modelB = new MockModel([textResponse('from B')]);

    const agentA = new Agent({ model: modelA });
    agentA.use(createMemoryExtension({ store: storeA, extractor }));

    const agentB = new Agent({ model: modelB });
    agentB.use(createMemoryExtension({ store: storeB, extractor }));

    await agentA.run({ message: 'Hi', metadata: { sessionId: 's1' } });
    await agentB.run({ message: 'Hi', metadata: { sessionId: 's1' } });

    // Agent A saw its own memory.
    expect(modelA.receivedCalls[0].messages[0]).toEqual(
      expect.objectContaining({ content: expect.stringContaining('Agent A fact') }),
    );
    // Agent B saw its own memory.
    expect(modelB.receivedCalls[0].messages[0]).toEqual(
      expect.objectContaining({ content: expect.stringContaining('Agent B fact') }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// LLM Extractor tests
// ─────────────────────────────────────────────────────────────────────

describe('LlmExtractor', () => {
  it('parses valid JSON array from model response', async () => {
    const model = new MockModel([
      textResponse(JSON.stringify([
        { action: 'create', content: 'User likes pizza' },
        { action: 'create', content: 'User has a dog named Rex' },
      ])),
    ]);

    const extractor = createLlmExtractor(model);
    const result = await extractor.extract({
      scope: 's1',
      messages: [{ role: 'user', content: 'I like pizza and have a dog named Rex' }],
      response: { role: 'assistant', message: 'Nice!', finishReason: 'stop', iterations: 1, metadata: {} },
      existingMemories: [],
    });

    expect(result).toHaveLength(2);
    expect(result[0].action).toBe('create');
    expect(result[0].content).toBe('User likes pizza');
    expect(result[1].content).toBe('User has a dog named Rex');
  });

  it('returns empty array on malformed JSON', async () => {
    const model = new MockModel([textResponse('This is not JSON')]);
    const extractor = createLlmExtractor(model);

    const result = await extractor.extract({
      scope: 's1',
      messages: [],
      response: { role: 'assistant', message: '', finishReason: 'stop', iterations: 0, metadata: {} },
      existingMemories: [],
    });

    expect(result).toEqual([]);
  });

  it('returns empty array on non-array JSON', async () => {
    const model = new MockModel([textResponse('{"not": "an array"}')]);
    const extractor = createLlmExtractor(model);

    const result = await extractor.extract({
      scope: 's1',
      messages: [],
      response: { role: 'assistant', message: '', finishReason: 'stop', iterations: 0, metadata: {} },
      existingMemories: [],
    });

    expect(result).toEqual([]);
  });

  it('returns empty array when model call fails', async () => {
    const model = new MockModel([]); // no responses — will throw
    const extractor = createLlmExtractor(model);

    const result = await extractor.extract({
      scope: 's1',
      messages: [],
      response: { role: 'assistant', message: '', finishReason: 'stop', iterations: 0, metadata: {} },
      existingMemories: [],
    });

    expect(result).toEqual([]);
  });

  it('includes existing memories in the extraction prompt', async () => {
    const model = new MockModel([textResponse('[]')]);
    const extractor = createLlmExtractor(model);

    await extractor.extract({
      scope: 's1',
      messages: [{ role: 'user', content: 'Hi' }],
      response: { role: 'assistant', message: 'Hello', finishReason: 'stop', iterations: 1, metadata: {} },
      existingMemories: [
        { id: 'mem_1', content: 'User likes tea', scope: 's1', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      ],
    });

    const prompt = model.receivedCalls[0].messages[0].content;
    expect(prompt).toContain('ID: mem_1 | User likes tea');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Custom retriever tests
// ─────────────────────────────────────────────────────────────────────

describe('Custom retriever', () => {
  it('uses the provided retriever instead of store.search', async () => {
    const store = new MockStore();
    store.seed({ id: 'm1', content: 'Fact one', scope: 's1' });
    store.seed({ id: 'm2', content: 'Fact two', scope: 's1' });

    const customRetriever: MemoryRetriever = {
      async retrieve({ scope }) {
        // Return only the first memory, regardless of query.
        const all = await store.listByScope(scope);
        return all.slice(0, 1);
      },
    };

    const extractor = new ScriptedExtractor([]);
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });
    agent.use(createMemoryExtension({ store, extractor, retriever: customRetriever }));

    await agent.run({ message: 'Hi', metadata: { sessionId: 's1' } });

    // Only one memory was injected.
    const injected = model.receivedCalls[0].messages[0];
    expect(injected.content).toContain('Fact one');
    expect(injected.content).not.toContain('Fact two');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Individual store operation failure
// ─────────────────────────────────────────────────────────────────────

describe('Partial persistence', () => {
  it('continues applying operations after a save failure', async () => {
    const store = new FailingSaveStore();
    const extractor = new ScriptedExtractor([
      { action: 'create', content: 'First memory' },
      { action: 'create', content: 'Second memory' },
    ]);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });
    agent.use(createMemoryExtension({ store, extractor }));

    await agent.run({ message: 'Hi', metadata: { sessionId: 's1' } });

    // Both saves were attempted (first failed, second also fails since
    // FailingSaveStore always throws, but the point is the loop continued).
    expect(store.operations.filter((o) => o.op === 'save')).toHaveLength(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[memory] failed to create memory'),
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });
});
