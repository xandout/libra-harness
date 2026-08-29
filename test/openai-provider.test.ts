import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent, type Model, type ModelRequest, type ModelResponse, type ToolCall } from '../src/index.js';
import { createOpenAICompatibleServer } from '../src/extras/openai-provider/index.js';

class RecordingModel implements Model {
  readonly requests: ModelRequest[] = [];
  private callCount = 0;

  constructor(
    private readonly name: string,
    private readonly toolCallOnFirst?: ToolCall[],
  ) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push({
      ...request,
      messages: request.messages.map((message) => ({ ...message })),
    });
    this.callCount++;

    if (this.callCount === 1 && this.toolCallOnFirst) {
      return {
        message: { role: 'assistant', content: '', toolCalls: this.toolCallOnFirst },
        finishReason: 'tool_calls',
      };
    }

    const latestUser = [...request.messages].reverse().find((message) => message.role === 'user');
    return {
      message: { role: 'assistant', content: `${this.name}: ${latestUser?.content ?? ''}` },
      finishReason: 'stop',
    };
  }
}

const servers: ReturnType<typeof createOpenAICompatibleServer>[] = [];

async function startProvider() {
  const firstModel = new RecordingModel('agent-1');
  const secondModel = new RecordingModel('agent-2');
  const server = createOpenAICompatibleServer({
    apiKeys: ['provider-key-one', 'provider-key-two'],
    agents: {
      'libra-provider/agent-1': new Agent({ model: firstModel, systemPrompt: 'First agent' }),
      'libra-provider/agent-2': new Agent({ model: secondModel, systemPrompt: 'Second agent' }),
    },
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, firstModel, secondModel };
}

function request(baseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: 'Bearer provider-key-one',
      'content-type': 'application/json',
      ...init.headers,
    },
  });
}

