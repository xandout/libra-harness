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
import type { ResolveModelOptions } from '@xandout/libra-harness/extras/models';
import { createDiskSessionExtension } from '@xandout/libra-harness/extras/disk-session';
import { createCodeToolsExtension } from '@xandout/libra-harness/extras/code-tools';
import { createStreamingExtension } from '@xandout/libra-harness/extras/streaming';
import { createFileChangeTracker } from './file-change-tracker.js';
import { createSessionStats, type SessionStats } from './session-stats.js';
import { createTurnEventsExtension, createCommandPollingExtension } from './turn-journal.js';
import type { FileChange } from './tui.js';

// ── Paths ────────────────────────────────────────────────────────────
// LIBRA_HOME can be overridden via env var (e.g. for containerized use
// where state must live on a mounted volume). Defaults to ~/.libra.
export const LIBRA_HOME = process.env.LIBRA_HOME || join(homedir(), '.libra');
export const SESSIONS_DIR = join(LIBRA_HOME, 'sessions');
export const SHELLS_DIR = join(LIBRA_HOME, 'shells');
export const TODOS_DIR = join(LIBRA_HOME, 'todos');
export const TURNS_DIR = join(LIBRA_HOME, 'turns');
export const TURN_META_DIR = join(LIBRA_HOME, 'turn-meta');
export const LOCKS_DIR = join(LIBRA_HOME, 'locks');
export const CONFIG_FILE = join(LIBRA_HOME, 'config.json');

