#!/usr/bin/env node
import { join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { render } from 'ink';
import React from 'react';
import { Agent } from '@xandout/libra-harness';
import { configuredProviders } from '@xandout/libra-harness/extras/models';
import type { Extension } from '@xandout/libra-harness';
import {
  LIBRA_HOME, SESSIONS_DIR, TODOS_DIR, TURNS_DIR, TURN_META_DIR, LOCKS_DIR, CONFIG_FILE,
  loadConfig, saveConfig, ensureDirs, sessionKeyForCwd, buildAgent,
} from './agent-setup.js';
import { TurnJournal, SessionLockManager, type TurnEvent } from './turn-journal.js';
import { TuiApp, type ChatMessage, type ToolActivity, type FileChange, type TodoItem } from './tui.js';
import type { SessionStats } from './session-stats.js';

// ── CLI ──────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  // ── --worker mode (silent background agent, spawned by TUI) ──
  if (args[0] === '--worker') {
    await runWorker(args.slice(1));
    return;
  }

  // ── Subcommands ──
  if (args[0] === 'config') {
    const config = loadConfig();
    if (args[1] === 'set' && args[2] && args[3] !== undefined) {
      const value = args.slice(3).join(' ');
      if (value === '') {
        delete (config as any)[args[2]];
        saveConfig(config);
        console.log(`Cleared ${args[2]}`);
      } else {
        (config as any)[args[2]] = value;
        saveConfig(config);
        console.log(`Set ${args[2]} = ${value}`);
      }
    } else if (args[1] === 'get' && args[2]) {
      console.log((config as any)[args[2]] ?? 'undefined');
    } else if (args[1] === 'path') {
      console.log(CONFIG_FILE);
    } else if (args[1] === 'prompt') {
      // Show the effective system prompt (base + AGENTS.md).
      const { buildSystemPrompt } = await import('./agent-setup.js');
      console.log(buildSystemPrompt(process.cwd()));
    } else {
      console.log('Usage: lc config set <key> <value>');
      console.log('       lc config get <key>');
      console.log('       lc config path');
      console.log('       lc config prompt    Show the effective system prompt');
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
    console.log('       lc config prompt              Show the effective system prompt');
    console.log('       lc providers                  List configured model providers');
    console.log('       lc help                       Show this help');
    console.log('');
    console.log('Config:');
    console.log('  model          Model ID in "provider/model" format (e.g. deepseek/deepseek-chat)');
    console.log('  maxIterations  Max LLM iterations per turn (default: 50)');
    console.log('  systemPrompt   Custom system prompt (overrides default; AGENTS.md still appended)');
    console.log('');
    console.log('Project instructions: AGENTS.md in the project root is appended to the system prompt.');
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

  const cwd = process.cwd();
  const sessionKey = sessionKeyForCwd(cwd);

  if (useTui) {
    await runWithTui(prompt, sessionKey, exitOnComplete);
  } else {
    const { agent, todoFile } = await buildAgent();
    await runWithoutTui(agent, prompt, sessionKey, todoFile);
  }
}

// ── --worker mode (silent background agent) ──────────────────────────
// Spawned by the TUI. Runs a single turn, writes events to the journal,
// polls the command file for steer/halt, exits silently when done.
async function runWorker(args: string[]) {
  // Parse: --turn <id> --session <key> --prompt <text>
  let turnId = '';
  let sessionKey = '';
  let prompt = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--turn' && args[i + 1]) { turnId = args[++i]; continue; }
    if (args[i] === '--session' && args[i + 1]) { sessionKey = args[++i]; continue; }
    if (args[i] === '--prompt' && args[i + 1]) { prompt = args[++i]; continue; }
  }

  if (!turnId || !sessionKey || !prompt) {
    process.exit(1);
  }

  ensureDirs();

  // Acquire session lock.
  const lockManager = new SessionLockManager(LOCKS_DIR);
  if (!lockManager.acquire(sessionKey, turnId)) {
    const journal = new TurnJournal(TURNS_DIR, TURN_META_DIR, turnId, prompt);
    journal.markError('Another agent is already running on this session.');
    journal.append('done', { reply: 'Error: Another agent is already running on this session.', finishReason: 'error' });
    process.exit(1);
  }

  // Build agent with journal extensions.
  let built;
  try {
    built = await buildAgent({ journalMode: true });
  } catch (err) {
    const journal = new TurnJournal(TURNS_DIR, TURN_META_DIR, turnId, prompt);
    const msg = err instanceof Error ? err.message : String(err);
    journal.markError(msg);
    journal.append('done', { reply: `Error: ${msg}`, finishReason: 'error' });
    lockManager.release(sessionKey);
    process.exit(1);
  }

  const { agent } = built;
  const journal = new TurnJournal(TURNS_DIR, TURN_META_DIR, turnId, prompt);

  try {
    const handle = agent.run({
      message: prompt,
      metadata: {
        sessionId: sessionKey,
        __journal: journal,
        streamCallbacks: {
          onText: (delta: string) => {
            journal.append('text', { delta });
          },
        },
      },
    });

    const result = await handle;

    if (result.finishReason === 'halted') {
      journal.markHalted();
      journal.append('halt', { reason: 'halted' });
      journal.append('done', { reply: '', finishReason: 'halted' });
    } else {
      const reply = result.message || '';
      journal.markDone(reply);
      journal.append('done', { reply, finishReason: result.finishReason });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    journal.markError(msg);
    journal.append('done', { reply: `Error: ${msg}`, finishReason: 'error' });
  } finally {
    lockManager.release(sessionKey);
    process.exit(0);
  }
}

// ── TUI mode (interactive, long-running) ─────────────────────────────
// The TUI is a pure viewer. It spawns `lc --worker` as a detached child
// process and watches the journal file for events. The agent runs
// independently — if the TUI exits, the agent keeps going.
async function runWithTui(
  initialPrompt: string,
  sessionKey: string,
  exitOnComplete: boolean,
) {
  const todoFile = join(TODOS_DIR, `${sessionKey}.json`);

  // ── TUI display state (rebuilt from journal events) ──
  const displayState = {
    messages: loadSessionHistory(SESSIONS_DIR, sessionKey) as ChatMessage[],
    toolActivity: [] as ToolActivity[],
    todos: loadTodos(todoFile) as TodoItem[],
    stats: {
      promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0,
      cacheWriteTokens: 0, reasoningTokens: 0, llmCalls: 0, turns: 0,
      toolCalls: 0, toolErrors: 0, lastPromptTokens: 0, lastCompletionTokens: 0,
    } as SessionStats,
    streamingText: '',
    isRunning: false,
    fileChanges: [] as FileChange[],
  };

  // ── Control state ──
  let currentJournal: TurnJournal | null = null;
  let agentProcess: ChildProcess | null = null;
  let haltPressed = false;
  const lockManager = new SessionLockManager(LOCKS_DIR);
  let reattaching = false;

  // ── Re-render helper — throttled to max ~30fps ──
  let renderFns: { rerender: (node: React.ReactNode) => void; unmount: () => void } | null = null;
  let renderPending = false;
  let lastRenderTime = 0;
  const RENDER_INTERVAL = 33;
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
          if (currentJournal) {
            currentJournal.writeCommand({ type: 'steer', text });
          }
        }}
        onHalt={() => {
          if (currentJournal && !haltPressed) {
            haltPressed = true;
            currentJournal.writeCommand({ type: 'halt', reason: 'user halted' });
            setTimeout(() => { haltPressed = false; }, 3000);
          } else if (agentProcess && haltPressed) {
            try { agentProcess.kill('SIGTERM'); } catch {}
            lockManager.forceBreak(sessionKey);
            haltPressed = false;
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
  function handleJournalEvent(ev: TurnEvent): void {
    switch (ev.type) {
      case 'status':
        break;

      case 'text':
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
          for (let i = displayState.toolActivity.length - 1; i >= 0; i--) {
            if (displayState.toolActivity[i].name === ev.name && displayState.toolActivity[i].status === 'running') {
              displayState.toolActivity[i].status = 'done';
              break;
            }
          }
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
        agentProcess = null;
        currentJournal = null;
        forceUpdate();

        if (exitOnComplete) {
          renderFns?.unmount();
          process.exit(0);
        }
        break;

      case 'stats':
        if (ev.stats) {
          Object.assign(displayState.stats, ev.stats);
          forceUpdate();
        }
        break;
    }
  }

  // ── Journal file watcher (polling — macOS-safe) ──
  let watchOffset = 0;
  let watchTimer: ReturnType<typeof setInterval> | null = null;

  function startWatching(journalPath: string, initialOffset = 0) {
    watchOffset = initialOffset;
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = setInterval(() => {
      try {
        if (!existsSync(journalPath)) return;
        const stat = statSync(journalPath);
        if (stat.size <= watchOffset) return;
        const content = readFileSync(journalPath, 'utf-8');
        const newContent = content.slice(watchOffset);
        watchOffset = content.length;
        for (const line of newContent.split('\n')) {
          if (!line.trim()) continue;
          try {
            handleJournalEvent(JSON.parse(line) as TurnEvent);
          } catch { /* partial line */ }
        }
      } catch { /* file may be mid-write */ }
    }, 100);
  }

  function stopWatching() {
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  }

  // ── Send a prompt — spawns `lc --worker` ──
  function sendPrompt(text: string) {
    if (displayState.isRunning) return;

    // Check/break stale session lock.
    const lock = lockManager.readLock(sessionKey);
    if (lock) {
      try { process.kill(lock.pid, 0); } catch {
        lockManager.forceBreak(sessionKey);
      }
    }

    // Create a journal for this turn.
    const turnId = TurnJournal.newTurnId();
    const journal = new TurnJournal(TURNS_DIR, TURN_META_DIR, turnId, text);
    currentJournal = journal;

    displayState.isRunning = true;
    displayState.streamingText = '';
    displayState.messages.push({ role: 'user', content: text, timestamp: Date.now() });
    forceUpdate();

    // Start watching the journal file for events.
    const journalPath = join(TURNS_DIR, `${turnId}.jsonl`);
    startWatching(journalPath);

    // Spawn `lc --worker` — silent, detached.
    agentProcess = spawn(process.execPath, [
      process.argv[1],
      '--worker',
      '--turn', turnId,
      '--session', sessionKey,
      '--prompt', text,
    ], {
      detached: true,
      stdio: 'ignore',
    });

    agentProcess.unref();

    agentProcess.on('exit', () => {
      setTimeout(() => {
        if (displayState.isRunning) {
          // Agent crashed without writing done.
          displayState.isRunning = false;
          displayState.messages.push({
            role: 'assistant',
            content: '⟦agent process exited unexpectedly⟧',
            timestamp: Date.now(),
          });
          displayState.streamingText = '';
          agentProcess = null;
          currentJournal = null;
          stopWatching();
          lockManager.forceBreak(sessionKey);
          forceUpdate();
        }
      }, 500);
    });
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
        if (currentJournal) {
          currentJournal.writeCommand({ type: 'steer', text });
        }
      }}
      onHalt={() => {
        if (currentJournal && !haltPressed) {
          haltPressed = true;
          currentJournal.writeCommand({ type: 'halt', reason: 'user halted' });
          setTimeout(() => { haltPressed = false; }, 3000);
        } else if (agentProcess && haltPressed) {
          try { agentProcess.kill('SIGTERM'); } catch {}
          lockManager.forceBreak(sessionKey);
          haltPressed = false;
        }
      }}
      onExit={() => {
        stopWatching();
        unmount();
        process.exit(0);
      }}
    />,
    { exitOnCtrlC: false },
  );
  renderFns = { rerender, unmount };

  // ── Reattach to a running agent (if one exists for this session) ──
  // When the TUI restarts, check if an agent process is still running
  // from a previous TUI session. If so, replay its journal and start
  // watching for new events.
  const existingLock = lockManager.readLock(sessionKey);
  if (existingLock) {
    let alive = false;
    try { process.kill(existingLock.pid, 0); alive = true; } catch {}
    if (alive && existingLock.turnId) {
      // Agent is still running — reattach.
      reattaching = true;
      const turnId = existingLock.turnId;
      const journalPath = join(TURNS_DIR, `${turnId}.jsonl`);

      // Load the journal to get the prompt and replay events.
      const journal = TurnJournal.loadFromDisk(TURNS_DIR, TURN_META_DIR, turnId);
      if (journal) {
        currentJournal = journal;
        displayState.isRunning = true;

        // Replay all events so far (tool activity, streamed text, etc).
        // Chat messages already came from loadSessionHistory, but we
        // need to restore in-progress tool activity and streaming text.
        for (const ev of journal.getAll()) {
          handleJournalEvent(ev);
        }

        // Start watching for NEW events only. Set the offset to the
        // current file size so we don't re-process events we just
        // replayed above.
        let initialOffset = 0;
        try {
          const stat = statSync(journalPath);
          initialOffset = stat.size;
        } catch {}
        startWatching(journalPath, initialOffset);

        // Track the agent process so halt/force-kill works.
        agentProcess = { pid: existingLock.pid, kill: (sig: string) => {
          try { process.kill(existingLock.pid, sig as any); return true; } catch { return false; }
        } } as any as ChildProcess;

        forceUpdate();
      }
    } else {
      // Stale lock — clean it up.
      lockManager.forceBreak(sessionKey);
    }
  }

  // Only replay the latest turn if we're NOT reattaching (otherwise
  // we'd double-process events from the running turn).
  if (!reattaching) {
    replayLatestTurn(TURNS_DIR, TURN_META_DIR, displayState);
  }

  if (initialPrompt && !displayState.isRunning) {
    sendPrompt(initialPrompt);
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
  if (Date.now() - meta.createdAt > 60 * 60 * 1000) return;

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
