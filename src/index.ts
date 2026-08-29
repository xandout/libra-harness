// Core types
export type {
  Role,
  Message,
  MessageContent,
  TextContentPart,
  FileContentPart,
  FileContentData,
  ToolCall,
  ToolResult,
  ToolDefinition,
} from './types.js';
export { messageContentToText, hasFileContent } from './types.js';

// Errors
export {
  LibraError,
  ModelError,
  ToolError,
  HookError,
  HaltedError,
  MaxIterationsError,
} from './errors.js';

// Model
export type { Model, ModelRequest, ModelResponse, ModelDelta, FinishReason } from './model.js';
export { AISdkModel } from './ai-sdk-model.js';

// Tools
export type { Tool, ToolContext } from './tool.js';
export { toToolDefinition, createAgentTool } from './tool.js';
export type { AgentToolOptions } from './tool.js';

// Context
export type { AgentRequest, AgentResponse, TurnContext, TurnFinishReason } from './context.js';

// Hooks
export type { HookName, HookContext, HookResult, HookHandler, HookEntry } from './hooks.js';
export { HookRegistry } from './hooks.js';

// Extension
export type { Extension } from './extension.js';

// Agent
export { Agent } from './agent.js';
export type { AgentConfig, ErrorPolicy, ErrorPolicyContext } from './agent.js';

// RunHandle
export type { RunHandle } from './handle.js';
