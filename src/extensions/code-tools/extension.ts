import type { Extension } from '../../extension.js';
import type { Model } from '../../model.js';
import type { ToolFactory, ResolvedConfig } from './tools/shared.js';
import { readTool } from './tools/read.js';
import { writeTool, editTool } from './tools/write.js';
import { findFileByNameTool } from './tools/find.js';
import { grepTool } from './tools/grep.js';
import { codeSearchTool } from './tools/code-search.js';
import { ShellRegistry, runCommandTool, execTool, manageTaskTool } from './tools/shell.js';
import type { ShellToolFactory } from './tools/shell.js';
import { TodoStore, todoWriteTool } from './tools/todo.js';
import { viewImageTool } from './tools/view-image.js';

export interface CodeToolsConfig {
  toolPrefix?: string;
  maxReadSize?: number;
  maxReadLines?: number;
  maxLineLength?: number;
  shellsDir?: string;
  todoFile?: string;
  model?: Model;
  codeSearchMaxIterations?: number;
  visionModel?: Model;
  /** Runtime executable for background-task callbacks. */
  callbackBin?: string;
  /** Optional lc entry script passed to the runtime executable. */
  callbackEntry?: string;
  /** Session key for background-task callbacks. */
  callbackSessionKey?: string;
}

export default function createCodeToolsExtension(config?: CodeToolsConfig): Extension {
  const resolved: ResolvedConfig = {
    toolPrefix: config?.toolPrefix ?? '',
    maxReadSize: config?.maxReadSize ?? 1_048_576,
    maxReadLines: config?.maxReadLines ?? 2000,
    maxLineLength: config?.maxLineLength ?? 2000,
  };

  const registry = new ShellRegistry(config?.shellsDir);
  if (config?.callbackBin && config?.callbackSessionKey) {
    registry.callback = {
      lcBin: config.callbackBin,
      lcEntry: config.callbackEntry,
      sessionKey: config.callbackSessionKey,
    };
  }
  const todoStore = new TodoStore(config?.todoFile);

  const toolFactories: ToolFactory[] = [
    readTool,
    writeTool,
    editTool,
    findFileByNameTool,
    grepTool,
  ];

  const shellToolFactories: ShellToolFactory[] = [
    runCommandTool,
    execTool,
    manageTaskTool,
  ];

  return {
    name: 'code-tools',
    priority: 50,

    install(agent) {
      for (const factory of toolFactories) {
        agent.tool(factory(resolved));
      }
      for (const factory of shellToolFactories) {
        agent.tool(factory({ toolPrefix: resolved.toolPrefix, registry }));
      }
      agent.tool(todoWriteTool({ toolPrefix: resolved.toolPrefix, store: todoStore }));

      if (config?.model) {
        agent.tool(codeSearchTool({
          toolPrefix: resolved.toolPrefix,
          model: config.model,
          maxIterations: config.codeSearchMaxIterations,
        }));
      }

      if (config?.visionModel) {
        agent.tool(viewImageTool({
          toolPrefix: resolved.toolPrefix,
          visionModel: config.visionModel,
        }));
      }
    },

    async close() {
      registry.close();
    },
  };
}
