import type { Extension } from '../../../extension.js';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { execFile } from 'node:child_process';

/**
 * Skill metadata — loaded at startup for all skills (progressive disclosure
 * level 1: ~100 tokens per skill).
 */
export interface SkillMeta {
  /** Skill name (from frontmatter, must match directory name). */
  name: string;
  /** What the skill does and when to use it. */
  description: string;
  /** Optional license. */
  license?: string;
  /** Optional compatibility notes. */
  compatibility?: string;
  /** Optional arbitrary key-value metadata. */
  metadata?: Record<string, string>;
  /** Optional pre-approved tools. */
  allowedTools?: string[];
  /**
   * If true, the skill's content is appended to the system prompt at
   * install time so it's always active without the agent calling
   * use_skill. Set via `autoLoad: true` in SKILL.md frontmatter.
   */
  autoLoad?: boolean;
  /** Absolute path to the skill directory. */
  dir: string;
}

/**
 * A loaded skill — metadata plus the full SKILL.md body content
 * (progressive disclosure level 2: loaded on activation).
 */
export interface Skill extends SkillMeta {
  /** Full markdown body from SKILL.md (after frontmatter). */
  content: string;
}

/**
 * Parse YAML frontmatter from a markdown file.
 *
 * Supports a subset of YAML sufficient for SKILL.md frontmatter:
 * - Simple `key: value` pairs
 * - Nested maps under `metadata:`
 * - Values may be quoted or unquoted strings
 *
 * Returns `{ frontmatter, body }` where `body` is the markdown after the
 * closing `---`.
 */
function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: raw };
  }

  const fm: Record<string, unknown> = {};
  let i = 1;
  let currentMap: Record<string, string> | null = null;

  while (i < lines.length && lines[i].trim() !== '---') {
    const line = lines[i];

    // Nested map entry (e.g. under `metadata:`).
    if (line.startsWith('  ') && currentMap) {
      const match = line.trim().match(/^(\w+):\s*(.*)$/);
      if (match) {
        currentMap[match[1]] = stripQuotes(match[2]);
      }
      i++;
      continue;
    }

    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      if (value === '') {
        // Start of a nested map.
        currentMap = {};
        fm[key] = currentMap;
      } else {
        currentMap = null;
        fm[key] = stripQuotes(value);
      }
    }
    i++;
  }

  // Skip the closing `---`.
  const body = lines.slice(i + 1).join('\n').trim();
  return { frontmatter: fm, body };
}

