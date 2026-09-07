import type { Extension } from '../../extension.js';
import type { TurnContext } from '../../context.js';
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
}

export default function createCodeToolsExtension(config?: CodeToolsConfig): Extension {
  const resolved: ResolvedConfig = {
    toolPrefix: config?.toolPrefix ?? '',
    maxReadSize: config?.maxReadSize ?? 1_048_576,
    maxReadLines: config?.maxReadLines ?? 2000,
    maxLineLength: config?.maxLineLength ?? 2000,
  };

  const registry = new ShellRegistry(config?.shellsDir);
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

  let activeTurn: TurnContext | undefined;

  registry.onTaskComplete = (id, code, output) => {
    if (activeTurn) {
      const truncated = output.length > 50000 ? output.slice(0, 50000) + '\n[output truncated]' : output;
      activeTurn.steer(`Background task ${id} finished (exit code ${code}).\nOutput:\n${truncated}`);
    }
  };

  return {
    name: 'code-tools',
    priority: 50,

    install(agent) {
      agent.hook('beforeTurn', 'code-tools', async (ctx) => {
        activeTurn = ctx.turn;
      });
      agent.hook('afterTurn', 'code-tools', async () => {
        activeTurn = undefined;
      });

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
