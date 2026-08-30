#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { render } from 'ink';
import React from 'react';
import { Agent } from '@xandout/libra-harness';
import { resolveModel, configuredProviders } from '@xandout/libra-harness/extras/models';
import { createDiskSessionExtension } from '@xandout/libra-harness/extras/disk-session';
import { createCodeToolsExtension } from '@xandout/libra-harness/extras/code-tools';
import { createStreamingExtension } from '@xandout/libra-harness/extras/streaming';
import type { Extension } from '@xandout/libra-harness';
import { createFileChangeTracker } from './file-change-tracker.js';
import { createSessionStats, type SessionStats } from './session-stats.js';
import { TuiApp, type ChatMessage, type ToolActivity, type FileChange, type TodoItem } from './tui.js';

// ── Paths ────────────────────────────────────────────────────────────
const LIBRA_HOME = join(homedir(), '.libra');
const SESSIONS_DIR = join(LIBRA_HOME, 'sessions');
const SHELLS_DIR = join(LIBRA_HOME, 'shells');
const TODOS_DIR = join(LIBRA_HOME, 'todos');
const CONFIG_FILE = join(LIBRA_HOME, 'config.json');

// ── Config ───────────────────────────────────────────────────────────
interface LibraCodeConfig {
  model?: string;
  maxIterations?: number;
}