async function responseJson(response: Response): Promise<any> {
  return response.json();
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('OpenAI-compatible provider', () => {
  it('requires a valid API key', async () => {
    const { baseUrl } = await startProvider();
    const response = await fetch(`${baseUrl}/v1/models`);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect((await responseJson(response)).error.code).toBe('invalid_api_key');
  });

  it('accepts any configured API key and lists both agents as models', async () => {
    const { baseUrl } = await startProvider();
    const response = await fetch(`${baseUrl}/v1/models`, { headers: { 'x-api-key': 'provider-key-two' } });
    expect(response.status).toBe(200);
    expect((await responseJson(response)).data.map((model: { id: string }) => model.id)).toEqual([
      'libra-provider/agent-1',
      'libra-provider/agent-2',
    ]);
  });

  it('routes requests to independent agents and preserves message history', async () => {
    const { baseUrl, firstModel, secondModel } = await startProvider();
    const messages = [
      { role: 'system', content: 'Answer clearly.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Follow-up' },
    ];

    const firstResponse = await request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'libra-provider/agent-1', messages }),
    });
    const secondResponse = await request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'libra-provider/agent-2', messages: [{ role: 'user', content: 'Hello' }] }),
    });

    expect((await responseJson(firstResponse)).choices[0].message.content).toBe('agent-1: Follow-up');
    expect((await responseJson(secondResponse)).choices[0].message.content).toBe('agent-2: Hello');
    expect(firstModel.requests[0].systemPrompt).toBe('First agent');
    expect(firstModel.requests[0].messages).toEqual(messages);
    expect(secondModel.requests).toHaveLength(1);
  });

  it('returns a model-not-found error', async () => {
    const { baseUrl } = await startProvider();
    const response = await request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'libra-provider/missing', messages: [{ role: 'user', content: 'Hello' }] }),
    });
    expect(response.status).toBe(404);
    expect((await responseJson(response)).error.code).toBe('model_not_found');
  });

  it('supports OpenAI-compatible SSE responses', async () => {
    const { baseUrl } = await startProvider();
    const response = await request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'libra-provider/agent-1', stream: true, messages: [{ role: 'user', content: 'Stream me' }] }),
    });
    const body = await response.text();
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('agent-1: Stream me');
    expect(body).toContain('data: [DONE]');
  });

  it('converts image_url parts to multimodal file content', async () => {
    const { baseUrl, firstModel } = await startProvider();
    const response = await request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'libra-provider/agent-1',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image_url', image_url: { url: 'https://example.com/photo.png' } },
          ],
        }],
      }),
    });
    expect(response.status).toBe(200);
    const request0 = firstModel.requests[0];
    const lastMessage = request0.messages.at(-1);
    expect(Array.isArray(lastMessage?.content)).toBe(true);
    const parts = lastMessage!.content as any[];
    expect(parts[0]).toEqual({ type: 'text', text: 'What is in this image?' });
    expect(parts[1].type).toBe('file');
    expect(parts[1].mediaType).toBe('image/png');
    expect(parts[1].data).toEqual({ type: 'url', url: 'https://example.com/photo.png' });
  });

  it('parses base64 data URLs into file data', async () => {
    const { baseUrl, firstModel } = await startProvider();
    const response = await request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'libra-provider/agent-1',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } },
          ],
        }],
      }),
    });
    expect(response.status).toBe(200);
    const lastMessage = firstModel.requests[0].messages.at(-1);
    const parts = lastMessage!.content as any[];
    expect(parts[0].type).toBe('file');
    expect(parts[0].mediaType).toBe('image/jpeg');
    expect(parts[0].data).toEqual({ type: 'data', data: '/9j/4AAQ' });
  });

  it('rejects unsupported content part types', async () => {
    const { baseUrl } = await startProvider();
    const response = await request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'libra-provider/agent-1',
        messages: [{
          role: 'user',
          content: [{ type: 'audio_url', audio_url: { url: 'https://example.com/audio.mp3' } }],
        }],
      }),
    });
    expect(response.status).toBe(400);
    expect((await responseJson(response)).error.message).toContain('Unsupported content part type');
  });

  it('accepts client-defined tools and returns tool_calls for external tools', async () => {
    const toolCallModel = new RecordingModel('agent-1', [
      { id: 'call-001', name: 'get_weather', arguments: '{"city":"SF"}' },
    ]);
    const server = createOpenAICompatibleServer({
      apiKeys: ['provider-key-one'],
      agents: { 'libra-provider/agent-1': new Agent({ model: toolCallModel, systemPrompt: 'First agent' }) },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'libra-provider/agent-1',
        messages: [{ role: 'user', content: 'What is the weather in SF?' }],
        tools: [{
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather for a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        }],
      }),
    });

    expect(response.status).toBe(200);
    const json = await responseJson(response);
    expect(json.choices[0].finish_reason).toBe('tool_calls');
    expect(json.choices[0].message.tool_calls).toEqual([
      { id: 'call-001', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
    ]);
    expect(toolCallModel.requests).toHaveLength(1);
  });

  it('resumes the turn when the client sends back tool results', async () => {
    const toolCallModel = new RecordingModel('agent-1', [
      { id: 'call-002', name: 'search_db', arguments: '{"query":"users"}' },
    ]);
    const server = createOpenAICompatibleServer({
      apiKeys: ['provider-key-one'],
      agents: { 'libra-provider/agent-1': new Agent({ model: toolCallModel, systemPrompt: 'First agent' }) },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const firstResponse = await request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'libra-provider/agent-1',
        messages: [{ role: 'user', content: 'Search for users' }],
        tools: [{
          type: 'function',
          function: { name: 'search_db', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
        }],
      }),
    });
    const firstJson = await responseJson(firstResponse);
    expect(firstJson.choices[0].finish_reason).toBe('tool_calls');

    const secondResponse = await request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'libra-provider/agent-1',
        messages: [
          { role: 'user', content: 'Search for users' },
          { role: 'assistant', content: '', tool_calls: firstJson.choices[0].message.tool_calls },
          { role: 'tool', tool_call_id: 'call-002', content: 'Found 3 users: Alice, Bob, Carol' },
        ],
        tools: [{
          type: 'function',
          function: { name: 'search_db', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
        }],
      }),
    });

    expect(secondResponse.status).toBe(200);
    const secondJson = await responseJson(secondResponse);
    expect(secondJson.choices[0].finish_reason).toBe('stop');
    expect(secondJson.choices[0].message.content).toContain('agent-1');
    expect(toolCallModel.requests).toHaveLength(2);
    const secondRequestMessages = toolCallModel.requests[1].messages;
    expect(secondRequestMessages.some((m: any) => m.role === 'tool' && m.content === 'Found 3 users: Alice, Bob, Carol')).toBe(true);
  });

  it('passes both external and agent-internal tools to the model', async () => {
    const toolCallModel = new RecordingModel('agent-1', [
      { id: 'call-003', name: 'client_tool', arguments: '{}' },
    ]);
    const agent = new Agent({ model: toolCallModel, systemPrompt: 'First agent' });
    agent.tool({
      name: 'internal_tool',
      parameters: { type: 'object', properties: {} },
      async execute() { return { toolCallId: '', content: 'internal result' }; },
    });
    const server = createOpenAICompatibleServer({
      apiKeys: ['provider-key-one'],
      agents: { 'libra-provider/agent-1': agent },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await request(baseUrl, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'libra-provider/agent-1',
        messages: [{ role: 'user', content: 'Use the client tool' }],
        tools: [{
          type: 'function',
          function: { name: 'client_tool', parameters: { type: 'object', properties: {} } },
        }],
      }),
    });

    const json = await responseJson(response);
    expect(json.choices[0].finish_reason).toBe('tool_calls');
    const tools = toolCallModel.requests[0].tools;
    expect(tools?.map((t: any) => t.function.name)).toContain('internal_tool');
    expect(tools?.map((t: any) => t.function.name)).toContain('client_tool');
  });
});
