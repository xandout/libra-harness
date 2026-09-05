import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveThinkingConfig } from '../extras/libra-code/agent-setup.js';

describe('resolveThinkingConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LIBRA_THINKING_LEVEL;
    delete process.env.THINKING_LEVEL;
    delete process.env.LIBRA_REASONING_EFFORT;
    delete process.env.REASONING_EFFORT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns empty object when no thinking option or env var is set', () => {
    const config = resolveThinkingConfig();
    expect(config.thinkingLevel).toBeUndefined();
    expect(config.reasoningEffort).toBeUndefined();
    expect(config.providerOptions).toBeUndefined();
  });

  it('resolves disabled/off thinking level', () => {
    const config = resolveThinkingConfig('off');
    expect(config.thinkingLevel).toBe('off');
    expect(config.reasoningEffort).toBeUndefined();
    expect(config.providerOptions).toEqual({
      deepseek: {
        thinking: { type: 'disabled' },
      },
    });
  });

  it('resolves low thinking level', () => {
    const config = resolveThinkingConfig('low');
    expect(config.thinkingLevel).toBe('low');
    expect(config.reasoningEffort).toBe('low');
    expect(config.providerOptions).toEqual({
      deepseek: {
        thinking: { type: 'enabled' },
        reasoningEffort: 'low',
      },
    });
  });

  it('resolves medium thinking level', () => {
    const config = resolveThinkingConfig('medium');
    expect(config.thinkingLevel).toBe('medium');
    expect(config.reasoningEffort).toBe('high');
    expect(config.providerOptions).toEqual({
      deepseek: {
        thinking: { type: 'enabled' },
        reasoningEffort: 'medium',
      },
    });
  });

  it('resolves high thinking level', () => {
    const config = resolveThinkingConfig('high');
    expect(config.thinkingLevel).toBe('high');
    expect(config.reasoningEffort).toBe('high');
    expect(config.providerOptions).toEqual({
      deepseek: {
        thinking: { type: 'enabled' },
        reasoningEffort: 'high',
      },
    });
  });

  it('resolves max thinking level', () => {
    const config = resolveThinkingConfig('max');
    expect(config.thinkingLevel).toBe('max');
    expect(config.reasoningEffort).toBe('max');
    expect(config.providerOptions).toEqual({
      deepseek: {
        thinking: { type: 'enabled' },
        reasoningEffort: 'max',
      },
    });
  });

  it('respects LIBRA_THINKING_LEVEL env variable', () => {
    process.env.LIBRA_THINKING_LEVEL = 'max';
    const config = resolveThinkingConfig();
    expect(config.thinkingLevel).toBe('max');
    expect(config.reasoningEffort).toBe('max');
    expect(config.providerOptions?.deepseek).toEqual({
      thinking: { type: 'enabled' },
      reasoningEffort: 'max',
    });
  });
});
