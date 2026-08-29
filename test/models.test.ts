import { describe, expect, it } from 'vitest';
import {
  hasFileContent,
  messageContentToText,
  type Message,
  type MessageContent,
} from 'libra-harness';
import {
  configuredProviders,
  createRoutingModel,
  hasFileInput,
  hasImageInput,
  nativeAISdkProviders,
  resolveModel,
  type AISdkProviderDefinition,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from 'libra-harness/extras/models';
import { AISdkModel } from 'libra-harness';

// ── Helpers ─────────────────────────────────────────────────────────

class RecordingModel implements Model {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly name: string, private readonly response?: ModelResponse) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push({
      ...request,
      messages: request.messages.map((m) => ({ ...m })),
    });
    return this.response ?? {
      message: { role: 'assistant', content: `${this.name}: ${messageContentToText(request.messages.at(-1)?.content ?? '')}` },
      finishReason: 'stop',
    };
  }
}

function userMessage(content: MessageContent): Message {
  return { role: 'user', content };
}

function imagePart(): MessageContent {
  return [
    { type: 'text', text: 'describe this' },
    { type: 'file', mediaType: 'image/png', filename: 'pic.png', data: { type: 'url', url: 'https://example.com/pic.png' } },
  ];
}

function pdfPart(): MessageContent {
  return [
    { type: 'text', text: 'summarize' },
    { type: 'file', mediaType: 'application/pdf', filename: 'doc.pdf', data: { type: 'data', data: 'abc' } },
  ];
}

// ── Content helpers ─────────────────────────────────────────────────

describe('messageContentToText', () => {
  it('returns strings unchanged', () => {
    expect(messageContentToText('hello')).toBe('hello');
  });

  it('joins text parts', () => {
    expect(messageContentToText([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ])).toBe('a\nb');
  });

  it('renders file parts as placeholders', () => {
    expect(messageContentToText([
      { type: 'text', text: 'see' },
      { type: 'file', mediaType: 'image/png', filename: 'pic.png', data: { type: 'url', url: 'https://x' } },
    ])).toBe('see\n[File: pic.png (image/png)]');
  });

  it('renders file parts without filename', () => {
    expect(messageContentToText([
      { type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: 'x' } },
    ])).toBe('[File: application/pdf]');
  });
});

describe('hasFileContent', () => {
  it('returns false for plain strings', () => {
    expect(hasFileContent('hello')).toBe(false);
  });

  it('returns true when a file part is present', () => {
    expect(hasFileContent(imagePart())).toBe(true);
  });

  it('filters by media type prefix', () => {
    expect(hasFileContent(imagePart(), 'image/')).toBe(true);
    expect(hasFileContent(pdfPart(), 'image/')).toBe(false);
    expect(hasFileContent(pdfPart(), 'application/')).toBe(true);
  });

  it('returns false for text-only arrays', () => {
    expect(hasFileContent([{ type: 'text', text: 'hi' }])).toBe(false);
  });
});

// ── Routing model ───────────────────────────────────────────────────

describe('createRoutingModel', () => {
  it('routes to the first matching route', async () => {
    const defaultModel = new RecordingModel('default');
    const visionModel = new RecordingModel('vision');
    const routed = createRoutingModel({
      default: defaultModel,
      routes: [{ when: hasImageInput, model: visionModel }],
    });

    await routed.generate({
      messages: [userMessage('just text')],
    });
    expect(defaultModel.requests).toHaveLength(1);
    expect(visionModel.requests).toHaveLength(0);

    await routed.generate({
      messages: [userMessage(imagePart())],
    });
    expect(defaultModel.requests).toHaveLength(1);
    expect(visionModel.requests).toHaveLength(1);
  });

  it('falls back to default when no route matches', async () => {
    const defaultModel = new RecordingModel('default');
    const routed = createRoutingModel({
      default: defaultModel,
      routes: [{ when: () => false, model: new RecordingModel('never') }],
    });

    await routed.generate({ messages: [userMessage('hi')] });
    expect(defaultModel.requests).toHaveLength(1);
  });

  it('supports async route predicates', async () => {
    const defaultModel = new RecordingModel('default');
    const specialModel = new RecordingModel('special');
    const routed = createRoutingModel({
      default: defaultModel,
      routes: [{ when: async () => true, model: specialModel }],
    });

    await routed.generate({ messages: [userMessage('hi')] });
    expect(specialModel.requests).toHaveLength(1);
    expect(defaultModel.requests).toHaveLength(0);
  });
});

