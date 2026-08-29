import { describe, it, expect } from 'vitest';
import { Agent } from '../../../agent.js';
import { createTokenStatsExtension } from './index.js';

// ── Mock model ─────────────────────────────────────────────────────
function mockModel(responses: any[]) {
  let callCount = 0;
  return {
    async generate(req: any) {
      const resp = responses[Math.min(callCount, responses.length - 1)];
      callCount++;
      if (typeof resp.message === 'function') {
        return { ...resp, message: resp.message(req) };
      }
      return resp;
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('token-stats extension', () => {
  it('appends stats to the final response', async () => {
    const model = mockModel([{
      message: { role: 'assistant', content: 'Hello!' },
      finishReason: 'stop',
      usage: { promptTokens: 1000, completionTokens: 50 },
    }]);

    const ext = createTokenStatsExtension({ contextWindow: 128000 });
    const agent = new Agent({ model: model as any });
    agent.use(ext);

    const result = await agent.run({ message: 'hi' });

    expect(result.message).toContain('Hello!');
    expect(result.message).toContain('📊');
    expect(result.message).toContain('1.0K prompt + 50 completion');
    expect(result.message).toContain('1 LLM call');
    expect(result.message).toContain('1% of 128.0K context');
  });

  it('uses Slack italics by default', async () => {
    const model = mockModel([{
      message: { role: 'assistant', content: 'Hi' },
      finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 10 },
    }]);

    const ext = createTokenStatsExtension({ contextWindow: 128000 });
    const agent = new Agent({ model: model as any });
    agent.use(ext);

    const result = await agent.run({ message: 'hi' });

    // Should be wrapped in _..._ for Slack italics.
    expect(result.message).toMatch(/_📊.*_/);
  });

  it('disables italics when configured', async () => {
    const model = mockModel([{
      message: { role: 'assistant', content: 'Hi' },
      finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 10 },
    }]);

    const ext = createTokenStatsExtension({ contextWindow: 128000, slackItalics: false });
    const agent = new Agent({ model: model as any });
    agent.use(ext);

    const result = await agent.run({ message: 'hi' });

    expect(result.message).not.toMatch(/_📊.*_/);
    expect(result.message).toContain('📊');
  });

  it('omits context percentage when contextWindow not set', async () => {
    const model = mockModel([{
      message: { role: 'assistant', content: 'Hi' },
      finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 10 },
    }]);

    const ext = createTokenStatsExtension();
    const agent = new Agent({ model: model as any });
    agent.use(ext);

    const result = await agent.run({ message: 'hi' });

    expect(result.message).toContain('100 prompt + 10 completion');
    expect(result.message).not.toContain('context');
  });

  it('accumulates usage across multiple LLM calls', async () => {
    const tool = {
      name: 'echo',
      description: 'Echo',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { toolCallId: '', content: 'echoed' };
      },
    };

    const model = mockModel([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
        usage: { promptTokens: 500, completionTokens: 20 },
      },
      {
        message: { role: 'assistant', content: 'Done' },
        finishReason: 'stop',
        usage: { promptTokens: 800, completionTokens: 30 },
      },
    ]);

    const ext = createTokenStatsExtension({ contextWindow: 128000 });
    const agent = new Agent({ model: model as any, tools: [tool] });
    agent.use(ext);

    const result = await agent.run({ message: 'call echo' });

    // Should show accumulated totals: 500+800=1300 prompt, 20+30=50 completion.
    expect(result.message).toContain('1.3K prompt + 50 completion');
    expect(result.message).toContain('2 LLM calls');
  });

  it('shows cache read, cache write, and reasoning tokens when present', async () => {
    const model = mockModel([{
      message: { role: 'assistant', content: 'Hi' },
      finishReason: 'stop',
      usage: {
        promptTokens: 10000,
        completionTokens: 100,
        cachedPromptTokens: 5000,
        cacheWriteTokens: 3000,
        reasoningTokens: 200,
      },
    }]);

    const ext = createTokenStatsExtension({ contextWindow: 128000 });
    const agent = new Agent({ model: model as any });
    agent.use(ext);

    const result = await agent.run({ message: 'hi' });

    expect(result.message).toContain('cache:');
    expect(result.message).toContain('5.0K read');
    expect(result.message).toContain('3.0K written');
    expect(result.message).toContain('200 reasoning');
  });

  it('shows only cache read when no cache write', async () => {
    const model = mockModel([{
      message: { role: 'assistant', content: 'Hi' },
      finishReason: 'stop',
      usage: {
        promptTokens: 10000,
        completionTokens: 100,
        cachedPromptTokens: 5000,
      },
    }]);

    const ext = createTokenStatsExtension({ contextWindow: 128000 });
    const agent = new Agent({ model: model as any });
    agent.use(ext);

    const result = await agent.run({ message: 'hi' });

    expect(result.message).toContain('cache:');
    expect(result.message).toContain('5.0K read');
    expect(result.message).not.toContain('written');
  });

  it('omits cache/reasoning when not reported', async () => {
    const model = mockModel([{
      message: { role: 'assistant', content: 'Hi' },
      finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 10 },
    }]);

    const ext = createTokenStatsExtension({ contextWindow: 128000 });
    const agent = new Agent({ model: model as any });
    agent.use(ext);

    const result = await agent.run({ message: 'hi' });

    expect(result.message).not.toContain('cached');
    expect(result.message).not.toContain('reasoning');
  });

  it('does not append stats when no usage is reported', async () => {
    const model = mockModel([{
      message: { role: 'assistant', content: 'Hi' },
      finishReason: 'stop',
    }]);

    const ext = createTokenStatsExtension({ contextWindow: 128000 });
    const agent = new Agent({ model: model as any });
    agent.use(ext);

    const result = await agent.run({ message: 'hi' });

    expect(result.message).toBe('Hi');
  });

  it('supports custom label', async () => {
    const model = mockModel([{
      message: { role: 'assistant', content: 'Hi' },
      finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 10 },
    }]);

    const ext = createTokenStatsExtension({ contextWindow: 128000, label: 'Tokens:' });
    const agent = new Agent({ model: model as any });
    agent.use(ext);

    const result = await agent.run({ message: 'hi' });

    expect(result.message).toContain('Tokens:');
    expect(result.message).not.toContain('📊');
  });

  it('computes context percentage correctly', async () => {
    const model = mockModel([{
      message: { role: 'assistant', content: 'Hi' },
      finishReason: 'stop',
      usage: { promptTokens: 64000, completionTokens: 100 },
    }]);

    const ext = createTokenStatsExtension({ contextWindow: 128000 });
    const agent = new Agent({ model: model as any });
    agent.use(ext);

    const result = await agent.run({ message: 'hi' });

    expect(result.message).toContain('50% of 128.0K context');
  });
});
