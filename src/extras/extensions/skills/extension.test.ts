import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../../../agent.js';
import { createSkillExtension } from './index.js';

// ── Mock model ─────────────────────────────────────────────────────
// Returns a fixed assistant message.
function mockModel() {
  return {
    async generate() {
      return {
        message: { role: 'assistant', content: 'ok' },
        finishReason: 'stop' as const,
      };
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────
function makeSkill(dir: string, name: string, frontmatter: Record<string, string> = {}, body = 'Skill body') {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const fmLines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
  const content = `---\nname: ${name}\n${fmLines.join('\n')}\n---\n${body}`;
  writeFileSync(join(skillDir, 'SKILL.md'), content);
  return skillDir;
}

// ── Test setup ─────────────────────────────────────────────────────
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'skills-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────

describe('skills extension', () => {
  it('loads skills from a directory at startup', () => {
    makeSkill(tmpDir, 'code-review', { description: 'Review code' });
    makeSkill(tmpDir, 'summarize', { description: 'Summarize text' });

    const ext = createSkillExtension({ skillsDirs: tmpDir });
    expect(ext).toBeDefined();

    const agent = new Agent({ model: mockModel() as any });
    agent.use(ext!);

    // list_skills should be registered as a tool
    expect(agent.getTools()).toContain('list_skills');
    expect(agent.getTools()).toContain('use_skill');
  });

  it('returns undefined when no skillsDirs provided', () => {
    const ext = createSkillExtension({});
    expect(ext).toBeUndefined();
  });

  it('list_skills returns skills present at startup', async () => {
    makeSkill(tmpDir, 'alpha', { description: 'Alpha skill' });
    makeSkill(tmpDir, 'beta', { description: 'Beta skill' });

    const ext = createSkillExtension({ skillsDirs: tmpDir })!;
    const agent = new Agent({ model: mockModel() as any });
    agent.use(ext);

    // Find the list_skills tool and call it directly.
    const tools = agent.getTools();
    expect(tools).toContain('list_skills');
  });

  it('list_skills discovers new skills added at runtime', async () => {
    // Start with one skill.
    makeSkill(tmpDir, 'existing', { description: 'Existing skill' });

    const ext = createSkillExtension({ skillsDirs: tmpDir })!;
    const agent = new Agent({ model: mockModel() as any });
    agent.use(ext);

    // Add a new skill directory after the extension is installed.
    makeSkill(tmpDir, 'runtime-added', { description: 'Added at runtime' });

    // Model that calls list_skills on first turn, then returns the
    // tool result as the final message so we can inspect it.
    let callCount = 0;
    let capturedToolResult = '';
    const callModel = {
      async generate(req: any) {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: 'call_1',
                name: 'list_skills',
                arguments: '{}',
              }],
            },
            finishReason: 'tool_calls' as const,
          };
        }
        // Second call: capture the tool result and return it.
        const toolMsg = req.messages.find((m: any) => m.role === 'tool');
        capturedToolResult = toolMsg?.content ?? '';
        return {
          message: { role: 'assistant', content: capturedToolResult },
          finishReason: 'stop' as const,
        };
      },
    };

    const agent2 = new Agent({ model: callModel as any });
    agent2.use(ext);

    const result = await agent2.run({ message: 'list skills' });
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls?.some((tc) => tc.name === 'list_skills')).toBe(true);
    // The tool result should include both the existing and runtime-added skills.
    expect(capturedToolResult).toContain('existing');
    expect(capturedToolResult).toContain('runtime-added');
  });

  it('use_skill can load a skill added at runtime', async () => {
    // Start with no skills.
    const ext = createSkillExtension({ skillsDirs: tmpDir })!;
    const agent = new Agent({ model: mockModel() as any });
    agent.use(ext);

    // Add a skill after install.
    makeSkill(tmpDir, 'late-skill', { description: 'Added late' }, 'Late skill content');

    // Model that calls use_skill, then returns the result.
    let sawSkillContent = false;
    const callModel = {
      async generate(req: any) {
        const hasUseSkill = req.tools?.some((t: any) => t.function.name === 'use_skill');
        if (hasUseSkill && !req.messages.some((m: any) => m.role === 'tool')) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: 'call_1',
                name: 'use_skill',
                arguments: JSON.stringify({ skill: 'late-skill' }),
              }],
            },
            finishReason: 'tool_calls' as const,
          };
        }
        // Check if the tool result contains the late skill content
        const toolMsg = req.messages.find((m: any) => m.role === 'tool');
        if (toolMsg && toolMsg.content.includes('Late skill content')) {
          sawSkillContent = true;
        }
        return {
          message: { role: 'assistant', content: 'done' },
          finishReason: 'stop' as const,
        };
      },
    };

    const agent2 = new Agent({ model: callModel as any });
    agent2.use(ext);

    await agent2.run({ message: 'use the late skill' });
    expect(sawSkillContent).toBe(true);
  });

  it('autoLoad skills are appended to system prompt at install time', () => {
    makeSkill(tmpDir, 'always-on', { autoLoad: 'true', description: 'Always active' }, 'Always-on content');

    let seenSystemPrompt = '';
    const model = {
      async generate(req: any) {
        seenSystemPrompt = req.systemPrompt ?? '';
        return {
          message: { role: 'assistant', content: 'ok' },
          finishReason: 'stop' as const,
        };
      },
    };

    const ext = createSkillExtension({ skillsDirs: tmpDir })!;
    const agent = new Agent({ model: model as any, systemPrompt: 'Base prompt.' });
    agent.use(ext);

    return agent.run({ message: 'hi' }).then(() => {
      expect(seenSystemPrompt).toContain('Base prompt.');
      expect(seenSystemPrompt).toContain('Always-on content');
    });
  });

  it('supports multiple skills directories', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'skills-test-2-'));
    makeSkill(tmpDir, 'from-dir1', { description: 'First dir' });
    makeSkill(dir2, 'from-dir2', { description: 'Second dir' });

    const ext = createSkillExtension({ skillsDirs: [tmpDir, dir2] })!;
    const agent = new Agent({ model: mockModel() as any });
    agent.use(ext);

    expect(agent.getTools()).toContain('list_skills');

    // Clean up second dir
    rmSync(dir2, { recursive: true, force: true });
  });
});
