import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Agent } from '../../agent.js';
import type { Message, MessageContent, FileContentData, ToolCall } from '../../types.js';
import type { Tool } from '../../tool.js';

const HISTORY_KEY = 'openaiCompatibleProviderMessages';
const MAX_BODY_BYTES = 10_485_760;
const preparedAgents = new WeakSet<Agent>();

interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: { url: string; detail?: string };
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatCompletionRequest {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  n?: number;
  tools?: OpenAITool[];
  tool_choice?: unknown;
}

export interface OpenAICompatibleProviderConfig {
  agents: Readonly<Record<string, Agent>>;
  apiKeys: readonly string[];
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type = 'invalid_request_error',
    readonly code: string | null = null,
    readonly param: string | null = null,
  ) {
    super(message);
  }
}

function prepareAgent(agent: Agent): void {
  if (preparedAgents.has(agent)) return;
  agent.hook('beforeContext', 'openai-compatible-provider', async (ctx) => {
    const messages = ctx.turn.metadata[HISTORY_KEY];
    if (!Array.isArray(messages)) return;
    ctx.turn.messages.splice(0, ctx.turn.messages.length, ...(messages as Message[]));
  });
  preparedAgents.add(agent);
}

const DATA_URL_RE = /^data:([^;,]+)?(;base64)?,(.*)$/s;
const EXT_TO_MEDIA: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
};

function mediaTypeFromUrl(url: string): string {
  try {
    const ext = new URL(url).pathname.split('.').pop()?.toLowerCase() ?? '';
    return EXT_TO_MEDIA[ext] ?? 'image/png';
  } catch {
    return 'image/png';
  }
}

function toFileData(imageUrl: string): { mediaType: string; data: FileContentData } {
  const match = imageUrl.match(DATA_URL_RE);
  if (match) {
    const mediaType = match[1] || 'image/png';
    const isBase64 = Boolean(match[2]);
    const payload = match[3];
    if (isBase64) return { mediaType, data: { type: 'data', data: payload } };
    return { mediaType, data: { type: 'data', data: decodeURIComponent(payload) } };
  }
  return { mediaType: mediaTypeFromUrl(imageUrl), data: { type: 'url', url: imageUrl } };
}

function toLibraContent(content: OpenAIMessage['content'], param: string): MessageContent {
  if (typeof content === 'string') return content;
  if (content === null) return '';
  if (!Array.isArray(content)) throw new ApiError(400, 'Message content must be a string or content-part array.', 'invalid_request_error', null, param);

  const parts: MessageContent = [];
  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    const partParam = `${param}.${i}`;
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw new ApiError(400, 'text part must include a string "text".', 'invalid_request_error', null, partParam);
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url') {
      const url = part.image_url?.url;
      if (typeof url !== 'string' || !url) throw new ApiError(400, 'image_url part must include image_url.url.', 'invalid_request_error', null, partParam);
      const { mediaType, data } = toFileData(url);
      parts.push({ type: 'file', mediaType, data });
    } else {
      throw new ApiError(400, `Unsupported content part type: ${part.type}. Supported: text, image_url.`, 'invalid_request_error', null, partParam);
    }
  }
  return parts;
}

function contentToText(content: OpenAIMessage['content'], param: string): string {
  const result = toLibraContent(content, param);
  if (typeof result === 'string') return result;
  return result.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('');
}

function toLibraMessages(messages: OpenAIMessage[]): Message[] {
  if (messages.length === 0) throw new ApiError(400, 'messages must not be empty.', 'invalid_request_error', null, 'messages');

  return messages.map((message, index) => {
    const param = `messages.${index}`;
    if (message.role === 'developer' || message.role === 'system') {
      return { role: 'system', content: contentToText(message.content, `${param}.content`) };
    }
    if (message.role === 'user') {
      return { role: 'user', content: toLibraContent(message.content, `${param}.content`) };
    }
    if (message.role === 'assistant') {
      const content = contentToText(message.content, `${param}.content`);
      const toolCalls: ToolCall[] | undefined = message.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));
      return { role: 'assistant', content, ...(toolCalls?.length && { toolCalls }) };
    }
    if (message.role === 'tool' && message.tool_call_id) {
      return { role: 'tool', content: contentToText(message.content, `${param}.content`), toolCallId: message.tool_call_id, name: message.name };
    }
    throw new ApiError(400, `Unsupported message role: ${message.role}`, 'invalid_request_error', null, `${param}.role`);
  });
}

