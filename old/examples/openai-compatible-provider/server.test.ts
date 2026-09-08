import { describe, expect, it } from 'vitest';
import { createOpenAICompatibleServer } from '@xandout/libra-harness/openai-provider';

describe('openai-provider package export', () => {
  it('exports createOpenAICompatibleServer', () => {
    expect(typeof createOpenAICompatibleServer).toBe('function');
  });
});
