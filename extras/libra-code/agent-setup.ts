/**
 * Shared agent setup for lc — used by both the CLI mode and the
 * --worker (silent background) mode.
 *
 * This is the single source of truth for:
 * - Paths (~/.libra/...)
 * - Config loading
 * - System prompt
 * - Agent construction + extension wiring
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Agent } from '@xandout/libra-harness';
import { resolveModel } from '@xandout/libra-harness/extras/models';
import { createDiskSessionExtension } from '@xandout/libra-harness/extras/disk-session';
import { createCodeToolsExtension } from '@xandout/libra-harness/extras/code-tools';
import { createStreamingExtension } from '@xandout/libra-harness/extras/streaming';
import { createFileChangeTracker } from './file-change-tracker.js';
import { createSessionStats, type SessionStats } from './session-stats.js';
import { createTurnEventsExtension, createCommandPollingExtension } from './turn-journal.js';
import type { FileChange } from './tui.js';

// ── Paths ────────────────────────────────────────────────────────────
export const LIBRA_HOME = join(homedir(), '.libra');
export const SESSIONS_DIR = join(LIBRA_HOME, 'sessions');
export const SHELLS_DIR = join(LIBRA_HOME, 'shells');
export const TODOS_DIR = join(LIBRA_HOME, 'todos');
export const TURNS_DIR = join(LIBRA_HOME, 'turns');
export const TURN_META_DIR = join(LIBRA_HOME, 'turn-meta');
export const LOCKS_DIR = join(LIBRA_HOME, 'locks');
export const CONFIG_FILE = join(LIBRA_HOME, 'config.json');

// ── Config ───────────────────────────────────────────────────────────
export interface LibraCodeConfig {
  model?: string;
  maxIterations?: number;
  /** Custom system prompt. Overrides the default if set. */
  systemPrompt?: string;
}

export function loadConfig(): LibraCodeConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

export function saveConfig(config: LibraCodeConfig): void {
  mkdirSync(LIBRA_HOME, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function ensureDirs(): void {
  mkdirSync(LIBRA_HOME, { recursive: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  mkdirSync(SHELLS_DIR, { recursive: true });
  mkdirSync(TODOS_DIR, { recursive: true });
  mkdirSync(TURNS_DIR, { recursive: true });
  mkdirSync(TURN_META_DIR, { recursive: true });
  mkdirSync(LOCKS_DIR, { recursive: true });
}

export function sessionKeyForCwd(cwd: string): string {
  return 'cwd_' + cwd.replace(/[^a-zA-Z0-9]/g, '_');
}

// ── System prompt ────────────────────────────────────────────────────
export const SYSTEM_PROMPT = `You are a code agent. You help with software engineering tasks.

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

/**
 * Load project-specific instructions from AGENTS.md in the given directory.
 * Returns the raw content, or undefined if no AGENTS.md exists.
 */
export function loadAgentsMd(dir: string): string | undefined {
  const path = join(dir, 'AGENTS.md');
  if (!existsSync(path)) return undefined;
  try {
    const content = readFileSync(path, 'utf-8').trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the full system prompt.
 *
 * Precedence (highest wins):
 *   1. config.systemPrompt — user-set custom prompt (lc config set systemPrompt)
 *   2. SYSTEM_PROMPT — the built-in default
 *
 * Then AGENTS.md from the project root is appended (if present), so
 * project-specific instructions are always visible to the model.
 */
export function buildSystemPrompt(projectDir?: string): string {
  const config = loadConfig();
  const base = config.systemPrompt?.trim() || SYSTEM_PROMPT;
  const agentsMd = loadAgentsMd(projectDir ?? process.cwd());
  if (!agentsMd) return base;
  return `${base}

══════════════════════════════════════════════════════════════════════
PROJECT INSTRUCTIONS (AGENTS.md)
══════════════════════════════════════════════════════════════════════
${agentsMd}`;
}

// ── Agent builder ────────────────────────────────────────────────────
export interface BuildAgentOptions {
  /** Include journal + command-polling extensions (for --worker mode). */
  journalMode?: boolean;
}

export interface BuiltAgent {
  agent: Agent;
  fileChanges: FileChange[];
  sessionStats: SessionStats;
  todoFile: string;
}

/**
 * Build the agent with all extensions. This is the single construction
 * path used by both CLI mode and --worker mode.
 */
export async function buildAgent(opts: BuildAgentOptions = {}): Promise<BuiltAgent> {
  const config = loadConfig();
  const modelId = config.model ?? process.env.LIBRA_MODEL ?? process.env.MODEL;
  if (!modelId) {
    throw new Error('No model configured. Set one with: lc config set model <provider/model>');
  }

  const model = await resolveModel(modelId);
  const cwd = process.cwd();
  const sessionKey = sessionKeyForCwd(cwd);
  const todoFile = join(TODOS_DIR, `${sessionKey}.json`);

  const fileChanges: FileChange[] = [];
  const sessionStats: SessionStats = {
    promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0,
    cacheWriteTokens: 0, reasoningTokens: 0, llmCalls: 0, turns: 0,
    toolCalls: 0, toolErrors: 0, lastPromptTokens: 0, lastCompletionTokens: 0,
  };

  const agent = new Agent({
    model,
    systemPrompt: buildSystemPrompt(cwd),
    maxIterations: config.maxIterations ?? 50,
  });

  // Extensions — same order for both modes.
  agent.use(createDiskSessionExtension({
    sessionDir: SESSIONS_DIR,
    maxContextMessages: 100,
    verbose: false,
  }));
  agent.use(createStreamingExtension());
  agent.use(createFileChangeTracker(fileChanges));
  agent.use(createSessionStats(sessionStats));
  agent.use(createCodeToolsExtension({
    shellsDir: SHELLS_DIR,
    todoFile,
    model,
    codeSearchMaxIterations: 10,
  }));

  // Journal mode (--worker): add turn events + command polling.
  if (opts.journalMode) {
    agent.use(createTurnEventsExtension());
    agent.use(createCommandPollingExtension());
  }

  return { agent, fileChanges, sessionStats, todoFile };
}
