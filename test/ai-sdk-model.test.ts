import { describe, expect, it } from 'vitest';
import { AISdkModel, type Message, type MessageContent, type ToolDefinition } from 'libra-harness';

// ── Fake V4 LanguageModel ───────────────────────────────────────────

interface FakeStreamPart {
  type: string;
  [key: string]: unknown;
}

function fakeModel(opts: {
  doGenerate?: (opts: any) => any;
  doStream?: (opts: any) => any;
} = {}) {
  return {
    specificationVersion: 'v4' as const,
    provider: 'fake',
    modelId: 'fake-1',
    doGenerate: opts.doGenerate ?? (async () => ({
      content: [{ type: 'text', text: 'hello' }],
      finishReason: { unified: 'stop', provider: 'stop' },
      usage: { inputTokens: { total: 5 }, outputTokens: { total: 10 } },
    })),
    doStream: opts.doStream ?? (async () => {
      const parts: FakeStreamPart[] = [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'hello' },
        { type: 'text-delta', id: 't1', delta: ' world' },
        { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 2 } } },
      ];
      return { stream: new ReadableStream({
        start(controller) {
          for (const p of parts) controller.enqueue(p);
          controller.close();
        },
      }) };
    }),
  };
}

function user(content: MessageContent): Message {
  return { role: 'user', content };
}

// ── Batch generation ────────────────────────────────────────────────

describe('AISdkModel batch generation', () => {
  it('converts text response to a string content message', async () => {
    const model = new AISdkModel(fakeModel({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'hi there' }],
        finishReason: { unified: 'stop', provider: 'stop' },
        usage: { inputTokens: { total: 3 }, outputTokens: { total: 7 } },
      }),
    }));

    const response = await model.generate({ messages: [user('hello')] });
    expect(response.message.role).toBe('assistant');
    expect(response.message.content).toBe('hi there');
    expect(response.finishReason).toBe('stop');
    expect(response.usage?.promptTokens).toBe(3);
    expect(response.usage?.completionTokens).toBe(7);
  });

  it('maps tool-calls finish reason and collects tool calls', async () => {
    const model = new AISdkModel(fakeModel({
      doGenerate: async () => ({
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'get_weather', input: { city: 'SF' } },
        ],
        finishReason: { unified: 'tool-calls', provider: 'tool_calls' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 2 } },
      }),
    }));

    const response = await model.generate({ messages: [user('weather?')] });
    expect(response.finishReason).toBe('tool_calls');
    expect(response.message.toolCalls).toEqual([
      { id: 'call-1', name: 'get_weather', arguments: JSON.stringify({ city: 'SF' }) },
    ]);
  });

  it('maps length and content-filter finish reasons', async () => {
    for (const [unified, expected] of [['length', 'length'], ['content-filter', 'content_filter']] as const) {
      const model = new AISdkModel(fakeModel({
        doGenerate: async () => ({
          content: [{ type: 'text', text: '...' }],
          finishReason: { unified, provider: unified },
          usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
        }),
      }));
      const response = await model.generate({ messages: [user('x')] });
      expect(response.finishReason).toBe(expected);
    }
  });

  it('preserves file content in the response', async () => {
    const model = new AISdkModel(fakeModel({
      doGenerate: async () => ({
        content: [
          { type: 'file', mediaType: 'image/png', data: { type: 'url', url: new URL('https://example.com/img.png') } },
        ],
        finishReason: { unified: 'stop', provider: 'stop' },
        usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
      }),
    }));

    const response = await model.generate({ messages: [user('generate an image')] });
    expect(Array.isArray(response.message.content)).toBe(true);
    const parts = response.message.content as any[];
    expect(parts[0].type).toBe('file');
    expect(parts[0].mediaType).toBe('image/png');
    expect(parts[0].data).toEqual({ type: 'url', url: 'https://example.com/img.png' });
  });

  it('extracts cache and reasoning token usage', async () => {
    const model = new AISdkModel(fakeModel({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', provider: 'stop' },
        usage: {
          inputTokens: { total: 100, cacheRead: 50, cacheWrite: 20 },
          outputTokens: { total: 200, reasoning: 80 },
        },
      }),
    }));

    const response = await model.generate({ messages: [user('x')] });
    expect(response.usage?.cachedPromptTokens).toBe(50);
    expect(response.usage?.cacheWriteTokens).toBe(20);
    expect(response.usage?.reasoningTokens).toBe(80);
  });
});

// ── Prompt conversion ───────────────────────────────────────────────