function stripQuotes(s: string): string {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Load skill metadata from a directory containing skill subdirectories.
 *
 * Each subdirectory must contain a `SKILL.md` file with YAML frontmatter.
 * Only metadata (name, description) is loaded at startup — the full body
 * is loaded on demand when the skill is activated (progressive disclosure).
 *
 * @example
 * skills/
 *   code-review/
 *     SKILL.md
 *     references/
 *     scripts/
 *   summarize/
 *     SKILL.md
 */
export function loadSkills(skillsDir: string): SkillMeta[] {
  if (!existsSync(skillsDir)) return [];

  const skills: SkillMeta[] = [];

  for (const entry of readdirSync(skillsDir)) {
    const skillDir = join(skillsDir, entry);
    if (!statSync(skillDir).isDirectory()) continue;

    const skillMdPath = join(skillDir, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;

    const raw = readFileSync(skillMdPath, 'utf-8');
    const { frontmatter } = parseFrontmatter(raw);

    const name = (frontmatter.name as string) ?? entry;
    const description = (frontmatter.description as string) ?? '';

    skills.push({
      name,
      description,
      ...(frontmatter.license ? { license: frontmatter.license as string } : {}),
      ...(frontmatter.compatibility ? { compatibility: frontmatter.compatibility as string } : {}),
      ...(frontmatter.metadata ? { metadata: frontmatter.metadata as Record<string, string> } : {}),
      ...(frontmatter['allowed-tools']
        ? { allowedTools: (frontmatter['allowed-tools'] as string).split(' ').filter(Boolean) }
        : {}),
      ...(frontmatter.autoLoad !== undefined ? { autoLoad: frontmatter.autoLoad === true || frontmatter.autoLoad === 'true' } : {}),
      dir: skillDir,
    });
  }

  return skills;
}

/** Load the full SKILL.md body for a skill (progressive disclosure level 2). */
function loadSkillContent(skill: SkillMeta): string {
  const raw = readFileSync(join(skill.dir, 'SKILL.md'), 'utf-8');
  const { body } = parseFrontmatter(raw);
  return body;
}

/**
 * Config for the skills extension.
 *
 * Passed by the extension loader from the host's config object.
 * The key `skillsDirs` should be declared in extension.json's `configKeys`.
 */
export interface SkillsExtensionConfig {
  /** One or more directories to scan for skills. */
  skillsDirs?: string | string[];
  /**
   * Skill names to preload at startup. Preloaded skills have their full
   * SKILL.md content injected into every turn via a `beforeContext` hook,
   * so the agent has the instructions available immediately without
   * needing to call `use_skill` first.
   *
   * Use this for skills that must always be active (e.g. behavior rules,
   * platform conventions) rather than skills that are task-specific.
   */
  preloadSkills?: string | string[];
}

/**
 * Create a skill loader extension following the Agent Skills specification.
 *
 * Receives config from the extension loader. The `skillsDirs` key (a path
 * or array of paths) tells the extension where to find skill directories.
 * If no `skillsDirs` is provided, the factory returns `undefined` (opts out).
 *
 * Implements progressive disclosure:
 * 1. **Metadata** (~100 tokens/skill): name + description loaded at startup.
 * 2. **Instructions** (<5000 tokens): full SKILL.md body loaded on activation.
 * 3. **Resources** (as needed): files in scripts/, references/, assets/ loaded on demand.
 *
 * Registers four tools the LLM can call:
 * - `list_skills` — returns available skill names and descriptions.
 * - `use_skill` — loads a skill's full instructions into the conversation.
 * - `read_skill_file` — reads a file from a skill's directory (references, scripts, assets).
 * - `run_skill_script` — runs a pre-existing script from a skill's scripts/ directory.
 *
 * ## Runtime discovery
 *
 * All four tools rescan the skills directories on each invocation, so
 * new skill directories appearing at runtime are immediately visible
 * to `list_skills` and loadable via `use_skill` — no restart needed.
 * The rescan reads only frontmatter (not full bodies), so the cost is
 * negligible even with many skill directories.
 *
 * Skills with `autoLoad: true` in their frontmatter are appended to the
 * system prompt at install time only. A new `autoLoad` skill appearing
 * at runtime will NOT be auto-preloaded — use `preloadSkills` config for
 * startup-time skills and `use_skill` for runtime-discovered ones.
 */
export default function createSkillExtension(
  config?: SkillsExtensionConfig,
): Extension | undefined {
  const skillsDirs = config?.skillsDirs;
  if (!skillsDirs) {
    console.log('[skills] no skillsDirs in config — skipping skills extension');
    return undefined;
  }
  const dirs = Array.isArray(skillsDirs) ? skillsDirs : [skillsDirs];

  // ── Live skill registry ──────────────────────────────────────────
  // The skills array and skillMap are refreshed on every tool call so
  // new skill directories appearing at runtime are immediately visible
  // to list_skills / use_skill / read_skill_file / run_skill_script.
  // The refresh is cheap: readdir + frontmatter parse (bodies are not
  // read until use_skill is called).
  const skills: SkillMeta[] = [];
  let skillMap = new Map<string, SkillMeta>();

  function refresh(): void {
    skills.length = 0;
    for (const dir of dirs) {
      skills.push(...loadSkills(dir));
    }
    skillMap = new Map(skills.map((s) => [s.name, s]));
  }

  // Initial load.
  refresh();

  // Determine which skills to preload:
  // 1. Skills with `autoLoad: true` in their frontmatter (self-declared)
  // 2. Skills explicitly listed in config.preloadSkills (host-declared)
  //
  // Preloading appends to the system prompt at install time. Skills
  // discovered later at runtime are NOT auto-preloaded — use preloadSkills
  // for startup-time skills and use_skill for runtime-discovered ones.
  const explicitPreload = config?.preloadSkills
    ? (Array.isArray(config.preloadSkills) ? config.preloadSkills : [config.preloadSkills])
    : [];
  const autoLoadNames = skills.filter((s) => s.autoLoad).map((s) => s.name);
  const preloadNames = [...new Set([...autoLoadNames, ...explicitPreload])];

  const preloadedContent: string[] = [];
  for (const name of preloadNames) {
    const skill = skillMap.get(name);
    if (!skill) {
      console.warn(`[skills] preload: skill "${name}" not found — skipping`);
      continue;
    }
    preloadedContent.push(loadSkillContent(skill));
    console.log(`[skills] preloaded "${name}" — appended to system prompt`);
  }

  console.log(
    `[skills] loaded ${skills.length} skill(s) from ${dirs.join(', ')}` +
      (skills.length > 0 ? ': ' + skills.map((s) => s.name).join(', ') : ''),
  );

  return {
    name: 'skills',
    priority: 50,
    install(agent) {
      // Level 1: list metadata only.
      // Refreshes on each call so runtime-discovered skills appear.
      agent.tool({
        name: 'list_skills',
        description:
          'List available skills with their names and descriptions. Use this first to discover what skills are available.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          refresh();
          if (skills.length === 0) {
            return {
              toolCallId: '',
              content: 'No skills available.',
            };
          }
          const lines = skills.map(
            (s) => `- ${s.name}: ${s.description || '(no description)'}`,
          );
          return {
            toolCallId: '',
            content: `Available skills:\n${lines.join('\n')}`,
          };
        },
      });

      // Level 2: load full SKILL.md body on activation.
      // Refreshes before lookup so a skill that appeared since the last
      // list_skills call can still be activated.
      agent.tool({
        name: 'use_skill',
        description:
          'Activate a skill by loading its full instructions. The SKILL.md content will be returned as context — follow those instructions for the rest of this task.',
        parameters: {
          type: 'object',
          properties: {
            skill: {
              type: 'string',
              description: 'The skill name to activate. Use list_skills to see available options.',
            },
          },
          required: ['skill'],
        },
        async execute(args) {
          refresh();
          const name = args.skill as string;
          const skill = skillMap.get(name);
          if (!skill) {
            const available = [...skillMap.keys()].join(', ');
            return {
              toolCallId: '',
              content: `Skill "${name}" not found. Available: ${available}`,
              isError: true,
            };
          }
          const content = loadSkillContent(skill);
          return {
            toolCallId: '',
            content,
          };
        },
      });

      // Level 3a: read files from a skill's directory on demand.
      agent.tool({
        name: 'read_skill_file',
        description:
          'Read a file from a skill directory (e.g. references/REFERENCE.md, scripts/extract.py). Use relative paths from the skill root.',
        parameters: {
          type: 'object',
          properties: {
            skill: {
              type: 'string',
              description: 'The skill name whose file to read.',
            },
            path: {
              type: 'string',
              description: 'Relative path from the skill root (e.g. references/REFERENCE.md).',
            },
          },
          required: ['skill', 'path'],
        },
        async execute(args) {
          refresh();
          const skillName = args.skill as string;
          const relPath = args.path as string;
          const skill = skillMap.get(skillName);
          if (!skill) {
            return {
              toolCallId: '',
              content: `Skill "${skillName}" not found.`,
              isError: true,
            };
          }
          const fullPath = join(skill.dir, relPath);
          // Prevent path traversal outside the skill directory.
          const rel = relative(skill.dir, fullPath);
          if (rel.startsWith('..') || rel.includes('..')) {
            return {
              toolCallId: '',
              content: 'Path traversal outside skill directory is not allowed.',
              isError: true,
            };
          }
          if (!existsSync(fullPath)) {
            return {
              toolCallId: '',
              content: `File not found: ${relPath}`,
              isError: true,
            };
          }
          const content = readFileSync(fullPath, 'utf-8');
          return {
            toolCallId: '',
            content,
          };
        },
      });

      // Level 3b: run a pre-existing script from a skill's scripts/ directory.
      //
      // Security model: the agent cannot write scripts and then execute
      // them, cannot pass arbitrary shell commands, and cannot run anything
      // outside the skill's scripts/ directory. Only files that already
      // exist on disk are executable. Arguments are passed as an array —
      // no shell interpolation. The interpreter is selected by file
      // extension, not by the agent.
      agent.tool({
        name: 'run_skill_script',
        description:
          'Run a pre-existing script from a skill\'s scripts/ directory. The script must already exist on disk — you cannot create scripts. Arguments are passed directly to the script (no shell interpolation).',
        parameters: {
          type: 'object',
          properties: {
            skill: {
              type: 'string',
              description: 'The skill name whose script to run.',
            },
            script: {
              type: 'string',
              description: 'Filename of the script in the scripts/ directory (e.g. "extract.py").',
            },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'Arguments to pass to the script.',
            },
          },
          required: ['skill', 'script'],
        },
        async execute(args, ctx) {
          refresh();
          const skillName = args.skill as string;
          const scriptName = args.script as string;
          const scriptArgs = (args.args as string[]) ?? [];
          const skill = skillMap.get(skillName);
          if (!skill) {
            return {
              toolCallId: '',
              content: `Skill "${skillName}" not found.`,
              isError: true,
            };
          }

          // Lock to scripts/ directory — no path traversal, no absolute paths,
          // no subdirectories. Just a flat filename.
          if (scriptName.includes('/') || scriptName.includes('..') || scriptName.includes('\\')) {
            return {
              toolCallId: '',
              content: 'Script name must be a flat filename in scripts/ (no paths).',
              isError: true,
            };
          }

          const scriptPath = join(skill.dir, 'scripts', scriptName);
          if (!existsSync(scriptPath) || !statSync(scriptPath).isFile()) {
            return {
              toolCallId: '',
              content: `Script not found: scripts/${scriptName}`,
              isError: true,
            };
          }

          // Interpreter is selected by extension — the agent has no say.
          const ext = extname(scriptName);
          const runners: Record<string, string[]> = {
            '.py': ['python3'],
            '.sh': ['bash'],
            '.js': ['node'],
            '.ts': ['npx', 'tsx'],
          };
          const runner = runners[ext];
          if (!runner) {
            return {
              toolCallId: '',
              content: `Unsupported script type: ${ext}. Supported: ${Object.keys(runners).join(', ')}`,
              isError: true,
            };
          }

          const cmd = [...runner, scriptPath, ...scriptArgs];

          return new Promise((resolve) => {
            execFile(cmd[0]!, cmd.slice(1), {
              cwd: skill.dir,
              timeout: 30_000,
              signal: ctx.signal,
              maxBuffer: 1024 * 1024,
            }, (error, stdout, stderr) => {
              if (error) {
                resolve({
                  toolCallId: '',
                  content: `Script failed (${error.name}): ${error.message}\n${stderr}`,
                  isError: true,
                });
              } else {
                const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
                resolve({
                  toolCallId: '',
                  content: output || '(script produced no output)',
                });
              }
            });
          });
        },
      });

      // Preloaded skills: append their content to the system prompt
      // once at install time. This is a one-time operation — the
      // content is part of the system prompt for every turn without
      // any per-turn injection overhead.
      if (preloadedContent.length > 0) {
        const combined = preloadedContent.join('\n\n---\n\n');
        agent.appendSystemPrompt(combined);
      }
    },
  };
}
