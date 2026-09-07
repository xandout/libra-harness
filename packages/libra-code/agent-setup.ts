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
import { join, resolve } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Agent } from '@xandout/libra-harness';
import { resolveModel } from '@xandout/libra-harness/models';
import type { ResolveModelOptions } from '@xandout/libra-harness/models';
import { createDiskSessionExtension } from '@xandout/libra-harness/extensions/disk-session';
import { createCodeToolsExtension } from '@xandout/libra-harness/extensions/code-tools';
import { createStreamingExtension } from '@xandout/libra-harness/extensions/streaming';
import { createSkillExtension } from '@xandout/libra-harness/extensions/skills';
import { createFileChangeTracker } from './file-change-tracker.js';
import { createSessionStats, type SessionStats } from './session-stats.js';
import { createSocketEventsExtension } from './session-socket.js';

// ── Paths ────────────────────────────────────────────────────────────
// LIBRA_HOME can be overridden via env var (e.g. for containerized use
// where state must live on a mounted volume). Defaults to ~/.libra.
const LIBRA_HOME = process.env.LIBRA_HOME || join(homedir(), '.libra');
export const SESSIONS_DIR = join(LIBRA_HOME, 'sessions');
export const SOCKETS_DIR = join(LIBRA_HOME, 'sockets');
const SHELLS_DIR = join(LIBRA_HOME, 'shells');
export const TODOS_DIR = join(LIBRA_HOME, 'todos');
export const CONFIG_FILE = join(LIBRA_HOME, 'config.json');

export interface LibraCodeConfig {
  model?: string;
  visionModel?: string;
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
  mkdirSync(SOCKETS_DIR, { recursive: true });
  mkdirSync(SHELLS_DIR, { recursive: true });
  mkdirSync(TODOS_DIR, { recursive: true });
}

export function sessionKeyForCwd(cwd: string): string {
  return 'cwd_' + cwd.replace(/[^a-zA-Z0-9]/g, '_');
}

// ── System prompt ────────────────────────────────────────────────────
// fallow-ignore-next-line unused-export
export const SYSTEM_PROMPT = `You are a direct, practical coding agent.

You have tools for reading, writing, editing files, searching code, running shell commands, and tracking tasks.

Principles:
- Be fast, pragmatic, and action-oriented. Inspect only what is directly relevant and make changes directly.
- Avoid unnecessary exploration, over-planning, or excessive tool calls.
- Use absolute paths for all file operations.
- Keep responses concise and focused on results.
- Do not push to git or commit secrets unless explicitly requested.`;

interface InstructionFile {
  filename: string;
  path: string;
  content: string;
}

/**
 * Look for instruction files in a directory in standard precedence order:
 * 1. SYSTEM.md
 * 2. AGENTS.md
 * 3. .libra/SYSTEM.md
 * 4. .libra/AGENTS.md
 */
// fallow-ignore-next-line unused-export
export function loadInstructionFile(dir: string): InstructionFile | undefined {
  const candidates = ['SYSTEM.md', 'AGENTS.md', join('.libra', 'SYSTEM.md'), join('.libra', 'AGENTS.md')];
  for (const rel of candidates) {
    const fullPath = join(dir, rel);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8').trim();
        if (content) {
          return { filename: rel, path: fullPath, content };
        }
      } catch {}
    }
  }
  return undefined;
}

/**
 * Backwards-compatibility helper: load project-specific instructions from
 * SYSTEM.md or AGENTS.md in the given directory.
 */
// fallow-ignore-next-line unused-export
export function loadAgentsMd(dir: string): string | undefined {
  return loadInstructionFile(dir)?.content;
}


function getLibraHome(): string {
  return process.env.LIBRA_HOME || LIBRA_HOME;
}

/**
 * Build the full system prompt with layered instructions:
 *
 * Layering (lowest to highest specificity):
 *   1. Base Persona: config.systemPrompt (user override) or default SYSTEM_PROMPT.
 *   2. User-level instructions: ~/.libra/SYSTEM.md (or AGENTS.md) if present.
 *   3. Project-level instructions: <projectDir>/SYSTEM.md (or AGENTS.md, .libra/SYSTEM.md) if present.
 *   4. Environment-injected instructions: LIBRA_EXTRA_SYSTEM if present.
 *
 * User and project instruction files are never modified or overwritten by lc updates.
 */