describe('AISdkModel prompt conversion', () => {
  it('passes system prompt and messages to doGenerate', async () => {
    let captured: any;
    const model = new AISdkModel(fakeModel({
      doGenerate: async (opts: any) => {
        captured = opts;
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: { unified: 'stop', provider: 'stop' },
          usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
        };
      },
    }));

    await model.generate({
      systemPrompt: 'be helpful',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'https://x/img.png' } }] },
      ],
    });

    expect(captured.prompt[0]).toEqual({ role: 'system', content: 'be helpful' });
    expect(captured.prompt[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    expect(captured.prompt[2]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'hello' }] });
    expect(captured.prompt[3].role).toBe('user');
    expect(captured.prompt[3].content).toHaveLength(2);
    expect(captured.prompt[3].content[1]).toMatchObject({ type: 'file', mediaType: 'image/png' });
  });

  it('converts tool messages to tool-result parts', async () => {
    let captured: any;
    const model = new AISdkModel(fakeModel({
      doGenerate: async (opts: any) => {
        captured = opts;
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: { unified: 'stop', provider: 'stop' },
          usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
        };
      },
    }));

    await model.generate({
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: '{"city":"SF"}' }] },
        { role: 'tool', content: 'sunny', toolCallId: 'c1', name: 'get_weather' },
      ],
    });

    const toolMsg = captured.prompt.find((p: any) => p.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content[0]).toEqual({
      type: 'tool-result',
      toolCallId: 'c1',
      toolName: 'get_weather',
      output: { type: 'text', value: 'sunny' },
    });

    const assistantMsg = captured.prompt.find((p: any) => p.role === 'assistant');
    expect(assistantMsg.content).toContainEqual({
      type: 'tool-call',
      toolCallId: 'c1',
      toolName: 'get_weather',
      input: { city: 'SF' },
    });
  });

  it('passes tools and parameters to doGenerate', async () => {
    let captured: any;
    const model = new AISdkModel(fakeModel({
      doGenerate: async (opts: any) => {
        captured = opts;
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: { unified: 'stop', provider: 'stop' },
          usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
        };
      },
    }));

    const tools: ToolDefinition[] = [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    }];

    await model.generate({
      messages: [user('weather?')],
      tools,
      temperature: 0.5,
      maxTokens: 100,
    });

    expect(captured.tools).toEqual([{
      type: 'function',
      name: 'get_weather',
      description: 'Get weather',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
    }]);
    expect(captured.temperature).toBe(0.5);
    expect(captured.maxOutputTokens).toBe(100);
  });
});

// ── Streaming ───────────────────────────────────────────────────────

describe('AISdkModel streaming', () => {
  it('assembles text deltas and invokes onDelta', async () => {
    const model = new AISdkModel(fakeModel());
    const deltas: { type: string; content: string }[] = [];

    const response = await model.generate({
      messages: [user('hi')],
      onDelta: (d) => deltas.push({ type: d.type, content: d.content }),
    });

    expect(response.message.content).toBe('hello world');
    expect(response.finishReason).toBe('stop');
    expect(deltas.filter((d) => d.type === 'text').map((d) => d.content)).toEqual(['hello', ' world']);
  });

  it('assembles tool calls from tool-input stream parts', async () => {
    const model = new AISdkModel(fakeModel({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'tool-input-start', id: 'tc1', toolName: 'get_weather', providerExecuted: false });
            controller.enqueue({ type: 'tool-input-delta', id: 'tc1', delta: '{"city":"SF"}', providerExecuted: false });
            controller.enqueue({ type: 'tool-input-end', id: 'tc1' });
            controller.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls' }, usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } } });
            controller.close();
          },
        }),
      }),
    }));

    const response = await model.generate({
      messages: [user('weather?')],
      onDelta: () => {},
    });

    expect(response.finishReason).toBe('tool_calls');
    expect(response.message.toolCalls).toEqual([
      { id: 'tc1', name: 'get_weather', arguments: '{"city":"SF"}' },
    ]);
  });

  it('ignores provider-executed tool calls', async () => {
    const model = new AISdkModel(fakeModel({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'tool-input-start', id: 'tc1', toolName: 'search', providerExecuted: true });
            controller.enqueue({ type: 'tool-input-delta', id: 'tc1', delta: 'q', providerExecuted: true });
            controller.enqueue({ type: 'tool-input-end', id: 'tc1' });
            controller.enqueue({ type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } } });
            controller.close();
          },
        }),
      }),
    }));

    const response = await model.generate({
      messages: [user('search?')],
      onDelta: () => {},
    });

    expect(response.message.toolCalls).toBeUndefined();
  });

  it('throws on stream error parts', async () => {
    const model = new AISdkModel(fakeModel({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'error', error: new Error('upstream failed') });
            controller.close();
          },
        }),
      }),
    }));

    await expect(model.generate({
      messages: [user('hi')],
      onDelta: () => {},
    })).rejects.toThrow('upstream failed');
  });
});
