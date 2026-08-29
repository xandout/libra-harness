import { describe, it, expect, beforeEach } from 'vitest';
import { SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { Agent } from '../../../agent.js';
import { createOtelExtension } from './index.js';

// ── In-memory span recorder ────────────────────────────────────────
// A custom tracer that captures all spans in memory so tests can
// inspect the span hierarchy and attributes without a real exporter.

interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  status: { code: SpanStatusCode; message?: string };
  events: { name: string; attributes?: Record<string, string | number | boolean> }[];
  parentSpanId?: string;
  spanId: string;
  ended: boolean;
  startTime: number;
  endTime: number;
}

function createInMemoryTracer(): Tracer & { spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  let counter = 0;

  function makeSpan(name: string, parentSpanId?: string): Span {
    const span: RecordedSpan = {
      name,
      attributes: {},
      status: { code: SpanStatusCode.UNSET },
      events: [],
      parentSpanId,
      spanId: `span_${counter++}`,
      ended: false,
      startTime: performance.now(),
      endTime: 0,
    };
    spans.push(span);

    const spanApi: Span = {
      spanContext: () => ({
        traceId: 'test-trace',
        spanId: span.spanId,
        traceFlags: 1,
        isRemote: false,
      }),
      setAttribute(key: string, value: string | number | boolean) {
        span.attributes[key] = value;
        return spanApi;
      },
      setAttributes(attrs: Record<string, string | number | boolean>) {
        Object.assign(span.attributes, attrs);
        return spanApi;
      },
      addEvent(name: string, attributes?: Record<string, string | number | boolean>) {
        span.events.push({ name, attributes });
        return spanApi;
      },
      setStatus(status: { code: SpanStatusCode; message?: string }) {
        span.status = status;
        return spanApi;
      },
      end() {
        span.ended = true;
        span.endTime = performance.now();
      },
      isRecording() {
        return !span.ended;
      },
      recordException(exception: Error | string) {
        const msg = typeof exception === 'string' ? exception : exception.message;
        span.events.push({ name: 'exception', attributes: { 'exception.message': msg } });
      },
      updateName(name: string) {
        span.name = name;
        return spanApi;
      },
      addLink: () => spanApi,
      addLinks: () => spanApi,
    };

    // Store the spanId on the Span object so the tracer can find the
    // parent when creating child spans.
    (spanApi as any)._spanId = span.spanId;

    return spanApi;
  }

  const tracer: Tracer & { spans: RecordedSpan[] } = {
    spans,
    startSpan(name: string, _options?: any, ctx?: any) {
      // Extract parent spanId from context.
      const parentSpan = ctx ? (ctx as any)._activeSpan : undefined;
      const parentSpanId = parentSpan?._spanId;
      const span = makeSpan(name, parentSpanId);
      // Store on context for child spans — but since we're using a
      // simplified context, we stash it on the returned span.
      (span as any)._activeSpan = span;
      return span;
    },
    startActiveSpan(name: string, fn: any) {
      const span = makeSpan(name);
      return fn(span);
    },
  } as any;

  return tracer;
}

// ── Mock model ─────────────────────────────────────────────────────
function mockModel(responses: any[] = [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }]) {
  let callCount = 0;
  return {
    async generate(req: any) {
      const resp = responses[Math.min(callCount, responses.length - 1)];
      callCount++;
      if (typeof resp === 'function') return resp(req);
      return resp;
    },
  };
}

// ── Test setup ─────────────────────────────────────────────────────
let tracer: ReturnType<typeof createInMemoryTracer>;

beforeEach(() => {
  tracer = createInMemoryTracer();
});

// Helper to find spans by name.
function findSpans(name: string): RecordedSpan[] {
  return tracer.spans.filter((s) => s.name === name);
}

function findSpan(name: string): RecordedSpan {
  const spans = findSpans(name);
  if (spans.length === 0) throw new Error(`No span named "${name}" found`);
  if (spans.length > 1) throw new Error(`Multiple spans named "${name}" found`);
  return spans[0];
}

// ── Tests ──────────────────────────────────────────────────────────

