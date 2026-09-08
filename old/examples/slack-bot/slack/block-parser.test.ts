import { describe, it, expect } from 'vitest';
import { parseSlackBlocks } from './block-parser.js';

describe('parseSlackBlocks', () => {
  it('returns no blocks when there are no fences', () => {
    const { text, blocks } = parseSlackBlocks('Hello world');
    expect(text).toBe('Hello world');
    expect(blocks).toHaveLength(0);
  });

  it('extracts valid Block Kit JSON from a fence', () => {
    const input = [
      'Here is the status:',
      '',
      '```slack_blocks',
      JSON.stringify([
        { type: 'section', text: { type: 'mrkdwn', text: '*Job Status*' } },
        { type: 'divider' },
      ]),
      '```',
    ].join('\n');

    const { text, blocks } = parseSlackBlocks(input);

    expect(blocks).toHaveLength(2);
    expect((blocks[0] as any).type).toBe('section');
    expect((blocks[1] as any).type).toBe('divider');
    expect(text).toBe('Here is the status:');
  });

  it('extracts blocks from a table-like layout', () => {
    const input = [
      '```slack_blocks',
      JSON.stringify([
        { type: 'section', fields: [
          { type: 'mrkdwn', text: '*Job:*\nKitchen Remodel' },
          { type: 'mrkdwn', text: '*Status:*\nIn Progress' },
        ]},
        { type: 'section', fields: [
          { type: 'mrkdwn', text: '*Job:*\nBathroom Reno' },
          { type: 'mrkdwn', text: '*Status:*\nComplete' },
        ]},
      ]),
      '```',
    ].join('\n');

    const { text, blocks } = parseSlackBlocks(input);

    expect(blocks).toHaveLength(2);
    expect((blocks[0] as any).fields).toHaveLength(2);
    expect((blocks[1] as any).fields).toHaveLength(2);
    expect(text).toBe('');
  });

  it('handles multiple fences in one response', () => {
    const input = [
      'First table:',
      '```slack_blocks',
      JSON.stringify([{ type: 'section', text: { type: 'mrkdwn', text: 'A' } }]),
      '```',
      'Second table:',
      '```slack_blocks',
      JSON.stringify([{ type: 'section', text: { type: 'mrkdwn', text: 'B' } }]),
      '```',
    ].join('\n');

    const { text, blocks } = parseSlackBlocks(input);

    expect(blocks).toHaveLength(2);
    expect((blocks[0] as any).text.text).toBe('A');
    expect((blocks[1] as any).text.text).toBe('B');
    expect(text).toContain('First table:');
    expect(text).toContain('Second table:');
  });

  it('silently skips invalid JSON', () => {
    const input = [
      '```slack_blocks',
      'not valid json {{{',
      '```',
      'Normal text',
    ].join('\n');

    const { text, blocks } = parseSlackBlocks(input);

    expect(blocks).toHaveLength(0);
    // The fence is still removed from the text.
    expect(text).not.toContain('slack_blocks');
    expect(text).toContain('Normal text');
  });

  it('skips blocks that are not objects with type fields', () => {
    const input = [
      '```slack_blocks',
      JSON.stringify([
        { type: 'section', text: { type: 'mrkdwn', text: 'OK' } },
        'not a block',
        { noType: true },
        null,
        42,
      ]),
      '```',
    ].join('\n');

    const { blocks } = parseSlackBlocks(input);

    // Only the valid block passes.
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as any).type).toBe('section');
  });

  it('skips when the JSON is not an array', () => {
    const input = [
      '```slack_blocks',
      JSON.stringify({ type: 'section', text: { type: 'mrkdwn', text: 'oops' } }),
      '```',
    ].join('\n');

    const { blocks } = parseSlackBlocks(input);
    expect(blocks).toHaveLength(0);
  });

  it('removes the fence from text even when blocks are invalid', () => {
    const input = [
      'Before',
      '```slack_blocks',
      'garbage',
      '```',
      'After',
    ].join('\n');

    const { text } = parseSlackBlocks(input);
    expect(text).not.toContain('slack_blocks');
    expect(text).not.toContain('garbage');
    expect(text).toContain('Before');
    expect(text).toContain('After');
  });

  it('handles empty fence content', () => {
    const input = [
      'Text',
      '```slack_blocks',
      '',
      '```',
    ].join('\n');

    const { text, blocks } = parseSlackBlocks(input);
    expect(blocks).toHaveLength(0);
    expect(text).toBe('Text');
  });

  it('preserves text that comes after blocks', () => {
    const input = [
      '```slack_blocks',
      JSON.stringify([{ type: 'divider' }]),
      '```',
      'Let me know if you need more details.',
    ].join('\n');

    const { text } = parseSlackBlocks(input);
    expect(text).toBe('Let me know if you need more details.');
  });
});
