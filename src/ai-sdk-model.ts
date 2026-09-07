import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4File,
  LanguageModelV4FilePart,
  LanguageModelV4FunctionTool,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4TextPart,
  LanguageModelV4ToolCallPart,
  LanguageModelV4Usage,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import type { Model, ModelRequest, ModelResponse, FinishReason } from './model.js';
import {
  messageContentToText,
  type FileContentData,
  type FileContentPart,
  type Message,
  type MessageContent,
  type ToolCall,
  type ToolDefinition,
} from './types.js';

/**
 * Adapter that wraps a Vercel AI SDK `LanguageModelV4` as a libra `Model`.
 *
 * This lets you use any current AI SDK provider (`@ai-sdk/openai`,
 * `@ai-sdk/google`, `@ai-sdk/anthropic`, etc.) with libra's hook system
 * and tool-call loop. Provider-specific wire formats are handled by the
 * AI SDK while libra retains ownership of tool execution and continuation.
 *
 * When `ModelRequest.onDelta` is set, the adapter uses `doStream` and
 * emits text, reasoning, and tool-input deltas via the callback. The
 * final assembled `ModelResponse` is still returned. When `onDelta` is
 * not set, it uses `doGenerate` (no streaming overhead).
 */
export class AISdkModel implements Model {
  constructor(private readonly model: LanguageModelV4) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (request.onDelta) return this.generateStream(request);
    return this.generateBatch(request);
  }

  private async generateBatch(request: ModelRequest): Promise<ModelResponse> {
    const result = await this.model.doGenerate(this.toCallOptions(request));
    return this.fromAISdkResult(result);
  }

  private async generateStream(request: ModelRequest): Promise<ModelResponse> {
    const onDelta = request.onDelta!;
    const { stream } = await this.model.doStream(this.toCallOptions(request));
    const state = new StreamState(onDelta);

    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value: part } = await reader.read();
        if (done) break;
        state.processPart(part);
      }
    } finally {
      reader.releaseLock();
    }

    return state.finalize();
  }

  private toCallOptions(request: ModelRequest): LanguageModelV4CallOptions {
    const prompt = this.toAISdkPrompt(request.messages);
    if (request.systemPrompt) prompt.unshift({ role: 'system', content: request.systemPrompt });
    return {
      prompt,
      tools: request.tools?.map(toAISdkTool),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(request.maxTokens !== undefined && { maxOutputTokens: request.maxTokens }),
      ...(request.signal && { abortSignal: request.signal }),
      ...(request.reasoningEffort && {
        reasoning: request.reasoningEffort === 'max' ? 'xhigh' : request.reasoningEffort,
      }),
      ...(request.providerOptions && {
        providerOptions: request.providerOptions as Record<string, import('@ai-sdk/provider').JSONObject>,
      }),
    };
  }

  private toAISdkPrompt(messages: Message[]): LanguageModelV4Prompt {
    return messages.map((message) => {
      if (message.role === 'system') {
        return { role: 'user', content: [{ type: 'text', text: `[System]: ${messageContentToText(message.content)}` }] };
      }

      if (message.role === 'user') {
        return { role: 'user', content: toAISdkContent(message.content) };
      }

      if (message.role === 'assistant') {
        const content: Array<LanguageModelV4TextPart | LanguageModelV4FilePart | LanguageModelV4ToolCallPart> = [
          ...toAISdkContent(message.content),
        ];
        for (const toolCall of message.toolCalls ?? []) {
          content.push({
            type: 'tool-call',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            input: toolCall.arguments ? JSON.parse(toolCall.arguments) : {},
          });
        }
        return { role: 'assistant', content };
      }

      return {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: message.toolCallId ?? '',
          toolName: message.name ?? '',
          output: { type: 'text', value: messageContentToText(message.content) },
        }],
      };
    });
  }

  private fromAISdkResult(result: LanguageModelV4GenerateResult): ModelResponse {
    const messageContent: Array<{ type: 'text'; text: string } | FileContentPart> = [];
    const toolCalls: ToolCall[] = [];

    for (const part of result.content) {
      if (part.type === 'text') {
        messageContent.push({ type: 'text', text: part.text });
      } else if (part.type === 'file') {
        messageContent.push(fromAISdkFile(part));
      } else if (part.type === 'tool-call' && !part.providerExecuted) {
        toolCalls.push({
          id: part.toolCallId,
          name: part.toolName,
          arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}),
        });
      }
    }

    const text = messageContent
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('');

    return {
      message: {
        role: 'assistant',
        content: messageContent.some((part) => part.type === 'file') ? messageContent : text,
        ...(toolCalls.length > 0 && { toolCalls }),
      },
      finishReason: mapFinishReason(result.finishReason.unified),
      usage: extractUsage(result.usage),
    };
  }
}

