import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildSystemPrompt,
  loadInstructionFile,
  resolveThinkingConfig,
  sessionKeyForCwd,
  resolveSkillsDirs,
  SYSTEM_PROMPT,
} from './agent-setup.js';

describe('libra-code agent-setup', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-setup-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.LIBRA_EXTRA_SYSTEM;
    delete process.env.LIBRA_THINKING_LEVEL;
    delete process.env.LIBRA_SKILLS_DIR;
  });

  describe('buildSystemPrompt', () => {
    it('returns default system prompt when no custom instructions exist', () => {
      const prompt = buildSystemPrompt(tmpDir);
      expect(prompt).toContain('You are a direct, practical coding agent.');
      expect(prompt).toContain('Be fast, pragmatic, and action-oriented.');
    });

    it('injects project-level AGENTS.md instructions', () => {
      writeFileSync(join(tmpDir, 'AGENTS.md'), '# Project Instructions\nAlways write tests.');
      const prompt = buildSystemPrompt(tmpDir);
      expect(prompt).toContain('PROJECT INSTRUCTIONS (AGENTS.md)');
      expect(prompt).toContain('Always write tests.');
    });

    it('injects project-level SYSTEM.md over AGENTS.md', () => {
      writeFileSync(join(tmpDir, 'SYSTEM.md'), '# System Rules\nRule 1');
      writeFileSync(join(tmpDir, 'AGENTS.md'), '# Agents Rules\nRule 2');
      const prompt = buildSystemPrompt(tmpDir);
      expect(prompt).toContain('PROJECT INSTRUCTIONS (SYSTEM.md)');
      expect(prompt).toContain('Rule 1');
      expect(prompt).not.toContain('Rule 2');
    });

    it('injects LIBRA_EXTRA_SYSTEM when set in environment', () => {
      process.env.LIBRA_EXTRA_SYSTEM = 'Extra system context from environment';
      const prompt = buildSystemPrompt(tmpDir);
      expect(prompt).toContain('Extra system context from environment');
    });
  });

  describe('loadInstructionFile', () => {
    it('loads .libra/AGENTS.md when root files do not exist', () => {
      const libraDir = join(tmpDir, '.libra');
      mkdirSync(libraDir);
      writeFileSync(join(libraDir, 'AGENTS.md'), 'Hidden agents instructions');

      const file = loadInstructionFile(tmpDir);
      expect(file).toBeDefined();
      expect(file?.filename).toBe(join('.libra', 'AGENTS.md'));
      expect(file?.content).toBe('Hidden agents instructions');
    });

    it('returns undefined if no instruction files are found', () => {
      const file = loadInstructionFile(tmpDir);
      expect(file).toBeUndefined();
    });
  });

  describe('resolveThinkingConfig', () => {
    it('handles off and disabled', () => {
      const config = resolveThinkingConfig('off');
      expect(config.thinkingLevel).toBe('off');
      expect(config.providerOptions?.deepseek?.thinking).toEqual({ type: 'disabled' });
    });

    it('handles low', () => {
      const config = resolveThinkingConfig('low');
      expect(config.thinkingLevel).toBe('low');
      expect(config.reasoningEffort).toBe('low');
      expect(config.providerOptions?.deepseek?.thinking).toEqual({ type: 'enabled' });
      expect(config.providerOptions?.deepseek?.reasoningEffort).toBe('low');
    });

    it('handles medium', () => {
      const config = resolveThinkingConfig('medium');
      expect(config.thinkingLevel).toBe('medium');
      expect(config.reasoningEffort).toBe('high');
      expect(config.providerOptions?.deepseek?.reasoningEffort).toBe('medium');
    });

    it('handles high and on', () => {
      const config = resolveThinkingConfig('high');
      expect(config.thinkingLevel).toBe('high');
      expect(config.reasoningEffort).toBe('high');
      expect(config.providerOptions?.deepseek?.reasoningEffort).toBe('high');
    });

    it('handles max', () => {
      const config = resolveThinkingConfig('max');
      expect(config.thinkingLevel).toBe('max');
      expect(config.reasoningEffort).toBe('max');
      expect(config.providerOptions?.deepseek?.reasoningEffort).toBe('max');
    });

    it('reads from environment when argument is undefined', () => {
      process.env.LIBRA_THINKING_LEVEL = 'low';
      const config = resolveThinkingConfig();
      expect(config.thinkingLevel).toBe('low');
      expect(config.reasoningEffort).toBe('low');
    });
  });

  describe('sessionKeyForCwd', () => {
    it('replaces non-alphanumeric characters with underscore', () => {
      const key = sessionKeyForCwd('/Users/test/my-project_1');
      expect(key).toBe('cwd__Users_test_my_project_1');
    });
  });

  describe('resolveSkillsDirs', () => {
    it('discovers custom skills dirs from LIBRA_SKILLS_DIR', () => {
      const customSkills = join(tmpDir, 'custom-skills');
      mkdirSync(customSkills);
      process.env.LIBRA_SKILLS_DIR = customSkills;

      const dirs = resolveSkillsDirs(tmpDir);
      expect(dirs).toContain(customSkills);
    });
  });
});