describe('otel extension', () => {
  it('creates a root span for each turn', async () => {
    const ext = createOtelExtension({ tracer });
    const agent = new Agent({ model: mockModel() as any });
    agent.use(ext);

    await agent.run({ message: 'hello' });

    const rootSpan = findSpan('agent.turn');
    expect(rootSpan.ended).toBe(true);
    expect(rootSpan.attributes['libra.turn.finish_reason']).toBe('stop');
    expect(rootSpan.attributes['libra.turn.iterations']).toBe(1);
  });

  it('records turn duration and message length', async () => {
    const ext = createOtelExtension({ tracer });
    const agent = new Agent({ model: mockModel() as any });
    agent.use(ext);

    await agent.run({ message: 'hello world' });

    const span = findSpan('agent.turn');
    expect(span.attributes['libra.turn.message_length']).toBe(11);
    expect(span.attributes['libra.turn.duration_ms']).toBeDefined();
    expect(typeof span.attributes['libra.turn.duration_ms']).toBe('number');
  });

  it('creates LLM child spans', async () => {
    const ext = createOtelExtension({ tracer });
    const agent = new Agent({ model: mockModel() as any });
    agent.use(ext);

    await agent.run({ message: 'hi' });

    const llmSpan = findSpan('llm.request');
    expect(llmSpan.ended).toBe(true);
    expect(llmSpan.attributes['libra.llm.message_count']).toBe(1);
    expect(llmSpan.attributes['libra.llm.has_tool_calls']).toBe(false);
  });

  it('records token usage on LLM spans', async () => {
    const model = mockModel([{
      message: { role: 'assistant', content: 'reply' },
      finishReason: 'stop',
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        cachedPromptTokens: 50,
        reasoningTokens: 5,
      },
    }]);
    const ext = createOtelExtension({ tracer });
    const agent = new Agent({ model: model as any });
    agent.use(ext);

    await agent.run({ message: 'hi' });

    const llmSpan = findSpan('llm.request');
    expect(llmSpan.attributes['libra.llm.prompt_tokens']).toBe(100);
    expect(llmSpan.attributes['libra.llm.completion_tokens']).toBe(20);
    expect(llmSpan.attributes['libra.llm.cached_prompt_tokens']).toBe(50);
    expect(llmSpan.attributes['libra.llm.reasoning_tokens']).toBe(5);
  });

  it('creates tool child spans for tool calls', async () => {
    const tool = {
      name: 'echo',
      description: 'Echo tool',
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
      },
      { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' },
    ]);

    const ext = createOtelExtension({ tracer });
    const agent = new Agent({ model: model as any, tools: [tool] });
    agent.use(ext);

    await agent.run({ message: 'call echo' });

    const toolSpan = findSpan('tool.echo');
    expect(toolSpan.ended).toBe(true);
    expect(toolSpan.attributes['libra.tool.name']).toBe('echo');
    expect(toolSpan.attributes['libra.tool.is_error']).toBe(false);
  });

  it('marks error tool calls with ERROR status', async () => {
    const tool = {
      name: 'fail',
      description: 'Always fails',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { toolCallId: '', content: 'Something went wrong', isError: true };
      },
    };

    const model = mockModel([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'fail', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      { message: { role: 'assistant', content: 'sorry' }, finishReason: 'stop' },
    ]);

    const ext = createOtelExtension({ tracer });
    const agent = new Agent({ model: model as any, tools: [tool] });
    agent.use(ext);

    await agent.run({ message: 'call fail' });

    const toolSpan = findSpan('tool.fail');
    expect(toolSpan.attributes['libra.tool.is_error']).toBe(true);
    expect(toolSpan.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('records tool result as a span event', async () => {
    const tool = {
      name: 'echo',
      description: 'Echo',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { toolCallId: '', content: 'hello result' };
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
      },
      { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' },
    ]);

    const ext = createOtelExtension({ tracer, maxResultLength: 100 });
    const agent = new Agent({ model: model as any, tools: [tool] });
    agent.use(ext);

    await agent.run({ message: 'call echo' });

    const toolSpan = findSpan('tool.echo');
    const resultEvent = toolSpan.events.find((e) => e.name === 'tool.result');
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.attributes?.['libra.tool.result']).toBe('hello result');
  });

  it('records exceptions on error', async () => {
    const model = {
      async generate(): Promise<any> {
        throw new Error('model exploded');
      },
    };

    const ext = createOtelExtension({ tracer });
    const agent = new Agent({ model: model as any, errorPolicy: 'fallback' });
    agent.use(ext);

    await agent.run({ message: 'hi' });

    const rootSpan = findSpan('agent.turn');
    const exceptionEvent = rootSpan.events.find((e) => e.name === 'exception');
    expect(exceptionEvent).toBeDefined();
    expect(exceptionEvent!.attributes?.['exception.message']).toBe('model exploded');
    expect(rootSpan.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('sets serviceName attribute when configured', async () => {
    const ext = createOtelExtension({ tracer, serviceName: 'slack-bot' });
    const agent = new Agent({ model: mockModel() as any });
    agent.use(ext);

    await agent.run({ message: 'hi' });

    const rootSpan = findSpan('agent.turn');
    expect(rootSpan.attributes['libra.service']).toBe('slack-bot');
  });

  it('records tool args when recordToolArgs is enabled', async () => {
    const tool = {
      name: 'echo',
      description: 'Echo',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      async execute(args: any) {
        return { toolCallId: '', content: args.text };
      },
    };

    const model = mockModel([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{"text":"hello"}' }],
        },
        finishReason: 'tool_calls',
      },
      { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' },
    ]);

    const ext = createOtelExtension({ tracer, recordToolArgs: true });
    const agent = new Agent({ model: model as any, tools: [tool] });
    agent.use(ext);

    await agent.run({ message: 'call echo' });

    const toolSpan = findSpan('tool.echo');
    expect(toolSpan.attributes['libra.tool.args']).toBe('{"text":"hello"}');
  });

  it('creates multiple LLM spans for multi-iteration turns', async () => {
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
      },
      { message: { role: 'assistant', content: 'final' }, finishReason: 'stop' },
    ]);

    const ext = createOtelExtension({ tracer });
    const agent = new Agent({ model: model as any, tools: [tool] });
    agent.use(ext);

    await agent.run({ message: 'call echo then respond' });

    const llmSpans = findSpans('llm.request');
    expect(llmSpans).toHaveLength(2);

    const rootSpan = findSpan('agent.turn');
    expect(rootSpan.attributes['libra.turn.iterations']).toBe(2);
    expect(rootSpan.attributes['libra.turn.tool_calls']).toBe(1);
  });

  it('is a no-op when no tracer provider is registered', async () => {
    // Don't pass a tracer — use the global (which has no provider registered).
    // Should not throw.
    const ext = createOtelExtension();
    const agent = new Agent({ model: mockModel() as any });
    agent.use(ext);

    const result = await agent.run({ message: 'hi' });
    expect(result.finishReason).toBe('stop');
  });

  it('uses high priority so spans start before other extensions', () => {
    const ext = createOtelExtension({ tracer });
    expect(ext.priority).toBe(200);
  });

  it('records sessionId from metadata by default', async () => {
    const ext = createOtelExtension({ tracer });
    const agent = new Agent({ model: mockModel() as any });
    agent.use(ext);

    await agent.run({ message: 'hi', metadata: { sessionId: 'slack_C123' } });

    const rootSpan = findSpan('agent.turn');
    expect(rootSpan.attributes['libra.turn.sessionId']).toBe('slack_C123');
  });

  it('records nested metadata keys via dot notation', async () => {
    const ext = createOtelExtension({
      tracer,
      metadataKeys: ['sessionId', 'slack.channelId', 'slack.userId'],
    });
    const agent = new Agent({ model: mockModel() as any });
    agent.use(ext);

    await agent.run({
      message: 'hi',
      metadata: {
        sessionId: 'slack_C123',
        slack: {
          channelId: 'C12345678',
          userId: 'U87654321',
        },
      },
    });

    const rootSpan = findSpan('agent.turn');
    expect(rootSpan.attributes['libra.turn.sessionId']).toBe('slack_C123');
    expect(rootSpan.attributes['libra.turn.slack.channelId']).toBe('C12345678');
    expect(rootSpan.attributes['libra.turn.slack.userId']).toBe('U87654321');
  });

  it('skips metadata keys that are objects or missing', async () => {
    const ext = createOtelExtension({
      tracer,
      metadataKeys: ['sessionId', 'slack', 'missing.key'],
    });
    const agent = new Agent({ model: mockModel() as any });
    agent.use(ext);

    await agent.run({
      message: 'hi',
      metadata: {
        sessionId: 's1',
        slack: { channelId: 'C1' }, // object — should be skipped
      },
    });

    const rootSpan = findSpan('agent.turn');
    expect(rootSpan.attributes['libra.turn.sessionId']).toBe('s1');
    expect(rootSpan.attributes['libra.turn.slack']).toBeUndefined();
    expect(rootSpan.attributes['libra.turn.missing.key']).toBeUndefined();
  });
});