function toAISdkContent(content: MessageContent): Array<LanguageModelV4TextPart | LanguageModelV4FilePart> {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return content.map((part) => {
    if (part.type === 'text') return part;
    return {
      type: 'file',
      ...(part.filename && { filename: part.filename }),
      mediaType: part.mediaType,
      data: toAISdkFileData(part.data),
    };
  });
}

function toAISdkFileData(data: FileContentData): LanguageModelV4FilePart['data'] {
  if (data.type === 'url') return { type: 'url', url: new URL(data.url) };
  return data;
}

function fromAISdkFile(file: LanguageModelV4File): FileContentPart {
  return {
    type: 'file',
    mediaType: file.mediaType,
    data: file.data.type === 'url'
      ? { type: 'url', url: file.data.url.toString() }
      : file.data,
  };
}

function extractUsage(usage: LanguageModelV4Usage): NonNullable<ModelResponse['usage']> {
  const result: NonNullable<ModelResponse['usage']> = {
    promptTokens: usage.inputTokens.total ?? 0,
    completionTokens: usage.outputTokens.total ?? 0,
  };
  if (usage.inputTokens.cacheRead) result.cachedPromptTokens = usage.inputTokens.cacheRead;
  if (usage.inputTokens.cacheWrite) result.cacheWriteTokens = usage.inputTokens.cacheWrite;
  if (usage.outputTokens.reasoning) result.reasoningTokens = usage.outputTokens.reasoning;
  return result;
}

function toAISdkTool(definition: ToolDefinition): LanguageModelV4FunctionTool {
  return {
    type: 'function',
    name: definition.function.name,
    ...(definition.function.description && { description: definition.function.description }),
    inputSchema: definition.function.parameters as LanguageModelV4FunctionTool['inputSchema'],
  };
}

function mapFinishReason(reason: LanguageModelV4GenerateResult['finishReason']['unified']): FinishReason {
  switch (reason) {
    case 'tool-calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content-filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

class StreamState {
  public content: Array<{ type: 'text'; text: string } | FileContentPart> = [];
  public textById = new Map<string, string>();
  public textOrder: string[] = [];
  public toolCalls: ToolCall[] = [];
  public finishReason: FinishReason = 'stop';
  public usage?: NonNullable<ModelResponse['usage']>;
  public toolInputBuffers = new Map<string, { name: string; input: string; providerExecuted: boolean }>();

  constructor(private onDelta: (delta: any) => void) {}

  public processPart(part: LanguageModelV4StreamPart): void {
    switch (part.type) {
      case 'text-start':
        if (!this.textById.has(part.id)) {
          this.textById.set(part.id, '');
          this.textOrder.push(part.id);
        }
        break;
      case 'text-delta':
        if (!this.textById.has(part.id)) this.textOrder.push(part.id);
        this.textById.set(part.id, (this.textById.get(part.id) ?? '') + part.delta);
        this.onDelta({ type: 'text', content: part.delta });
        break;
      case 'reasoning-delta':
        this.onDelta({ type: 'reasoning', content: part.delta });
        break;
      case 'tool-input-start':
        this.toolInputBuffers.set(part.id, {
          name: part.toolName,
          input: '',
          providerExecuted: part.providerExecuted === true,
        });
        break;
      case 'tool-input-delta': {
        const buffer = this.toolInputBuffers.get(part.id);
        if (buffer) {
          buffer.input += part.delta;
          if (!buffer.providerExecuted) {
            this.onDelta({ type: 'tool-input', content: part.delta, toolCallId: part.id, toolName: buffer.name });
          }
        }
        break;
      }
      case 'tool-input-end': {
        const buffer = this.toolInputBuffers.get(part.id);
        if (buffer && !buffer.providerExecuted) {
          this.toolCalls.push({ id: part.id, name: buffer.name, arguments: buffer.input || '{}' });
        }
        this.toolInputBuffers.delete(part.id);
        break;
      }
      case 'tool-call':
        if (!part.providerExecuted && !this.toolCalls.some((toolCall) => toolCall.id === part.toolCallId)) {
          this.toolCalls.push({ id: part.toolCallId, name: part.toolName, arguments: typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}) });
        }
        break;
      case 'file':
        this.content.push(fromAISdkFile(part));
        break;
      case 'finish':
        this.finishReason = mapFinishReason(part.finishReason.unified);
        this.usage = extractUsage(part.usage);
        break;
      case 'error':
        throw part.error;
      default:
        break;
    }
  }

  public finalize(): ModelResponse {
    const text = this.textOrder.map((id) => this.textById.get(id) ?? '').join('');
    if (text) this.content.unshift({ type: 'text', text });

    return {
      message: {
        role: 'assistant',
        content: this.content.length > 1 || this.content.some((part) => part.type === 'file') ? this.content : text,
        ...(this.toolCalls.length > 0 && { toolCalls: this.toolCalls }),
      },
      finishReason: this.finishReason,
      ...(this.usage && { usage: this.usage }),
    };
  }
}
