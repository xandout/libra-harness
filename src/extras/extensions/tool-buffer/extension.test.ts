import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../../../agent.js';
import { createToolBufferExtension } from './index.js';

// ── Mock model ─────────────────────────────────────────────────────
function mockModel(responses: any[]) {
  let callCount = 0;
  return {
    async generate(req: any) {
      const resp = responses[Math.min(callCount, responses.length - 1)];
      callCount++;
      if (typeof resp.message === 'function') {
        return { ...resp, message: resp.message(req) };
      }
      return resp;
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────
function makeTool(name: string, resultContent: string) {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { toolCallId: '', content: resultContent };
    },
  };
}

// ── Test setup ─────────────────────────────────────────────────────
let tmpDir: string;
let bufferDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tool-buffer-test-'));
  bufferDir = join(tmpDir, 'buffers');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────

describe('tool-buffer extension', () => {
  it('passes through small results unchanged', async () => {
    const tool = makeTool('echo', 'hello world');
    const ext = createToolBufferExtension({ bufferDir, threshold: 100 });

    let toolResult = '';
    const model = mockModel([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'echo', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      {
        message: (req: any) => {
          const toolMsg = req.messages.find((m: any) => m.role === 'tool');
          toolResult = toolMsg?.content ?? '';
          return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
        },
      },
    ]);

    const agent = new Agent({ model: model as any, tools: [tool] });
    agent.use(ext);

    await agent.run({ message: 'call echo' });
    expect(toolResult).toBe('hello world');
  });

  it('buffers large results and returns a pointer', async () => {
    const bigContent = 'x'.repeat(5000);
    const tool = makeTool('list_jobs', bigContent);
    const ext = createToolBufferExtension({ bufferDir, threshold: 100 });

    let toolResult = '';
    const model = mockModel([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'list_jobs', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      {
        message: (req: any) => {
          const toolMsg = req.messages.find((m: any) => m.role === 'tool');
          toolResult = toolMsg?.content ?? '';
          return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
        },
      },
    ]);

    const agent = new Agent({ model: model as any, tools: [tool] });
    agent.use(ext);

    await agent.run({ message: 'call list_jobs' });

    // The LLM should see the pointer, not the full content.
    expect(toolResult).toContain('[tool-buffer]');
    expect(toolResult).toContain('Output saved to');
    // The pointer should not contain the full 5000 chars — only the preview.
    expect(toolResult.length).toBeLessThan(1000);
    expect(toolResult).toContain('grep');
    expect(toolResult).toContain('no_buffer');
  });

  it('writes the full content to a buffer file', async () => {
    const bigContent = 'line1\nline2\nline3\n' + 'x'.repeat(3000);
    const tool = makeTool('list_jobs', bigContent);
    const ext = createToolBufferExtension({ bufferDir, threshold: 100 });

    const model = mockModel([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'list_jobs', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' },
    ]);

    const agent = new Agent({ model: model as any, tools: [tool] });
    agent.use(ext);

    await agent.run({ message: 'call list_jobs' });

    // Find the buffer file.
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(bufferDir);
    expect(files).toHaveLength(1);
    const fileContent = readFileSync(join(bufferDir, files[0]), 'utf-8');
    expect(fileContent).toBe(bigContent);
  });

  it('includes a preview in the pointer message', async () => {
    const bigContent = 'PREVIEW_START_HERE\n' + 'x'.repeat(3000);
    const tool = makeTool('list_jobs', bigContent);
    const ext = createToolBufferExtension({ bufferDir, threshold: 100, previewLength: 50 });

    let toolResult = '';
    const model = mockModel([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'list_jobs', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      {
        message: (req: any) => {
          const toolMsg = req.messages.find((m: any) => m.role === 'tool');
          toolResult = toolMsg?.content ?? '';
          return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
        },
      },
    ]);

    const agent = new Agent({ model: model as any, tools: [tool] });
    agent.use(ext);

    await agent.run({ message: 'call list_jobs' });

    expect(toolResult).toContain('Preview');
    expect(toolResult).toContain('PREVIEW_START_HERE');
  });

  it('does not buffer error results', async () => {
    const bigError = 'x'.repeat(5000);
    const tool = {
      name: 'fail',
      description: 'Fails',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { toolCallId: '', content: bigError, isError: true };
      },
    };
    const ext = createToolBufferExtension({ bufferDir, threshold: 100 });

    let toolResult = '';
    const model = mockModel([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'fail', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      {
        message: (req: any) => {
          const toolMsg = req.messages.find((m: any) => m.role === 'tool');
          toolResult = toolMsg?.content ?? '';
          return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
        },
      },
    ]);

    const agent = new Agent({ model: model as any, tools: [tool] });
    agent.use(ext);

    await agent.run({ message: 'call fail' });

    // Error results should pass through unchanged.
    expect(toolResult).toBe(bigError);
    expect(existsSync(bufferDir)).toBe(true);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(bufferDir)).toHaveLength(0);
  });

  it('respects tool whitelist', async () => {
    const bigContent = 'x'.repeat(5000);
    const toolA = makeTool('tool_a', bigContent);
    const toolB = makeTool('tool_b', bigContent);
    const ext = createToolBufferExtension({
      bufferDir,
      threshold: 100,
      tools: ['tool_a'],
    });

    let resultB = '';
    const model = mockModel([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'tool_b', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      {
        message: (req: any) => {
          const toolMsg = req.messages.find((m: any) => m.role === 'tool');
          resultB = toolMsg?.content ?? '';
          return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
        },
      },
    ]);

    const agent = new Agent({ model: model as any, tools: [toolA, toolB] });
    agent.use(ext);

    await agent.run({ message: 'call tool_b' });

    // tool_b is not in the whitelist — should pass through.
    expect(resultB).toBe(bigContent);
  });

  it('respects tool blacklist', async () => {
    const bigContent = 'x'.repeat(5000);
    const tool = makeTool('never_buffer', bigContent);
    const ext = createToolBufferExtension({
      bufferDir,
      threshold: 100,
      excludeTools: ['never_buffer'],
    });

    let toolResult = '';
    const model = mockModel([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'never_buffer', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      {
        message: (req: any) => {
          const toolMsg = req.messages.find((m: any) => m.role === 'tool');
          toolResult = toolMsg?.content ?? '';
          return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
        },
      },
    ]);

    const agent = new Agent({ model: model as any, tools: [tool] });
    agent.use(ext);

    await agent.run({ message: 'call never_buffer' });

    expect(toolResult).toBe(bigContent);
  });

  it('reports line count and file size in the pointer', async () => {
    const bigContent = 'line1\nline2\nline3\n' + 'x'.repeat(3000);
    const tool = makeTool('list_jobs', bigContent);
    const ext = createToolBufferExtension({ bufferDir, threshold: 100 });

    let toolResult = '';
    const model = mockModel([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'list_jobs', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      {
        message: (req: any) => {
          const toolMsg = req.messages.find((m: any) => m.role === 'tool');
          toolResult = toolMsg?.content ?? '';
          return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
        },
      },
    ]);

    const agent = new Agent({ model: model as any, tools: [tool] });
    agent.use(ext);

    await agent.run({ message: 'call list_jobs' });

    expect(toolResult).toContain('4 lines');
    expect(toolResult).toContain('B');
  });

  it('creates the buffer directory if it does not exist', async () => {
    const nestedDir = join(bufferDir, 'nested', 'deeper');
    const bigContent = 'x'.repeat(5000);
    const tool = makeTool('list_jobs', bigContent);
    const ext = createToolBufferExtension({ bufferDir: nestedDir, threshold: 100 });

    const model = mockModel([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'list_jobs', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' },
    ]);

    const agent = new Agent({ model: model as any, tools: [tool] });
    agent.use(ext);

    await agent.run({ message: 'call list_jobs' });

    expect(existsSync(nestedDir)).toBe(true);
  });

  it('uses low priority so it sees the final result', () => {
    const ext = createToolBufferExtension({ bufferDir });
    expect(ext.priority).toBe(-50);
  });

  // ── no_buffer tool tests ──────────────────────────────────────────

  it('registers a no_buffer tool', async () => {
    const ext = createToolBufferExtension({ bufferDir });
    const agent = new Agent({ model: mockModel([{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }]) as any });
    agent.use(ext);

    const toolNames = agent.getTools();
    expect(toolNames).toContain('no_buffer');
  });

  it('no_buffer with scope:next skips buffering for the next tool only', async () => {
    const bigContent = 'x'.repeat(5000);
    const tool = makeTool('list_jobs', bigContent);
    const ext = createToolBufferExtension({ bufferDir, threshold: 100 });

    let results: string[] = [];
    const model = mockModel([
      // First: call no_buffer
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'no_buffer', arguments: '{"scope":"next"}' }],
        },
        finishReason: 'tool_calls',
      },
      // Second: call list_jobs (should NOT be buffered)
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc2', name: 'list_jobs', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      // Third: call list_jobs again (SHOULD be buffered — flag was one-shot)
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc3', name: 'list_jobs', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      // Fourth: final response
      {
        message: (req: any) => {
          const toolMsgs = req.messages.filter((m: any) => m.role === 'tool');
          results = toolMsgs.map((m: any) => m.content);
          return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
        },
      },
    ]);

    const agent = new Agent({ model: model as any, tools: [tool] });
    agent.use(ext);

    await agent.run({ message: 'call no_buffer then list_jobs twice' });

    // First list_jobs result (tc2) should be the full content (not buffered).
    // Second list_jobs result (tc3) should be the pointer (buffered).
    // results[0] is the no_buffer confirmation, results[1] is tc2, results[2] is tc3.
    expect(results[1]).toBe(bigContent);
    expect(results[2]).toContain('[tool-buffer]');
  });

  it('no_buffer with scope:turn skips buffering for all remaining tools', async () => {
    const bigContent = 'x'.repeat(5000);
    const tool = makeTool('list_jobs', bigContent);
    const ext = createToolBufferExtension({ bufferDir, threshold: 100 });

    let results: string[] = [];
    const model = mockModel([
      // First: call no_buffer with scope:turn
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'no_buffer', arguments: '{"scope":"turn"}' }],
        },
        finishReason: 'tool_calls',
      },
      // Second: call list_jobs (should NOT be buffered)
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc2', name: 'list_jobs', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      // Third: call list_jobs again (should also NOT be buffered)
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc3', name: 'list_jobs', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      // Fourth: final response
      {
        message: (req: any) => {
          const toolMsgs = req.messages.filter((m: any) => m.role === 'tool');
          results = toolMsgs.map((m: any) => m.content);
          return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
        },
      },
    ]);

    const agent = new Agent({ model: model as any, tools: [tool] });
    agent.use(ext);

    await agent.run({ message: 'call no_buffer turn then list_jobs twice' });

    // Both list_jobs results should be the full content (not buffered).
    expect(results[1]).toBe(bigContent);
    expect(results[2]).toBe(bigContent);
  });

  it('no_buffer defaults to scope:next', async () => {
    const bigContent = 'x'.repeat(5000);
    const tool = makeTool('list_jobs', bigContent);
    const ext = createToolBufferExtension({ bufferDir, threshold: 100 });

    let results: string[] = [];
    const model = mockModel([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'no_buffer', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc2', name: 'list_jobs', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      {
        message: (req: any) => {
          const toolMsgs = req.messages.filter((m: any) => m.role === 'tool');
          results = toolMsgs.map((m: any) => m.content);
          return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
        },
      },
    ]);

    const agent = new Agent({ model: model as any, tools: [tool] });
    agent.use(ext);

    await agent.run({ message: 'call no_buffer then list_jobs' });

    // no args → default scope:next → first list_jobs not buffered
    expect(results[1]).toBe(bigContent);
  });

  it('no_buffer does not persist across turns', async () => {
    const bigContent = 'x'.repeat(5000);
    const tool = makeTool('list_jobs', bigContent);
    const ext = createToolBufferExtension({ bufferDir, threshold: 100 });

    // Turn 1: call no_buffer with scope:turn, then list_jobs
    let result1 = '';
    const model1 = mockModel([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'no_buffer', arguments: '{"scope":"turn"}' }],
        },
        finishReason: 'tool_calls',
      },
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc2', name: 'list_jobs', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      {
        message: (req: any) => {
          const toolMsg = req.messages.find((m: any) => m.role === 'tool' && m.toolCallId === 'tc2');
          result1 = toolMsg?.content ?? '';
          return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
        },
      },
    ]);

    const agent = new Agent({ model: model1 as any, tools: [tool] });
    agent.use(ext);

    await agent.run({ message: 'turn 1' });
    expect(result1).toBe(bigContent); // not buffered — scope:turn was active

    // Turn 2: call list_jobs directly (should be buffered — flag doesn't persist)
    let result2 = '';
    const model2 = mockModel([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc3', name: 'list_jobs', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      {
        message: (req: any) => {
          const toolMsg = req.messages.find((m: any) => m.role === 'tool' && m.toolCallId === 'tc3');
          result2 = toolMsg?.content ?? '';
          return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
        },
      },
    ]);

    const agent2 = new Agent({ model: model2 as any, tools: [tool] });
    agent2.use(ext);

    await agent2.run({ message: 'turn 2' });
    expect(result2).toContain('[tool-buffer]'); // buffered — flag was per-turn
  });

  it('no_buffer tool itself is never buffered', async () => {
    const ext = createToolBufferExtension({ bufferDir, threshold: 1 });

    let noBufferResult = '';
    const model = mockModel([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'no_buffer', arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      },
      {
        message: (req: any) => {
          const toolMsg = req.messages.find((m: any) => m.role === 'tool');
          noBufferResult = toolMsg?.content ?? '';
          return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' };
        },
      },
    ]);

    const agent = new Agent({ model: model as any });
    agent.use(ext);

    await agent.run({ message: 'call no_buffer' });

    // The no_buffer result should be the plain confirmation, not a pointer.
    expect(noBufferResult).toContain('Buffering disabled');
    expect(noBufferResult).not.toContain('[tool-buffer]');
  });

  it('supports custom no_buffer tool name', async () => {
    const ext = createToolBufferExtension({ bufferDir, noBufferToolName: 'raw_output' });
    const agent = new Agent({ model: mockModel([{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }]) as any });
    agent.use(ext);

    expect(agent.getTools()).toContain('raw_output');
    expect(agent.getTools()).not.toContain('no_buffer');
  });
});
