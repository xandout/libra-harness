import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadInstructionFile,
  loadAgentsMd,
  buildSystemPrompt,
  resolveSkillsDirs,
  SYSTEM_PROMPT,
} from '../packages/libra-code/agent-setup.js';

describe('agent instructions & skills setup', () => {
  let tmpProjectDir: string;
  let tmpLibraHome: string;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    tmpProjectDir = mkdtempSync(join(tmpdir(), 'lc-project-test-'));
    tmpLibraHome = mkdtempSync(join(tmpdir(), 'lc-home-test-'));
    process.env.LIBRA_HOME = tmpLibraHome;
    delete process.env.LIBRA_EXTRA_SYSTEM;
    delete process.env.LIBRA_SKILLS_DIR;
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(tmpProjectDir, { recursive: true, force: true });
    rmSync(tmpLibraHome, { recursive: true, force: true });
  });

  describe('loadInstructionFile & loadAgentsMd', () => {
    it('returns undefined when no instruction file exists', () => {
      expect(loadInstructionFile(tmpProjectDir)).toBeUndefined();
      expect(loadAgentsMd(tmpProjectDir)).toBeUndefined();
    });

    it('loads SYSTEM.md when present', () => {
      writeFileSync(join(tmpProjectDir, 'SYSTEM.md'), 'Follow these custom system rules.');
      const result = loadInstructionFile(tmpProjectDir);
      expect(result).toBeDefined();
      expect(result?.filename).toBe('SYSTEM.md');
      expect(result?.content).toBe('Follow these custom system rules.');
      expect(loadAgentsMd(tmpProjectDir)).toBe('Follow these custom system rules.');
    });

    it('loads AGENTS.md when present', () => {
      writeFileSync(join(tmpProjectDir, 'AGENTS.md'), 'Agent instructions from AGENTS.md');
      const result = loadInstructionFile(tmpProjectDir);
      expect(result).toBeDefined();
      expect(result?.filename).toBe('AGENTS.md');
      expect(result?.content).toBe('Agent instructions from AGENTS.md');
      expect(loadAgentsMd(tmpProjectDir)).toBe('Agent instructions from AGENTS.md');
    });

    it('prioritizes SYSTEM.md over AGENTS.md when both exist', () => {
      writeFileSync(join(tmpProjectDir, 'AGENTS.md'), 'Lower precedence agents doc');
      writeFileSync(join(tmpProjectDir, 'SYSTEM.md'), 'Higher precedence system doc');
      const result = loadInstructionFile(tmpProjectDir);
      expect(result?.filename).toBe('SYSTEM.md');
      expect(result?.content).toBe('Higher precedence system doc');
    });

    it('loads .libra/SYSTEM.md when root files are absent', () => {
      mkdirSync(join(tmpProjectDir, '.libra'), { recursive: true });
      writeFileSync(join(tmpProjectDir, '.libra', 'SYSTEM.md'), 'Nested system doc');
      const result = loadInstructionFile(tmpProjectDir);
      expect(result?.filename).toBe(join('.libra', 'SYSTEM.md'));
      expect(result?.content).toBe('Nested system doc');
    });
  });

  describe('buildSystemPrompt', () => {
    it('returns default SYSTEM_PROMPT when no user or project instructions exist', () => {
      const prompt = buildSystemPrompt(tmpProjectDir);
      expect(prompt).toContain(SYSTEM_PROMPT);
      expect(prompt).not.toContain('USER INSTRUCTIONS');
      expect(prompt).not.toContain('PROJECT INSTRUCTIONS');
    });

    it('layers user instructions from LIBRA_HOME and project instructions from projectDir', () => {
      writeFileSync(join(tmpLibraHome, 'SYSTEM.md'), 'Global user preferences: speak concisely.');
      writeFileSync(join(tmpProjectDir, 'SYSTEM.md'), 'Project rules: use TypeScript strict mode.');

      const prompt = buildSystemPrompt(tmpProjectDir);
      expect(prompt).toContain(SYSTEM_PROMPT);
      expect(prompt).toContain('USER INSTRUCTIONS (SYSTEM.md)');
      expect(prompt).toContain('Global user preferences: speak concisely.');
      expect(prompt).toContain('PROJECT INSTRUCTIONS (SYSTEM.md)');
      expect(prompt).toContain('Project rules: use TypeScript strict mode.');

      // Check ordering: User instructions appear before project instructions
      const userIdx = prompt.indexOf('USER INSTRUCTIONS');
      const projIdx = prompt.indexOf('PROJECT INSTRUCTIONS');
      expect(userIdx).toBeLessThan(projIdx);
    });

    it('appends LIBRA_EXTRA_SYSTEM from environment when present', () => {
      process.env.LIBRA_EXTRA_SYSTEM = 'Extra runtime instructions for task XYZ';
      const prompt = buildSystemPrompt(tmpProjectDir);
      expect(prompt).toContain('Extra runtime instructions for task XYZ');
    });
  });

  describe('resolveSkillsDirs', () => {
    it('returns candidate skills directories', () => {
      const dirs = resolveSkillsDirs(tmpProjectDir);
      expect(dirs).toContain(join(tmpProjectDir, 'skills'));
      expect(dirs).toContain(join(tmpLibraHome, 'skills'));
    });

    it('includes directories from LIBRA_SKILLS_DIR env variable', () => {
      const customSkills = join(tmpProjectDir, 'custom-skills');
      mkdirSync(customSkills, { recursive: true });
      process.env.LIBRA_SKILLS_DIR = customSkills;

      const dirs = resolveSkillsDirs(tmpProjectDir);
      expect(dirs).toContain(customSkills);
    });
  });
});
