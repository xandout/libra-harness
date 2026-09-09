#!/usr/bin/env node

import { configuredProviders } from '@xandout/libra-harness/models';
import {
  SOCKETS_DIR, CONFIG_FILE, SESSIONS_DIR,
  loadConfig, saveConfig, ensureDirs, sessionKeyForCwd, buildAgent,
} from './agent-setup.js';
import {
  SessionSocketServer, SessionSocketClient, isSessionActive, getSocketPath, type SocketEvent,
} from './session-socket.js';
import { readdirSync, readFileSync, unlinkSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LIBRA_HOME = process.env.LIBRA_HOME || join(homedir(), '.libra');
const SHELLS_DIR = join(LIBRA_HOME, 'shells');

// ── CLI ──────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args[0] === 'config') {
    await handleConfigCommand(args);
    return;
  }

  if (args[0] === 'providers') {
    handleProvidersCommand();
    return;
  }

  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    handleHelpCommand();
    return;
  }

  // ── Parse flags ──
  let watchMode = false;
  let attachMode = false;
  let cleanMode = false;
  let thinkingLevel: string | undefined;
  let customSessionKey: string | undefined;

  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--watch' || arg === '-w') {
      watchMode = true;
    } else if (arg === '--attach' || arg === '-a') {
      attachMode = true;
    } else if (arg === '--clean') {
      cleanMode = true;
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

  if (cleanMode) {
    cleanSession(sessionKey);
    if (!prompt) {
      console.log('Session cleaned. Run lc with a prompt to start fresh.');
      return;
    }
  }

  await runStdout(prompt, sessionKey, thinkingLevel, { watch: watchMode, attach: attachMode });
}

// ── Clean: kill tasks and clear session ─────────────────────────────
function cleanSession(sessionKey: string) {
  const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  let killed = 0;

  // Kill any running task processes for this session.
  try {
    for (const file of readdirSync(SHELLS_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(readFileSync(join(SHELLS_DIR, file), 'utf-8'));
        if (meta.session !== sessionKey && meta.session !== safeKey) continue;
        if (meta.pid) {
          try {
            process.kill(meta.pid, 0);
            process.kill(meta.pid, 'SIGKILL');
            killed++;
          } catch {}
        }
      } catch {}
    }
  } catch {}

  // Remove the session file so the agent starts fresh.
  const sessionFile = join(SESSIONS_DIR, `${safeKey}.jsonl`);
  if (existsSync(sessionFile)) {
    rmSync(sessionFile, { force: true });
  }

  // Remove stale socket so a new session can start.
  const socketPath = getSocketPath(SOCKETS_DIR, sessionKey);
  try { unlinkSync(socketPath); } catch {}

  console.log(`Cleaned session ${sessionKey}: ${killed} task(s) killed, session file removed.`);
}

// ── Plain text mode (no TUI) ─────────────────────────────────────────

async function handleConfigCommand(args: string[]) {
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
}

function handleProvidersCommand() {
  const providers = configuredProviders();
  if (providers.length === 0) {
    console.log('No providers configured. Set an API key environment variable:');
    console.log('  OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, DEEPSEEK_API_KEY');
  } else {
    console.log('Configured providers:', providers.join(', '));
  }
}

function handleHelpCommand() {
  console.log('lc — libra code agent');
  console.log('');
  console.log('Usage: lc [prompt]            Run the agent or reattach to active session');
  console.log('       lc --watch             Watch active session (Ctrl+C detaches, agent continues)');
  console.log('       lc --attach [prompt]   Attach to active session (Ctrl+C halts/kills agent)');
  console.log('       lc --clean [prompt]    Kill tasks and clear session, then optionally run');
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
}

// The agent runs in-process. All output goes through the journal —
// stdout mode subscribes to the journal and prints events to the
// terminal. If an agent is already running for this session (e.g. spawned
// by another process), stdout mode reattaches to it instead of
// starting a new one.

// fallow-ignore-next-line complexity
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
            case 'message':
              if (ev.text) {
                process.stdout.write(`\n⟦blurb:${JSON.stringify(ev.text)}⟧\n`);
              }
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

    handle.onMessage((blurb: string) => {
      process.stdout.write(`\n⟦blurb:${JSON.stringify(blurb)}⟧\n`);
      socketServer.broadcast({ type: 'message', text: blurb, ts: Date.now() });
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
      let cause = err?.cause;
      const seen = new Set<unknown>();
      while (cause && !seen.has(cause)) {
        seen.add(cause);
        const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
        process.stderr.write(`[caused by] ${message}\n`);
        cause = cause instanceof Error ? cause.cause : undefined;
      }
    }
  } finally {
    socketServer.close();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────


// ── Entry ────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