export interface LibraCodeConfig {
  model?: string;
  maxIterations?: number;
  /** Custom system prompt. Overrides the default if set. */
  systemPrompt?: string;
  /** Thinking level for models that support reasoning mode: 'off' | 'low' | 'medium' | 'high' | 'max' */
  thinkingLevel?: string;
  /** Alias for thinkingLevel */
  reasoningEffort?: string;
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

export interface ThinkingResolvedConfig {
  thinkingLevel?: string;
  reasoningEffort?: 'low' | 'high' | 'max';
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * Resolve thinking level and reasoning effort options from explicit options,
 * configuration, or environment variables.
 *
 * Supported levels:
 * - 'off' / 'disabled': thinking mode disabled
 * - 'low': minimal reasoning
 * - 'medium': standard reasoning
 * - 'high': standard reasoning (default for reasoning models)
 * - 'max': maximum reasoning effort
 */
export function resolveThinkingConfig(thinkingInput?: string): ThinkingResolvedConfig {
  const config = loadConfig();
  const raw =
    thinkingInput ??
    config.thinkingLevel ??
    config.reasoningEffort ??
    process.env.LIBRA_THINKING_LEVEL ??
    process.env.THINKING_LEVEL ??
    process.env.LIBRA_REASONING_EFFORT ??
    process.env.REASONING_EFFORT;

  if (!raw || typeof raw !== 'string') {
    return {};
  }

  const val = raw.trim().toLowerCase();

  if (val === 'off' || val === 'disabled' || val === 'false' || val === '0' || val === 'none') {
    return {
      thinkingLevel: 'off',
      providerOptions: {
        deepseek: {
          thinking: { type: 'disabled' },
        },
      },
    };
  }

  if (val === 'low') {
    return {
      thinkingLevel: 'low',
      reasoningEffort: 'low',
      providerOptions: {
        deepseek: {
          thinking: { type: 'enabled' },
          reasoningEffort: 'low',
        },
      },
    };
  }

  if (val === 'medium') {
    return {
      thinkingLevel: 'medium',
      reasoningEffort: 'high',
      providerOptions: {
        deepseek: {
          thinking: { type: 'enabled' },
          reasoningEffort: 'medium',
        },
      },
    };
  }

  if (val === 'high' || val === 'enabled' || val === 'on' || val === 'true') {
    return {
      thinkingLevel: 'high',
      reasoningEffort: 'high',
      providerOptions: {
        deepseek: {
          thinking: { type: 'enabled' },
          reasoningEffort: 'high',
        },
      },
    };
  }

  if (val === 'max' || val === 'xhigh') {
    return {
      thinkingLevel: 'max',
      reasoningEffort: 'max',
      providerOptions: {
        deepseek: {
          thinking: { type: 'enabled' },
          reasoningEffort: 'max',
        },
      },
    };
  }

  const mappedEffort: 'low' | 'high' | 'max' =
    val === 'low' ? 'low' : val === 'max' || val === 'xhigh' ? 'max' : 'high';

  return {
    thinkingLevel: val,
    reasoningEffort: mappedEffort,
    providerOptions: {
      deepseek: {
        thinking: { type: 'enabled' },
        reasoningEffort: val,
      },
    },
  };
}

// ── Agent builder ────────────────────────────────────────────────────
export interface BuildAgentOptions {
  thinkingLevel?: string;
  reasoningEffort?: string;
}

export interface BuiltAgent {
  agent: Agent;
  fileChanges: FileChange[];
  sessionStats: SessionStats;
  todoFile: string;
}

/**
 * Build provider definitions that respect `<PROVIDER>_BASE_URL` env vars
 * and custom headers. This lets `lc` point at an OpenAI-compatible proxy
 * (e.g. zocode's /model proxy) instead of the real provider API.
 *
 * Supported env vars per provider:
 *   openai:    OPENAI_API_KEY, OPENAI_BASE_URL (read natively by @ai-sdk/openai)
 *   deepseek:  DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL
 *   anthropic: ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL
 *   google:    GOOGLE_GENERATIVE_AI_API_KEY (no base URL override)
 *
 * Additionally, any provider supports `<PROVIDER>_EXTRA_HEADERS` as a
 * JSON object string for custom headers (e.g. x-project-id).
 */
function buildProviders(): ResolveModelOptions['providers'] {
  const env = process.env;

  function extraHeaders(provider: string): Record<string, string> | undefined {
    const raw = env[`${provider.toUpperCase()}_EXTRA_HEADERS`];
    if (!raw) return undefined;
    try { return JSON.parse(raw); } catch { return undefined; }
  }

  return {
    openai: {
      envVar: 'OPENAI_API_KEY',
      async load() {
        const { createOpenAI } = await import('@ai-sdk/openai');
        const provider = createOpenAI({
          baseURL: env.OPENAI_BASE_URL,
          headers: extraHeaders('openai'),
        });
        return (modelId: string) => provider.chat(modelId);
      },
    },
    deepseek: {
      envVar: 'DEEPSEEK_API_KEY',
      async load() {
        const { createDeepSeek } = await import('@ai-sdk/deepseek');
        const provider = createDeepSeek({
          baseURL: env.DEEPSEEK_BASE_URL,
          headers: extraHeaders('deepseek'),
        });
        return (modelId: string) => provider(modelId);
      },
    },
    anthropic: {
      envVar: 'ANTHROPIC_API_KEY',
      async load() {
        const { anthropic } = await import('@ai-sdk/anthropic');
        return (modelId: string) => anthropic(modelId);
      },
    },
    google: {
      envVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
      async load() {
        const { google } = await import('@ai-sdk/google');
        return (modelId: string) => google(modelId);
      },
    },
  };
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

  const model = await resolveModel(modelId, { providers: buildProviders() });
  const cwd = process.cwd();
  const sessionKey = sessionKeyForCwd(cwd);
  const todoFile = join(TODOS_DIR, `${sessionKey}.json`);

  const fileChanges: FileChange[] = [];
  const sessionStats: SessionStats = {
    promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0,
    cacheWriteTokens: 0, reasoningTokens: 0, llmCalls: 0, turns: 0,
    toolCalls: 0, toolErrors: 0, lastPromptTokens: 0, lastCompletionTokens: 0,
  };

  const thinkingConfig = resolveThinkingConfig(opts.thinkingLevel ?? opts.reasoningEffort);

  const agent = new Agent({
    model,
    systemPrompt: buildSystemPrompt(cwd),
    maxIterations: config.maxIterations ?? 50,
    ...(thinkingConfig.reasoningEffort && { reasoningEffort: thinkingConfig.reasoningEffort }),
    ...(thinkingConfig.providerOptions && { providerOptions: thinkingConfig.providerOptions }),
  });

  // Extensions — always installed. The journal is the single source of
  // truth for all output; every mode (worker, TUI, stdout) subscribes to
  // it. Turn events + command polling are always on.
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
  agent.use(createTurnEventsExtension());
  agent.use(createCommandPollingExtension());

  return { agent, fileChanges, sessionStats, todoFile };
}
