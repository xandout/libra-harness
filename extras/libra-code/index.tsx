#!/usr/bin/env node
import { join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { render } from 'ink';
import React from 'react';
import { configuredProviders } from '@xandout/libra-harness/extras/models';
import {
  LIBRA_HOME, SESSIONS_DIR, SOCKETS_DIR, TODOS_DIR, CONFIG_FILE,
  loadConfig, saveConfig, ensureDirs, sessionKeyForCwd, buildAgent,
} from './agent-setup.js';
import {
  SessionSocketServer, SessionSocketClient, isSessionActive, getSocketPath, type SocketEvent,
} from './session-socket.js';
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
    console.log('Usage: lc [prompt]            Run the agent or reattach to active session');
    console.log('       lc --watch             Watch active session (Ctrl+C detaches, agent continues)');
    console.log('       lc --attach [prompt]   Attach to active session (Ctrl+C halts/kills agent)');
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
    console.log('  thinkingLevel  Thinking/reasoning level: off, low, medium, high, max (default: high)');
    console.log('');
    console.log('Project instructions: AGENTS.md in the project root is appended to the system prompt.');
    console.log('Session: one per working directory, stored in ~/.libra/sessions/');
    return;
  }

  // ── Parse flags ──
  let useTui = false;
  let exitOnComplete = false;
  let thinkingLevel: string | undefined;
  let watchMode = false;
  let attachMode = false;
  let customSessionKey: string | undefined;

  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--tui' || arg === '-t') {
      useTui = true;
    } else if (arg === '--exit-on-complete' || arg === '-x') {
      exitOnComplete = true;
      useTui = true;
    } else if (arg === '--watch' || arg === '-w') {
      watchMode = true;
    } else if (arg === '--attach' || arg === '-a') {
      attachMode = true;
    } else if (arg === '--session' && args[i + 1]) {
      customSessionKey = args[++i];
    } else if ((arg === '--thinking-level' || arg === '--thinking' || arg === '--reasoning-effort') && args[i + 1]) {
      thinkingLevel = args[++i];
    } else if (arg.startsWith('--thinking-level=') || arg.startsWith('--thinking=') || arg.startsWith('--reasoning-effort=')) {
      thinkingLevel = arg.slice(arg.indexOf('=') + 1);
    } else {
      filtered.push(arg);
    }
  }

  // ── Default: run the agent or reattach to active session ──
  const prompt = filtered.join(' ').trim();

  ensureDirs();

  const cwd = process.cwd();
  const sessionKey = customSessionKey || sessionKeyForCwd(cwd);

  if (useTui) {
    await runWithTui(prompt, sessionKey, exitOnComplete, thinkingLevel);
  } else {
    await runStdout(prompt, sessionKey, thinkingLevel, { watch: watchMode, attach: attachMode });
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
  let thinkingLevel: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--turn' && args[i + 1]) { turnId = args[++i]; continue; }
    if (args[i] === '--session' && args[i + 1]) { sessionKey = args[++i]; continue; }
    if (args[i] === '--prompt' && args[i + 1]) { prompt = args[++i]; continue; }
    if ((args[i] === '--thinking-level' || args[i] === '--thinking' || args[i] === '--reasoning-effort') && args[i + 1]) {
      thinkingLevel = args[++i];
      continue;
    }
  }

  if (!turnId || !sessionKey || !prompt) {
    process.exit(1);
  }

  ensureDirs();

  const socketPath = getSocketPath(SOCKETS_DIR, sessionKey);
  const socketServer = new SessionSocketServer(socketPath, sessionKey);
  try {
    await socketServer.start();
  } catch (err) {
    process.exit(1);
  }

  let built;
  try {
    built = await buildAgent({ thinkingLevel });
  } catch (err) {
    socketServer.close();
    process.exit(1);
  }

  const { agent } = built;

  try {
    const handle = agent.run({
      message: prompt,
      metadata: {
        sessionId: sessionKey,
        __socketServer: socketServer,
        streamCallbacks: {
          onText: (delta: string) => {
            socketServer.broadcast({ type: 'text', delta, ts: Date.now() });
          },
        },
      },
    });

    socketServer.attachHandle(handle);
    const result = await handle;

    socketServer.broadcast({
      type: 'done',
      reply: result.message || '',
      finishReason: result.finishReason,
      ts: Date.now(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    socketServer.broadcast({
      type: 'done',
      reply: `Error: ${msg}`,
      finishReason: 'error',
      ts: Date.now(),
    });
  } finally {
    socketServer.close();
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
  thinkingLevel?: string,
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
  let agentProcess: ChildProcess | null = null;
  let haltPressed = false;

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
  function handleJournalEvent(ev: SocketEvent): void {
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

  let socketClient: SessionSocketClient | null = null;

  async function connectSocket(): Promise<SessionSocketClient | null> {
    const socketPath = getSocketPath(SOCKETS_DIR, sessionKey);
    const client = new SessionSocketClient(socketPath);
    try {
      await client.connect();
      client.onEvent((ev: SocketEvent) => handleJournalEvent(ev));
      socketClient = client;
      return client;
    } catch {
      return null;
    }
  }

  // ── Send a prompt — spawns `lc --worker` ──
  function sendPrompt(text: string) {
    if (displayState.isRunning) return;

    displayState.isRunning = true;
    displayState.streamingText = '';
    displayState.messages.push({ role: 'user', content: text, timestamp: Date.now() });
    forceUpdate();

    // Spawn `lc --worker` — silent, detached.
    const workerArgs = [
      process.argv[1],
      '--worker',
      '--session', sessionKey,
      '--prompt', text,
    ];
    if (thinkingLevel) {
      workerArgs.push('--thinking-level', thinkingLevel);
    }
    agentProcess = spawn(process.execPath, workerArgs, {
      detached: true,
      stdio: 'ignore',
    });

    agentProcess.unref();

    // Connect to socket once it comes up
    let attempts = 0;
    const connectInterval = setInterval(async () => {
      attempts++;
      const client = await connectSocket();
      if (client || attempts > 20) {
        clearInterval(connectInterval);
      }
    }, 100);

    agentProcess.on('exit', () => {
      setTimeout(() => {
        if (displayState.isRunning) {
          displayState.isRunning = false;
          displayState.messages.push({
            role: 'assistant',
            content: '⟦agent process exited unexpectedly⟧',
            timestamp: Date.now(),
          });
          displayState.streamingText = '';
          agentProcess = null;
          socketClient?.disconnect();
          socketClient = null;
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
        if (socketClient) {
          socketClient.sendCommand({ type: 'steer', text });
        }
      }}
      onHalt={() => {
        if (socketClient && !haltPressed) {
          haltPressed = true;
          socketClient.sendCommand({ type: 'halt', reason: 'user halted' });
          setTimeout(() => { haltPressed = false; }, 3000);
        } else if (agentProcess && haltPressed) {
          try { agentProcess.kill('SIGTERM'); } catch {}
          haltPressed = false;
        }
      }}
      onExit={() => {
        socketClient?.disconnect();
        unmount();
        process.exit(0);
      }}
    />,
    { exitOnCtrlC: false },
  );
  renderFns = { rerender, unmount };

  // ── Reattach to a running agent (if one exists for this session) ──
  const socketPath = getSocketPath(SOCKETS_DIR, sessionKey);
  const active = await isSessionActive(socketPath);
  if (active) {
    displayState.isRunning = true;
    await connectSocket();
    forceUpdate();
  }

  if (initialPrompt && !displayState.isRunning) {
    sendPrompt(initialPrompt);
  }
}

// ── Plain text mode (no TUI) ─────────────────────────────────────────
// The agent runs in-process. All output goes through the journal —
// stdout mode subscribes to the journal and prints events to the
// terminal. If an agent is already running for this session (e.g. spawned
// by another process, worker, or TUI), stdout mode reattaches to it instead of
// starting a new one.

async function runStdout(
  prompt: string,
  sessionKey: string,
  thinkingLevel?: string,
  options?: { watch?: boolean; attach?: boolean },
) {
  const socketPath = getSocketPath(SOCKETS_DIR, sessionKey);
  const active = await isSessionActive(socketPath);

  // If already active, attach/steer via socket
  if (active) {
    const client = new SessionSocketClient(socketPath);
    try {
      await client.connect();
    } catch (e) {
      // Failed to connect, proceed to fresh run
    }

    if (options?.watch || options?.attach || prompt) {
      if (prompt) {
        process.stderr.write(`  ⟦steer: ${prompt}⟧\n`);
        client.sendCommand({ type: 'steer', text: prompt });
      }

      let firstText = true;
      const onSigInt = () => {
        if (options?.watch) {
          process.stderr.write('\n  Detached from session.\n');
          client.disconnect();
          process.exit(0);
        } else {
          process.stderr.write('\n  ⏹ Halting agent…\n');
          client.sendCommand({ type: 'halt', reason: 'user interrupted' });
        }
      };
      process.on('SIGINT', onSigInt);

      await new Promise<void>((resolve) => {
        client.onEvent((ev: SocketEvent) => {
          switch (ev.type) {
            case 'text':
              if (firstText) {
                process.stdout.write('\n');
                firstText = false;
              }
              process.stdout.write(ev.delta || '');
              break;
            case 'tool':
              if (ev.phase === 'start') {
                process.stderr.write(`\n  → ${ev.name}(${ev.file || ''})\n`);
              } else if (ev.phase === 'end') {
                process.stderr.write(`  ✓ ${ev.name}\n`);
              }
              break;
            case 'file':
              process.stderr.write(`  📝 ${ev.file}\n`);
              break;
            case 'steer':
              process.stderr.write(`\n  ⟦steer: ${ev.text}⟧\n`);
              break;
            case 'halt':
              process.stderr.write('\n  Halted.\n');
              break;
            case 'done':
              if (!firstText) process.stdout.write('\n');
              resolve();
              break;
          }
        });
      });

      process.off('SIGINT', onSigInt);
      client.disconnect();
      return;
    }
  }

  if (!prompt) {
    console.log('Usage: lc [prompt]');
    console.log('       lc --watch');
    console.log('       lc --attach [prompt]');
    console.log('Run "lc help" for more options.');
    process.exit(1);
  }

  const socketServer = new SessionSocketServer(socketPath, sessionKey);
  await socketServer.start();

  let built;
  try {
    built = await buildAgent({ thinkingLevel });
  } catch (err) {
    socketServer.close();
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }

  const { agent } = built;
  let firstText = true;

  try {
    const handle = agent.run({
      message: prompt,
      metadata: {
        sessionId: sessionKey,
        __socketServer: socketServer,
        streamCallbacks: {
          onText: (delta: string) => {
            if (firstText) {
              process.stdout.write('\n');
              firstText = false;
            }
            process.stdout.write(delta);
            socketServer.broadcast({ type: 'text', delta, ts: Date.now() });
          },
        },
      },
    });

    socketServer.attachHandle(handle);

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

    socketServer.broadcast({
      type: 'done',
      reply: result.message || '',
      finishReason: result.finishReason,
      ts: Date.now(),
    });

    if (firstText) {
      console.log(result.message || '(no response)');
    } else {
      process.stdout.write('\n');
    }

    if (result.finishReason === 'error' && result.metadata?.error) {
      const err = result.metadata.error as any;
      process.stderr.write(`\n[agent error] ${err?.message || String(err)}\n`);
      if (err?.stack) {
        process.stderr.write(`${err.stack}\n`);
      }
    }
  } finally {
    socketServer.close();
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

// ── Entry ────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
