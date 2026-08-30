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
import { createContextCompaction } from './context-compaction.js';
import { TurnJournal, createTurnEventsExtension, type TurnEvent } from './turn-journal.js';
import { TuiApp, type ChatMessage, type ToolActivity, type FileChange, type TodoItem } from './tui.js';

// ── Paths ────────────────────────────────────────────────────────────
const LIBRA_HOME = join(homedir(), '.libra');
const SESSIONS_DIR = join(LIBRA_HOME, 'sessions');
const SHELLS_DIR = join(LIBRA_HOME, 'shells');
const TODOS_DIR = join(LIBRA_HOME, 'todos');
const TURNS_DIR = join(LIBRA_HOME, 'turns');
const TURN_META_DIR = join(LIBRA_HOME, 'turn-meta');
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
  mkdirSync(TURNS_DIR, { recursive: true });
  mkdirSync(TURN_META_DIR, { recursive: true });
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

  // Context compaction — disabled for now, needs rework.
  // agent.use(createContextCompaction({
  //   maxMessages: 40,
  //   keepRecent: 12,
  //   maxToolResultChars: 2000,
  // }));

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
  agent.use(createCodeToolsExtension({
    shellsDir: SHELLS_DIR,
    todoFile,
    model,
    codeSearchMaxIterations: 10,
  }));

  // Turn events — writes agent events to the journal.
  agent.use(createTurnEventsExtension());

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
  // ── TUI display state (rebuilt from journal events) ──
  // The journal is the source of truth. The TUI subscribes to it
  // and renders from events. State is derived, not directly mutated.
  const displayState = {
    messages: loadSessionHistory(SESSIONS_DIR, sessionKey) as ChatMessage[],
    toolActivity: [] as ToolActivity[],
    todos: loadTodos(todoFile) as TodoItem[],
    stats: sessionStats,
    streamingText: '',
    isRunning: false,
    fileChanges,
  };

  // Replay the latest turn journal to restore tool activity from the
  // last session. The disk-session already restored chat messages;
  // the turn journal adds tool activity and any incomplete streaming text.
  replayLatestTurn(TURNS_DIR, TURN_META_DIR, displayState);

  // Control state — kept separate from display state.
  let runHandle: { steer: (msg: string) => void; halt: (reason?: string) => void } | null = null;
  let currentJournal: TurnJournal | null = null;

  // ── Re-render helper — throttled to max ~30fps ──
  let renderFns: { rerender: (node: React.ReactNode) => void; unmount: () => void } | null = null;
  let renderPending = false;
  let lastRenderTime = 0;
  const RENDER_INTERVAL = 33; // ~30fps cap
  const forceUpdate = () => {
    if (!renderFns) return;
    if (renderPending) return;
    const now = Date.now();
    const elapsed = now - lastRenderTime;
    if (elapsed < RENDER_INTERVAL) {
      renderPending = true;
      setTimeout(() => {
        renderPending = false;
        lastRenderTime = Date.now();
        if (!renderFns) return;
        doRender();
      }, RENDER_INTERVAL - elapsed);
      return;
    }
    lastRenderTime = now;
    doRender();
  };
  const doRender = () => {
    if (!renderFns) return;
    renderFns.rerender(
      <TuiApp
        messages={displayState.messages}
        toolActivity={displayState.toolActivity}
        fileChanges={displayState.fileChanges}
        todos={displayState.todos}
        stats={displayState.stats}
        streamingText={displayState.streamingText}
        isRunning={displayState.isRunning}
        onSubmit={(text: string) => { sendPrompt(text); }}
        onSteer={(text: string) => {
          if (runHandle) {
            runHandle.steer(text);
            // Journal records the steer event for display.
            currentJournal?.append('steer', { text });
          }
        }}
        onHalt={() => {
          if (runHandle) {
            runHandle.halt('user halted');
            // Journal records the halt event for display.
            currentJournal?.append('halt', { reason: 'user halted' });
          }
        }}
        onExit={() => {
          renderFns?.unmount();
          process.exit(0);
        }}
      />,
    );
  };

  // ── Journal event handler — updates display state from events ──
  // This is the key decoupling: the agent writes events to the journal,
  // and this handler translates events into TUI display state. The agent
  // never touches displayState directly.
  function handleJournalEvent(ev: TurnEvent): void {
    switch (ev.type) {
      case 'status':
        // Status messages are transient — we don't display them in the
        // chat panel, but they could be shown in a status line.
        break;

      case 'text':
        // Accumulate streamed text deltas.
        displayState.streamingText += ev.delta ?? '';
        forceUpdate();
        break;

      case 'tool':
        if (ev.phase === 'start') {
          displayState.toolActivity.push({
            name: ev.name ?? '?',
            detail: ev.file ?? '',
            status: 'running',
            timestamp: ev.ts,
          });
        } else {
          // Mark the last matching tool as done.
          for (let i = displayState.toolActivity.length - 1; i >= 0; i--) {
            if (displayState.toolActivity[i].name === ev.name && displayState.toolActivity[i].status === 'running') {
              displayState.toolActivity[i].status = 'done';
              break;
            }
          }
          // Reload todos if a todo_write tool finished.
          if (ev.name === 'todo_write') {
            displayState.todos = loadTodos(todoFile);
          }
        }
        forceUpdate();
        break;

      case 'steer':
        displayState.messages.push({
          role: 'user',
          content: `⟦steer⟧ ${ev.text}`,
          timestamp: ev.ts,
        });
        forceUpdate();
        break;

      case 'halt':
        displayState.messages.push({
          role: 'assistant',
          content: '⟦halted⟧',
          timestamp: ev.ts,
        });
        displayState.streamingText = '';
        forceUpdate();
        break;

      case 'done':
        // Finalize the assistant message.
        if (displayState.streamingText) {
          displayState.messages.push({
            role: 'assistant',
            content: displayState.streamingText,
            timestamp: ev.ts,
          });
          displayState.streamingText = '';
        } else if (ev.reply) {
          displayState.messages.push({
            role: 'assistant',
            content: ev.reply,
            timestamp: ev.ts,
          });
        }
        displayState.isRunning = false;
        displayState.todos = loadTodos(todoFile);
        forceUpdate();
        break;
    }
  }

  // ── Send a prompt to the agent ──
  async function sendPrompt(text: string) {
    if (displayState.isRunning) return;

    // Create a journal for this turn.
    const turnId = TurnJournal.newTurnId();
    const journal = new TurnJournal(TURNS_DIR, TURN_META_DIR, turnId, text);
    currentJournal = journal;

    displayState.isRunning = true;
    displayState.streamingText = '';
    displayState.messages.push({ role: 'user', content: text, timestamp: Date.now() });
    forceUpdate();

    // Subscribe to journal events — this is how the TUI sees agent progress.
    journal.subscribe(0, handleJournalEvent);

    try {
      const handle = agent.run({
        message: text,
        metadata: {
          sessionId: sessionKey,
          __journal: journal,
          streamCallbacks: {
            onText: (delta: string) => {
              // Stream text directly to the journal (faster than going
              // through hooks for every token).
              journal.append('text', { delta });
            },
          },
        },
      });
      runHandle = handle;
      const result = await handle;

      runHandle = null;

      // Record the final result in the journal.
      if (result.finishReason === 'halted') {
        journal.markHalted();
        journal.append('halt', { reason: 'halted' });
      } else {
        const reply = displayState.streamingText || result.message || '';
        journal.markDone(reply);
        journal.append('done', { reply, finishReason: result.finishReason });
      }

      // Auto-exit if flagged and this was the initial prompt.
      if (exitOnComplete) {
        renderFns?.unmount();
        process.exit(0);
      }
    } catch (err) {
      runHandle = null;
      const errorMsg = err instanceof Error ? err.message : String(err);
      journal.markError(errorMsg);
      journal.append('done', { reply: `Error: ${errorMsg}`, finishReason: 'error' });

      if (exitOnComplete) {
        renderFns?.unmount();
        process.exit(1);
      }
    }
  }

  // ── Render the TUI ──
  const { rerender, unmount } = render(
    <TuiApp
      messages={displayState.messages}
      toolActivity={displayState.toolActivity}
      fileChanges={displayState.fileChanges}
      todos={displayState.todos}
      stats={displayState.stats}
      streamingText={displayState.streamingText}
      isRunning={displayState.isRunning}
      onSubmit={(text: string) => { sendPrompt(text); }}
      onSteer={(text: string) => {
        if (runHandle) {
          runHandle.steer(text);
          currentJournal?.append('steer', { text });
        }
      }}
      onHalt={() => {
        if (runHandle) {
          runHandle.halt('user halted');
          currentJournal?.append('halt', { reason: 'user halted' });
        }
      }}
      onExit={() => {
        unmount();
        process.exit(0);
      }}
    />,
    { exitOnCtrlC: false },
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
  const handle = agent.run({
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

  // Ctrl+C halts the running agent instead of killing the process.
  // First Ctrl+C: halt the agent gracefully. Second Ctrl+C: force exit.
  let ctrlCCount = 0;
  const onSigInt = () => {
    ctrlCCount++;
    if (ctrlCCount === 1) {
      process.stderr.write('\n  ⏹ Halting agent… (Ctrl+C again to force quit)\n');
      handle.halt('user interrupted');
    } else {
      process.stderr.write('\n  Force quit.\n');
      process.exit(130);
    }
  };
  process.on('SIGINT', onSigInt);

  const result = await handle;
  process.off('SIGINT', onSigInt);

  if (result.finishReason === 'halted') {
    process.stderr.write('\n  Halted.\n');
  } else if (firstText) {
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

// Load recent session history into TUI messages so the chat panel
// shows prior conversation on restart. Reads the JSONL session file
// and extracts user + assistant (text-only) messages.
function loadSessionHistory(sessionsDir: string, sessionKey: string): ChatMessage[] {
  const sessionFile = join(sessionsDir, `${sessionKey}.jsonl`);
  if (!existsSync(sessionFile)) return [];

  try {
    const raw = readFileSync(sessionFile, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    const messages: ChatMessage[] = [];

    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.role === 'control') continue;
        if (record.role === 'tool') continue;
        if (record.role === 'system') continue;

        const text = typeof record.content === 'string'
          ? record.content
          : Array.isArray(record.content)
            ? record.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('')
            : '';
        if (!text) continue;

        messages.push({
          role: record.role === 'assistant' ? 'assistant' : 'user',
          content: text,
          timestamp: record.recordedAt ? new Date(record.recordedAt).getTime() : Date.now(),
        });
      } catch {}
    }

    return messages.slice(-50);
  } catch {}
  return [];
}

// Replay the latest turn journal to restore tool activity from the
// previous session. Chat messages are already loaded from the disk-
// session JSONL; this adds tool activity and any incomplete streaming text.
function replayLatestTurn(
  turnsDir: string,
  metaDir: string,
  displayState: { toolActivity: ToolActivity[]; streamingText: string },
): void {
  const latestId = TurnJournal.latestTurnId(metaDir);
  if (!latestId) return;

  const journal = TurnJournal.loadFromDisk(turnsDir, metaDir, latestId);
  if (!journal) return;

  const meta = journal.getMeta();
  // Only replay if the turn was recent (within last hour).
  if (Date.now() - meta.createdAt > 60 * 60 * 1000) return;

  // Rebuild tool activity from tool events.
  for (const ev of journal.getAll()) {
    if (ev.type === 'tool' && ev.phase === 'start') {
      displayState.toolActivity.push({
        name: ev.name ?? '?',
        detail: ev.file ?? '',
        status: 'running',
        timestamp: ev.ts,
      });
    } else if (ev.type === 'tool' && ev.phase === 'end') {
      for (let i = displayState.toolActivity.length - 1; i >= 0; i--) {
        if (displayState.toolActivity[i].name === ev.name && displayState.toolActivity[i].status === 'running') {
          displayState.toolActivity[i].status = 'done';
          break;
        }
      }
    }
  }
}

// ── Entry ────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
