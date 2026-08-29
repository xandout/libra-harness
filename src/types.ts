/**
 * Core message and content types.
 *
 * These are libra's own types. The model provider translates to/from
 * the wire format of whatever API it targets (OpenAI-compatible, etc.).
 */

/** A single tool call requested by the model. */
export interface ToolCall {
  /** Unique id assigned by the model, used to correlate tool results. */
  id: string;
  /** The tool/function name to invoke. */
  name: string;
  /** JSON-encoded arguments string (matches OpenAI tool_call.function.arguments). */
  arguments: string;
}

/** The result of executing a tool call. */
export interface ToolResult {
  /** Correlates with {@link ToolCall.id}. */
  toolCallId: string;
  /** Human/machine readable result content. */
  content: string;
  /** When true, the result represents a failure the model should see as an error. */
  isError?: boolean;
}

/** Conversation participant role. */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** Text content within a multimodal message. */
export interface TextContentPart {
  type: 'text';
  text: string;
}

/** Provider-independent file data. */
export type FileContentData =
  | { type: 'data'; data: string | Uint8Array }
  | { type: 'url'; url: string }
  | { type: 'text'; text: string };

/** A file attachment, including images, documents, audio, and video. */
export interface FileContentPart {
  type: 'file';
  mediaType: string;
  filename?: string;
  data: FileContentData;
}

/** Message content. Strings remain supported as the text-only shorthand. */
export type MessageContent = string | Array<TextContentPart | FileContentPart>;

/** Convert message content to a text representation for logs and text-only extensions. */
export function messageContentToText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') return part.text;
    return part.filename ? `[File: ${part.filename} (${part.mediaType})]` : `[File: ${part.mediaType}]`;
  }).join('\n');
}

/** Whether message content contains at least one file attachment. */
export function hasFileContent(content: MessageContent, mediaTypePrefix?: string): boolean {
  return Array.isArray(content) && content.some((part) =>
    part.type === 'file' && (!mediaTypePrefix || part.mediaType.startsWith(mediaTypePrefix))
  );
}

/**
 * A single conversation message.
 *
 * - `assistant` messages may carry `toolCalls` when the model requests tools.
 * - `tool` messages carry a single `toolCallId` linking back to the call
 *   and `content` holds the tool result.
 */
export interface Message {
  role: Role;
  /** Text or multimodal content. For `tool` messages this is the tool result. */
  content: MessageContent;
  /** Present on assistant messages that request tool execution. */
  toolCalls?: ToolCall[];
  /** Present on tool messages — links to the originating tool call id. */
  toolCallId?: string;
  /** Optional tool name for tool messages. */
  name?: string;
}

/** JSON Schema describing a tool's parameters (OpenAI function format). */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}