describe('hasImageInput / hasFileInput', () => {
  it('detects image content', () => {
    const request: ModelRequest = { messages: [userMessage(imagePart())] };
    expect(hasImageInput(request)).toBe(true);
    expect(hasFileInput(request)).toBe(true);
  });

  it('detects non-image file content', () => {
    const request: ModelRequest = { messages: [userMessage(pdfPart())] };
    expect(hasImageInput(request)).toBe(false);
    expect(hasFileInput(request)).toBe(true);
  });

  it('returns false for text-only messages', () => {
    const request: ModelRequest = { messages: [userMessage('hello')] };
    expect(hasImageInput(request)).toBe(false);
    expect(hasFileInput(request)).toBe(false);
  });
});

// ── AI SDK resolver ─────────────────────────────────────────────────

describe('resolveModel', () => {
  it('rejects invalid model IDs', async () => {
    await expect(resolveModel('noprovider')).rejects.toThrow(/Invalid model ID/);
    await expect(resolveModel('/model')).rejects.toThrow(/Invalid model ID/);
    await expect(resolveModel('provider/')).rejects.toThrow(/Invalid model ID/);
  });

  it('rejects unknown providers', async () => {
    await expect(resolveModel('unknown/model')).rejects.toThrow(/Unsupported provider/);
  });

  it('rejects when the provider env var is not set', async () => {
    await expect(resolveModel('openai/gpt-4', { env: {} })).rejects.toThrow(/OPENAI_API_KEY is not configured/);
  });

  it('resolves a model via a custom provider definition', async () => {
    const fakeProvider = (modelId: string): any => ({
      specificationVersion: 'v4',
      provider: 'test',
      modelId,
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', provider: 'stop' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 2 } },
      }),
      doStream: async () => { throw new Error('not used'); },
    });

    const providers: Readonly<Record<string, AISdkProviderDefinition>> = {
      test: {
        envVar: 'TEST_KEY',
        async load() { return fakeProvider; },
      },
    };

    const model = await resolveModel('test/my-model', { env: { TEST_KEY: 'x' }, providers });
    expect(model).toBeInstanceOf(AISdkModel);

    const response = await model.generate({ messages: [userMessage('hi')] });
    expect(messageContentToText(response.message.content)).toBe('ok');
    expect(response.finishReason).toBe('stop');
    expect(response.usage?.promptTokens).toBe(1);
    expect(response.usage?.completionTokens).toBe(2);
  });
});

describe('configuredProviders', () => {
  it('lists providers whose env vars are set', () => {
    const env = {
      OPENAI_API_KEY: 'sk-x',
      DEEPSEEK_API_KEY: 'sk-y',
    };
    expect(configuredProviders(env)).toEqual(['deepseek', 'openai']);
  });

  it('returns empty when no env vars are set', () => {
    expect(configuredProviders({})).toEqual([]);
  });

  it('ignores empty/whitespace values', () => {
    expect(configuredProviders({ OPENAI_API_KEY: '  ' })).toEqual([]);
  });

  it('uses custom provider definitions', () => {
    const providers: Readonly<Record<string, AISdkProviderDefinition>> = {
      custom: { envVar: 'CUSTOM_KEY', async load() { return () => null as any; } },
    };
    expect(configuredProviders({ CUSTOM_KEY: 'x' }, providers)).toEqual(['custom']);
  });
});

// ── Native provider registry ────────────────────────────────────────

describe('nativeAISdkProviders', () => {
  it('includes openai, anthropic, google, and deepseek', () => {
    expect(Object.keys(nativeAISdkProviders).sort()).toEqual(['anthropic', 'deepseek', 'google', 'openai']);
  });

  it('each provider has an envVar and a load function', () => {
    for (const def of Object.values(nativeAISdkProviders)) {
      expect(typeof def.envVar).toBe('string');
      expect(typeof def.load).toBe('function');
    }
  });
});
