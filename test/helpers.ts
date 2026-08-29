import type { Model, ModelRequest, ModelResponse } from '../src/index.js';
import type { Tool, ToolCall } from '../src/index.js';

/**
 * A mock model that returns scripted responses in sequence.
 *
 * Each entry is returned for the corresponding LLM call. If an entry is a
 * function, it's called with the request to produce a dynamic response.
 */
export class MockModel implements Model {
  private responses: (ModelResponse | ((req: ModelRequest) => ModelResponse))[];
  private calls: ModelRequest[] = [];

  constructor(responses: (ModelResponse | ((req: ModelRequest) => ModelResponse))[]) {
    this.responses = [...responses];
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    // Deep copy messages so later mutations of turn.messages don't
    // retroactively change what was passed to this call.
    this.calls.push({
      ...request,
      messages: request.messages.map((m) => ({ ...m, toolCalls: m.toolCalls?.map((tc) => ({ ...tc })) })),
      tools: request.tools?.map((t) => ({ ...t, function: { ...t.function } })),
    });
    const next = this.responses.shift();
    if (!next) throw new Error('MockModel: no more scripted responses');
    return typeof next === 'function' ? next(request) : next;
  }

  get receivedCalls(): ModelRequest[] {
    return this.calls;
  }

  get callCount(): number {
    return this.calls.length;
  }
}

/** Build a text-only assistant response. */
export function textResponse(content: string): ModelResponse {
  return { message: { role: 'assistant', content }, finishReason: 'stop' };
}

/** Build an assistant response that requests tool calls. */
export function toolCallResponse(toolCalls: ToolCall[], content = ''): ModelResponse {
  return { message: { role: 'assistant', content, toolCalls }, finishReason: 'tool_calls' };
}

/** Build a tool call with JSON-encoded arguments. */
export function toolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

/**
 * Create a test tool. The execute function receives parsed args and returns
 * a content string. The harness fills in the toolCallId.
 */
export function makeTool(
  name: string,
  execute: (args: Record<string, unknown>) => Promise<string> | string,
  parameters: Record<string, unknown> = { type: 'object', properties: {} },
): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters,
    async execute(args) {
      const content = await execute(args);
      return { toolCallId: '', content };
    },
  };
}
