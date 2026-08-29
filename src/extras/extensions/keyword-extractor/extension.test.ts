import { describe, it, expect } from 'vitest';
import { Agent } from 'libra-harness';
import type { Extension } from 'libra-harness';
import { createWinkQueryAnalyzer } from './index.js';
import { createKeywordExtractorExtension, type KeywordExtractionEntry } from './index.js';

// Mock model — returns a fixed assistant reply without touching a provider.
function mockModel() {
  return {
    async generate() {
      return {
        message: { role: 'assistant', content: 'ok' },
        finishReason: 'stop' as const,
        usage: { promptTokens: 0, completionTokens: 0 },
      };
    },
  };
}

describe('keyword-extractor extension', () => {
  it('extracts terms and writes sessionMeta.keywords on beforeTurn', async () => {
    const extracted: KeywordExtractionEntry[] = [];
    let capturedMeta: Record<string, unknown> | undefined;
    const analyzer = createWinkQueryAnalyzer();
    const ext = createKeywordExtractorExtension({
      analyzer,
      log: (entry) => extracted.push(entry),
    });

    const agent = new Agent({ model: mockModel() as never });
    // Register the extension first so its beforeTurn hook runs before
    // the observer (hooks run in registration order within a stage).
    agent.use(ext);
    agent.hook('beforeTurn', 'observer', async (ctx) => {
      capturedMeta = ctx.turn.metadata.sessionMeta as Record<string, unknown> | undefined;
    });

    await agent.run({
      message: 'Can you find our documentation about the MCP server architecture?',
    });

    expect(extracted).toHaveLength(1);
    expect(extracted[0].message).toBe(
      'Can you find our documentation about the MCP server architecture?',
    );
    expect(extracted[0].terms).toEqual([
      'find',
      'documentation',
      'MCP',
      'server',
      'architecture',
    ]);
    expect(extracted[0].phrases).toContain('MCP server architecture');

    // The enrichment bag should contain keywords under the right shape.
    expect(capturedMeta).toBeDefined();
    expect(capturedMeta!.keywords).toEqual({
      terms: ['find', 'documentation', 'MCP', 'server', 'architecture'],
      phrases: expect.arrayContaining(['MCP server architecture']),
    });
  });

  it('extracts empty terms for an empty message', async () => {
    const extracted: KeywordExtractionEntry[] = [];
    const ext = createKeywordExtractorExtension({
      analyzer: createWinkQueryAnalyzer(),
      log: (entry) => extracted.push(entry),
    });
    const agent = new Agent({ model: mockModel() as never });
    agent.use(ext);

    await agent.run({ message: '' });

    expect(extracted).toHaveLength(1);
    expect(extracted[0].terms).toEqual([]);
    expect(extracted[0].phrases).toEqual([]);
  });

  it('uses the shared analyzer when none is provided', async () => {
    const extracted: KeywordExtractionEntry[] = [];
    const ext = createKeywordExtractorExtension({ log: (e) => extracted.push(e) });
    const agent = new Agent({ model: mockModel() as never });
    agent.use(ext);

    await agent.run({ message: 'Where did we store agent memory?' });

    expect(extracted[0].terms).toEqual(['store', 'agent', 'memory']);
  });

  it('merges into existing sessionMeta without overwriting other keys', async () => {
    let capturedMeta: Record<string, unknown> | undefined;
    const ext = createKeywordExtractorExtension({
      analyzer: createWinkQueryAnalyzer(),
      log: () => {},
    });
    const agent = new Agent({ model: mockModel() as never });
    // A prior extension with higher priority writes its own key first.
    const priorExt: Extension = {
      name: 'prior',
      priority: 100,
      install(a) {
        a.hook('beforeTurn', 'prior', async (ctx) => {
          ctx.turn.metadata.sessionMeta = { sentiment: 'positive' };
        });
      },
    };
    agent.use(priorExt);
    // keyword-extractor (priority 50) runs second and should merge, not overwrite.
    agent.use(ext);
    // Observe after both have run (default priority 0 = last).
    agent.hook('beforeTurn', 'observer', async (ctx) => {
      capturedMeta = ctx.turn.metadata.sessionMeta as Record<string, unknown> | undefined;
    });

    await agent.run({ message: 'Find the MCP documentation' });

    expect(capturedMeta).toBeDefined();
    expect(capturedMeta!.sentiment).toBe('positive');
    expect(capturedMeta!.keywords).toBeDefined();
    expect((capturedMeta!.keywords as { terms: string[] }).terms).toContain('MCP');
  });
});