function toExternalTools(tools: OpenAITool[]): Tool[] {
  return tools.map((tool) => {
    if (tool.type !== 'function' || !tool.function?.name) {
      throw new ApiError(400, 'Each tool must be type "function" with a function.name.', 'invalid_request_error', null, 'tools');
    }
    return {
      name: tool.function.name,
      ...(tool.function.description && { description: tool.function.description }),
      parameters: tool.function.parameters ?? { type: 'object', properties: {} },
      external: true,
      // Never called — external tools are returned to the caller.
      async execute() {
        return { toolCallId: '', content: 'External tool — executed by the caller.' };
      },
    };
  });
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function requestApiKey(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  const header = req.headers['x-api-key'];
  return Array.isArray(header) ? header[0] : header;
}

function authenticate(req: IncomingMessage, apiKeys: readonly string[]): boolean {
  const candidate = requestApiKey(req);
  return candidate !== undefined && apiKeys.some((key) => safeEqual(candidate, key));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  req.setEncoding('utf8');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new ApiError(413, 'Request body is too large.', 'invalid_request_error');
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON.', 'invalid_request_error');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, error: ApiError): void {
  sendJson(res, error.status, {
    error: {
      message: error.message,
      type: error.type,
      param: error.param,
      code: error.code,
    },
  }, error.status === 401 ? { 'www-authenticate': 'Bearer' } : {});
}

function completionId(): string {
  return `chatcmpl-${randomUUID().replaceAll('-', '')}`;
}

function openAICompletion(id: string, created: number, model: string, content: string, finishReason: string, toolCalls?: ToolCall[]): unknown {
  const message: Record<string, unknown> = { role: 'assistant', content };
  if (toolCalls?.length) {
    message.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
}

function sendStream(res: ServerResponse, id: string, created: number, model: string, content: string, finishReason: string, toolCalls?: ToolCall[]): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null) => {
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
  };
  chunk({ role: 'assistant' }, null);
  if (content) chunk({ content }, null);
  if (toolCalls?.length) {
    for (const tc of toolCalls) {
      chunk({ tool_calls: [{ index: 0, id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }] }, null);
    }
  }
  chunk({}, finishReason);
  res.end('data: [DONE]\n\n');
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  agents: Readonly<Record<string, Agent>>,
  apiKeys: readonly string[],
): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (!authenticate(req, apiKeys)) {
    sendError(res, new ApiError(401, 'Invalid or missing API key.', 'authentication_error', 'invalid_api_key'));
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/models') {
    sendJson(res, 200, {
      object: 'list',
      data: Object.keys(agents).map((id) => ({ id, object: 'model', created: 0, owned_by: 'libra-provider' })),
    });
    return;
  }

  if (req.method !== 'POST' || pathname !== '/v1/chat/completions') {
    throw new ApiError(404, 'Not found.', 'invalid_request_error', 'not_found');
  }

  const body = await readJson(req) as ChatCompletionRequest;
  if (typeof body.model !== 'string') throw new ApiError(400, 'model is required.', 'invalid_request_error', null, 'model');
  const agent = agents[body.model];
  if (!agent) throw new ApiError(404, `Unknown model: ${body.model}`, 'invalid_request_error', 'model_not_found', 'model');
  if (!Array.isArray(body.messages)) throw new ApiError(400, 'messages must be an array.', 'invalid_request_error', null, 'messages');
  if (body.n !== undefined && body.n !== 1) throw new ApiError(400, 'Only n=1 is supported.', 'invalid_request_error', null, 'n');

  // Convert client-defined OpenAI tools to external Libra tools.
  // External tools are not executed by the agent — their calls are returned
  // to the caller as tool_calls in the response.
  const externalTools = body.tools ? toExternalTools(body.tools) : undefined;

  const messages = toLibraMessages(body.messages);
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  if (!latestUserMessage) throw new ApiError(400, 'At least one user message is required.', 'invalid_request_error', null, 'messages');

  const abort = new AbortController();
  req.once('aborted', () => abort.abort());
  res.once('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  const result = await agent.run({
    message: latestUserMessage.content,
    metadata: { [HISTORY_KEY]: messages },
    ...(externalTools?.length && { tools: externalTools }),
    signal: abort.signal,
  });
  if (result.finishReason === 'error') throw new ApiError(502, 'The Libra agent failed to complete the request.', 'server_error');

  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const pendingCalls = result.pendingToolCalls;
  const finishReason = result.finishReason === 'max_iterations'
    ? 'length'
    : result.finishReason === 'tool_calls'
      ? 'tool_calls'
      : 'stop';
  if (body.stream === true) sendStream(res, id, created, body.model, result.message, finishReason, pendingCalls);
  else sendJson(res, 200, openAICompletion(id, created, body.model, result.message, finishReason, pendingCalls));
}

/**
 * Create an OpenAI-compatible HTTP server that exposes Libra agents as models.
 *
 * Each agent in the `agents` record becomes an OpenAI model ID. The server
 * implements `GET /v1/models` and `POST /v1/chat/completions` with bearer/x-api-key
 * authentication, text and image content, SSE streaming, and client-defined
 * (external) tool calling.
 *
 * The HTTP server stays out of the core agent — this is an adapter/extra, not
 * part of the agent harness itself. Use it when you want to expose Libra agents
 * to OpenAI-compatible frameworks and SDKs.
 *
 * @example
 * ```typescript
 * import { Agent } from 'libra-harness';
 * import { createOpenAICompatibleServer } from 'libra-harness/extras/openai-provider';
 *
 * const server = createOpenAICompatibleServer({
 *   agents: {
 *     'my-agent': new Agent({ model, systemPrompt: 'You are helpful.' }),
 *   },
 *   apiKeys: ['your-provider-key'],
 * });
 * server.listen(8787, '127.0.0.1');
 * ```
 */
export function createOpenAICompatibleServer(config: OpenAICompatibleProviderConfig): Server {
  const apiKeys = [...new Set(config.apiKeys.map((key) => key.trim()).filter(Boolean))];
  if (apiKeys.length === 0) throw new Error('At least one provider API key is required.');
  const agents = { ...config.agents };
  if (Object.keys(agents).length === 0) throw new Error('At least one Libra agent is required.');
  Object.values(agents).forEach(prepareAgent);

  return createServer((req, res) => {
    void handleRequest(req, res, agents, apiKeys).catch((error: unknown) => {
      if (res.writableEnded) return;
      if (error instanceof ApiError) sendError(res, error);
      else sendError(res, new ApiError(500, 'Internal server error.', 'server_error'));
    });
  });
}