function loadConfig(): LibraCodeConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveConfig(config: LibraCodeConfig): void {
  mkdirSync(LIBRA_HOME, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function ensureDirs(): void {
  mkdirSync(LIBRA_HOME, { recursive: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  mkdirSync(SHELLS_DIR, { recursive: true });
  mkdirSync(TODOS_DIR, { recursive: true });
}

function sessionKeyForCwd(cwd: string): string {
  return 'cwd_' + cwd.replace(/[^a-zA-Z0-9]/g, '_');
}

// ── System prompt ────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a code agent. You help with software engineering tasks.

You have tools for reading, writing, and editing files, finding files by name, searching file contents, running shell commands, and tracking tasks. Use them to explore and modify code.

Rules:
- Read files before editing them.
- Explore the codebase before making changes.
- Use absolute paths for all file operations.
- Be concise in your responses.
- When making changes, explain what you did and why.
- Do not push to git unless explicitly asked.
- Never commit secrets or credentials.
- Use todo_write to track multi-step tasks.`;

// ── CLI ──────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  // ── Subcommands ──
  if (args[0] === 'config') {
    const config = loadConfig();
    if (args[1] === 'set' && args[2] && args[3]) {
      (config as any)[args[2]] = args[3];
      saveConfig(config);
      console.log(`Set ${args[2]} = ${args[3]}`);
    } else if (args[1] === 'get' && args[2]) {
      console.log((config as any)[args[2]] ?? 'undefined');
    } else if (args[1] === 'path') {
      console.log(CONFIG_FILE);
    } else {
      console.log('Usage: lc config set <key> <value>');
      console.log('       lc config get <key>');
      console.log('       lc config path');
      console.log('');
      console.log('Current config:');
      console.log(JSON.stringify(config, null, 2));
    }
    return;
  }

  if (args[0] === 'providers') {
    const providers = configuredProviders();
    if (providers.length === 0) {
      console.log('No providers configured. Set an API key environment variable:');
      console.log('  OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, DEEPSEEK_API_KEY');
    } else {
      console.log('Configured providers:', providers.join(', '));
    }
    return;
  }

  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    console.log('lc — libra code agent');
    console.log('');
    console.log('Usage: lc <prompt>            Run the agent (all args joined as one prompt)');
    console.log('       lc --tui [prompt]      Run with interactive TUI (long-running)');
    console.log('       lc -x <prompt>         Run with TUI, exit when agent finishes');
    console.log('       lc --tui               Open TUI with no initial prompt');
    console.log('');
    console.log('       lc config set <key> <value>   Set a config option');
    console.log('       lc config get <key>           Get a config option');
    console.log('       lc config path                Show config file path');
    console.log('       lc providers                  List configured model providers');
    console.log('       lc help                       Show this help');
    console.log('');
    console.log('Config:');
    console.log('  model          Model ID in "provider/model" format (e.g. deepseek/deepseek-chat)');
    console.log('  maxIterations  Max LLM iterations per turn (default: 50)');
    console.log('');
    console.log('Session: one per working directory, stored in ~/.libra/sessions/');
    return;
  }

  // ── Parse flags ──
  let useTui = false;
  let exitOnComplete = false;

  const filtered: string[] = [];
  for (const arg of args) {
    if (arg === '--tui' || arg === '-t') {
      useTui = true;
    } else if (arg === '--exit-on-complete' || arg === '-x') {
      exitOnComplete = true;
      useTui = true;
    } else {
      filtered.push(arg);
    }
  }

  // ── Default: run the agent with all args as the prompt ──
  const prompt = filtered.join(' ').trim();

  // Without TUI, prompt is required.
  // With TUI, prompt is optional (can type interactively).
  if (!prompt && !useTui) {
    console.log('Usage: lc <prompt>');
    console.log('Run "lc help" for more options.');
    process.exit(1);
  }

  ensureDirs();

  const config = loadConfig();
  const modelId = config.model ?? process.env.LIBRA_MODEL ?? process.env.MODEL;
  if (!modelId) {
    console.error('No model configured. Set one with:');
    console.error('  lc config set model <provider/model>');
    console.error('');
    console.error('Or set the MODEL environment variable.');
    console.error('');
    const providers = configuredProviders();
    if (providers.length > 0) {
      console.error('Configured providers:', providers.join(', '));
    } else {
      console.error('No providers configured. Set an API key:');
      console.error('  OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, DEEPSEEK_API_KEY');
    }
    process.exit(1);
  }

  let model;
  try {
    model = await resolveModel(modelId);
  } catch (err) {
    console.error(`Failed to resolve model "${modelId}": ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const cwd = process.cwd();
  const sessionKey = sessionKeyForCwd(cwd);

  // ── Build the agent ──
  const agent = new Agent({
    model,
    systemPrompt: SYSTEM_PROMPT,
    maxIterations: config.maxIterations ?? 50,
  });

  // Disk session.
  agent.use(createDiskSessionExtension({
    sessionDir: SESSIONS_DIR,
    maxContextMessages: 100,
    verbose: false,
  }));

  // Streaming.
  agent.use(createStreamingExtension());

  // File change tracker — must be installed before code-tools so
  // its beforeTool hook captures file contents before writes.
  const fileChanges: FileChange[] = [];
  const changeTracker = createFileChangeTracker(fileChanges);
  agent.use(changeTracker);

  // Session stats — tracks token usage from provider responses.
  const sessionStats: SessionStats = {
    promptTokens: 0,
    completionTokens: 0,
    cachedPromptTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    llmCalls: 0,
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    lastPromptTokens: 0,
    lastCompletionTokens: 0,
  };
  agent.use(createSessionStats(sessionStats));

  // Code tools.
  const todoFile = join(TODOS_DIR, `${sessionKey}.json`);
  agent.use(createCodeToolsExtension({ shellsDir: SHELLS_DIR, todoFile }));

  // ── Run with or without TUI ──
  if (useTui) {
    await runWithTui(agent, prompt, sessionKey, fileChanges, todoFile, exitOnComplete, sessionStats);
  } else {
    await runWithoutTui(agent, prompt, sessionKey, todoFile);
  }
}

// ── TUI mode (interactive, long-running) ─────────────────────────────
async function runWithTui(
  agent: Agent,
  initialPrompt: string,
  sessionKey: string,
  fileChanges: FileChange[],
  todoFile: string,
  exitOnComplete: boolean,
  sessionStats: SessionStats,
) {
  // ── TUI state (mutable, re-rendered on each change) ──
  const state = {
    messages: [] as ChatMessage[],
    toolActivity: [] as ToolActivity[],
    todos: loadTodos(todoFile) as TodoItem[],
    stats: sessionStats,
    streamingText: '',
    isRunning: false,
    fileChanges,
    inputText: '',
  };

  // Re-render helper.
  let renderFns: { rerender: (node: React.ReactNode) => void; unmount: () => void } | null = null;
  const forceUpdate = () => {
    if (!renderFns) return;
    renderFns.rerender(
      <TuiApp
        messages={state.messages}
        toolActivity={state.toolActivity}
        fileChanges={state.fileChanges}
        todos={state.todos}
        stats={state.stats}
        streamingText={state.streamingText}
        isRunning={state.isRunning}
        inputText={state.inputText}
        onInput={(text: string) => { state.inputText = text; forceUpdate(); }}
        onSubmit={(text: string) => { state.inputText = ''; sendPrompt(text); }}
        onExit={() => {
          renderFns?.unmount();
          process.exit(0);
        }}
      />,
    );
  };

  // ── Progress extension for TUI ──
  const tuiProgressExtension: Extension = {
    name: 'tui-progress',
    priority: 90,
    install(agent) {
      agent.hook('beforeTool', 'tui-progress', async (ctx) => {
        const toolCall = ctx.toolCall;
        if (!toolCall) return;
        const parsed = (() => { try { return JSON.parse(toolCall.arguments); } catch { return {}; } })();
        let detail = '';
        if (parsed.file_path) detail = String(parsed.file_path);
        else if (parsed.pattern) detail = parsed.path ? `${parsed.pattern} in ${parsed.path}` : String(parsed.pattern);
        else if (parsed.command) detail = String(parsed.command);
        else if (parsed.shell_id) detail = String(parsed.shell_id);
        else if (parsed.todos) detail = `${parsed.todos.length} items`;
        else detail = toolCall.arguments.slice(0, 80);

        state.toolActivity.push({
          name: toolCall.name,
          detail,
          status: 'running',
          timestamp: Date.now(),
        });
        forceUpdate();
      });

      agent.hook('afterTool', 'tui-progress', async (ctx) => {
        const toolResult = ctx.toolResult;
        if (!toolResult) return;
        const entry = state.toolActivity[state.toolActivity.length - 1];
        if (entry) {
          entry.status = toolResult.isError ? 'error' : 'done';
          entry.result = toolResult.content.split('\n')[0].slice(0, 100);
        }
        if (ctx.toolCall?.name === 'todo_write') {
          state.todos = loadTodos(todoFile);
        }
        forceUpdate();
      });

      // Re-render after each LLM call so stats panel updates live.
      agent.hook('afterLLM', 'tui-progress', async () => {
        forceUpdate();
      });
    },
  };
  agent.use(tuiProgressExtension);

  // ── Send a prompt to the agent ──
  async function sendPrompt(text: string) {
    if (state.isRunning) return;
    state.isRunning = true;
    state.streamingText = '';
    state.messages.push({ role: 'user', content: text, timestamp: Date.now() });
    forceUpdate();

    try {
      const result = await agent.run({
        message: text,
        metadata: {
          sessionId: sessionKey,
          streamCallbacks: {
            onText: (delta: string) => {
              state.streamingText += delta;
              forceUpdate();
            },
          },
        },
      });

      state.isRunning = false;
      if (state.streamingText) {
        state.messages.push({ role: 'assistant', content: state.streamingText, timestamp: Date.now() });
        state.streamingText = '';
      } else if (result.message) {
        state.messages.push({ role: 'assistant', content: result.message, timestamp: Date.now() });
      }
      state.todos = loadTodos(todoFile);
      forceUpdate();

      // Auto-exit if flagged and this was the initial prompt.
      if (exitOnComplete) {
        renderFns?.unmount();
        process.exit(0);
      }
    } catch (err) {
      state.isRunning = false;
      state.messages.push({
        role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      });
      forceUpdate();

      if (exitOnComplete) {
        renderFns?.unmount();
        process.exit(1);
      }
    }
  }

  // ── Render the TUI ──
  const { rerender, unmount } = render(
    <TuiApp
      messages={state.messages}
      toolActivity={state.toolActivity}
      fileChanges={state.fileChanges}
      todos={state.todos}
      stats={state.stats}
      streamingText={state.streamingText}
      isRunning={state.isRunning}
      inputText={state.inputText}
      onInput={(text: string) => { state.inputText = text; forceUpdate(); }}
      onSubmit={(text: string) => { state.inputText = ''; sendPrompt(text); }}
      onExit={() => {
        unmount();
        process.exit(0);
      }}
    />,
    { exitOnCtrlC: true },
  );
  renderFns = { rerender, unmount };

  // ── If an initial prompt was provided, send it immediately ──
  if (initialPrompt) {
    await sendPrompt(initialPrompt);
  }
}

// ── Plain text mode (no TUI) ─────────────────────────────────────────
async function runWithoutTui(
  agent: Agent,
  prompt: string,
  sessionKey: string,
  todoFile: string,
) {
  const progressExtension: Extension = {
    name: 'progress',
    priority: 90,
    install(agent) {
      agent.hook('beforeTool', 'progress', async (ctx) => {
        const toolCall = ctx.toolCall;
        if (!toolCall) return;
        const args = (() => { try { return JSON.parse(toolCall.arguments); } catch { return {}; } })();
        let detail = '';
        if (args.file_path) detail = String(args.file_path);
        else if (args.pattern) detail = args.path ? `${args.pattern} in ${args.path}` : String(args.pattern);
        else if (args.command) detail = String(args.command);
        else if (args.shell_id) detail = String(args.shell_id);
        else detail = toolCall.arguments.slice(0, 80);
        process.stderr.write(`\n  → ${toolCall.name}(${detail})\n`);
      });

      agent.hook('afterTool', 'progress', async (ctx) => {
        const toolResult = ctx.toolResult;
        if (!toolResult) return;
        const preview = toolResult.content.split('\n')[0].slice(0, 100);
        const marker = toolResult.isError ? '✗' : '✓';
        process.stderr.write(`  ${marker} ${preview}\n`);
      });
    },
  };
  agent.use(progressExtension);

  let firstText = true;
  const result = await agent.run({
    message: prompt,
    metadata: {
      sessionId: sessionKey,
      streamCallbacks: {
        onText: (delta: string) => {
          if (firstText) {
            process.stdout.write('\n');
            firstText = false;
          }
          process.stdout.write(delta);
        },
      },
    },
  });

  if (firstText) {
    console.log(result.message || '(no response)');
  } else {
    process.stdout.write('\n');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────
function loadTodos(todoFile: string): TodoItem[] {
  try {
    if (existsSync(todoFile)) {
      const data = JSON.parse(readFileSync(todoFile, 'utf-8'));
      if (Array.isArray(data)) {
        return data.map((t: any) => ({
          content: String(t.content ?? ''),
          status: t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending',
        }));
      }
    }
  } catch {}
  return [];
}

// ── Entry ────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