export function buildSystemPrompt(projectDir?: string): string {
  const config = loadConfig();
  const base = config.systemPrompt?.trim() || SYSTEM_PROMPT;
  const project = resolve(projectDir ?? process.cwd());
  const globalHome = resolve(getLibraHome());

  // 1. Global user-level instructions (from LIBRA_HOME / ~/.libra)
  let globalInstructions: InstructionFile | undefined;
  if (globalHome && globalHome !== project) {
    globalInstructions = loadInstructionFile(globalHome);
  }

  // 2. Project-level instructions (from projectDir / cwd)
  const projectInstructions = loadInstructionFile(project);

  // 3. Optional extra system from environment
  const extraSystem = process.env.LIBRA_EXTRA_SYSTEM?.trim();

  let prompt = base;
  if (globalInstructions) {
    prompt += `\n\n══════════════════════════════════════════════════════════════════════\nUSER INSTRUCTIONS (${globalInstructions.filename})\n══════════════════════════════════════════════════════════════════════\n${globalInstructions.content}`;
  }
  if (projectInstructions) {
    if (!globalInstructions || globalInstructions.path !== projectInstructions.path) {
      prompt += `\n\n══════════════════════════════════════════════════════════════════════\nPROJECT INSTRUCTIONS (${projectInstructions.filename})\n══════════════════════════════════════════════════════════════════════\n${projectInstructions.content}`;
    }
  }
  if (extraSystem) {
    prompt += `\n\n${extraSystem}`;
  }
  return prompt;
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
// fallow-ignore-next-line complexity
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
 * Resolve directories to search for Agent Skills following industry conventions.
 * Searches:
 * - LIBRA_SKILLS_DIR (colon-separated env var)
 * - /opt/skills (system-wide container path)
 * - ~/.libra/skills (or $LIBRA_HOME/skills)
 * - <projectDir>/.libra/skills
 * - <projectDir>/skills
 */
export function resolveSkillsDirs(projectDir: string = process.cwd()): string[] {
  const candidates: string[] = [];
  const home = resolve(getLibraHome());

  if (process.env.LIBRA_SKILLS_DIR) {
    for (const d of process.env.LIBRA_SKILLS_DIR.split(':')) {
      if (d.trim()) candidates.push(resolve(d.trim()));
    }
  }

  candidates.push('/opt/skills');
  candidates.push(join(home, 'skills'));
  const userHomeSkills = join(homedir(), '.libra', 'skills');
  if (home !== resolve(userHomeSkills)) {
    candidates.push(userHomeSkills);
  }
  candidates.push(join(projectDir, '.libra', 'skills'));
  candidates.push(join(projectDir, 'skills'));

  const existing = candidates.filter((d) => existsSync(d));
  if (existing.length > 0) {
    return [...new Set([...existing, join(projectDir, 'skills'), join(home, 'skills')])];
  }
  return [...new Set([join(projectDir, 'skills'), join(home, 'skills')])];
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
  const visionModelId = config.visionModel ?? process.env.LIBRA_VISION_MODEL ?? process.env.VISION_MODEL;
  let visionModel: import('@xandout/libra-harness').Model | undefined;
  if (visionModelId) {
    try {
      visionModel = await resolveModel(visionModelId, { providers: buildProviders() });
    } catch (err) {
      console.warn(`[vision] Failed to resolve VISION_MODEL "${visionModelId}":`, err instanceof Error ? err.message : String(err));
    }
  }

  const cwd = process.cwd();
  const sessionKey = sessionKeyForCwd(cwd);
  const todoFile = join(TODOS_DIR, `${sessionKey}.json`);

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
  agent.use(createFileChangeTracker());
  agent.use(createSessionStats(sessionStats));
  agent.use(createCodeToolsExtension({
    shellsDir: SHELLS_DIR,
    todoFile,
    model,
    visionModel,
    codeSearchMaxIterations: 10,
  }));
  agent.use(createSocketEventsExtension());

  // Agent skills extension — progressive disclosure for tools and workflow instructions
  const skillsDirs = resolveSkillsDirs(cwd);
  const preloadSkills = process.env.LIBRA_PRELOAD_SKILLS
    ? process.env.LIBRA_PRELOAD_SKILLS.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  const skillsExt = createSkillExtension({
    skillsDirs,
    preloadSkills,
  });
  if (skillsExt) {
    agent.use(skillsExt);
  }

  return { agent, sessionStats, todoFile };
}
