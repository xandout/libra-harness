import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '@xandout/libra-harness';
import createCodeToolsExtension from './extension.js';

// ── Mock model that echoes the last user message ─────────────────────
function mockModel() {
  return {
    async generate() {
      return {
        message: { role: 'assistant' as const, content: 'ok' },
        finishReason: 'stop' as const,
      };
    },
  };
}

describe('code-tools extension', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'code-tools-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── read tool ──────────────────────────────────────────────────────
  describe('read tool', () => {
    it('reads a text file with line numbers', async () => {
      const filePath = join(tmpDir, 'test.txt');
      writeFileSync(filePath, 'line one\nline two\nline three');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      // Access the tool directly via the agent's tool registry.
      const tools = (agent as any).tools as Map<string, any>;
      expect(tools).toBeDefined();
      expect(tools.size).toBe(1);

      const readTool = tools.get('read');
      expect(readTool).toBeDefined();
      expect(readTool.name).toBe('read');

      const result = await readTool.execute(
        { file_path: filePath },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('test.txt');
      expect(result.content).toContain('line one');
      expect(result.content).toContain('line two');
      expect(result.content).toContain('line three');
      // Line numbers should be present
      expect(result.content).toMatch(/1\tline one/);
      expect(result.content).toMatch(/2\tline two/);
      expect(result.content).toMatch(/3\tline three/);
    });

    it('returns error for non-existent file', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const readTool = tools.get('read');

      const result = await readTool.execute(
        { file_path: join(tmpDir, 'nope.txt') },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('File not found');
    });

    it('returns error for directory path', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const readTool = tools.get('read');

      const result = await readTool.execute(
        { file_path: tmpDir },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('directory');
    });

    it('respects offset and limit', async () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
      const filePath = join(tmpDir, 'big.txt');
      writeFileSync(filePath, lines.join('\n'));

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const readTool = tools.get('read');

      const result = await readTool.execute(
        { file_path: filePath, offset: 10, limit: 5 },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('line 10');
      expect(result.content).toContain('line 14');
      expect(result.content).not.toContain('line 9');
      expect(result.content).not.toContain('line 15');
      expect(result.content).toContain('showing lines 10-14');
    });

    it('returns base64 for binary files', async () => {
      const filePath = join(tmpDir, 'data.bin');
      writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const readTool = tools.get('read');

      const result = await readTool.execute(
        { file_path: filePath },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('binary');
      expect(result.content).toContain('base64:');
    });

    it('returns data URL for image files', async () => {
      const filePath = join(tmpDir, 'pic.png');
      writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const readTool = tools.get('read');

      const result = await readTool.execute(
        { file_path: filePath },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('image/png');
      expect(result.content).toContain('data:image/png;base64,');
    });

    it('tracks read paths in metadata for edit/write enforcement', async () => {
      const filePath = join(tmpDir, 'test.txt');
      writeFileSync(filePath, 'hello');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const readTool = tools.get('read');

      const metadata: Record<string, unknown> = {};
      await readTool.execute(
        { file_path: filePath },
        { signal: new AbortController().signal, metadata },
      );

      const readSet = metadata.__codeToolsReadPaths as Set<string>;
      expect(readSet).toBeDefined();
      expect(readSet.has(filePath)).toBe(true);
    });
  });

  // ── Extension config ───────────────────────────────────────────────
  describe('configuration', () => {
    it('supports tool prefix', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension({ toolPrefix: 'code' }));

      const tools = (agent as any).tools as Map<string, any>;
      expect(tools.get('code_read')).toBeDefined();
    });

    it('respects maxReadSize', async () => {
      const filePath = join(tmpDir, 'big.txt');
      writeFileSync(filePath, 'x'.repeat(2048));

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension({ maxReadSize: 100 }));

      const tools = (agent as any).tools as Map<string, any>;
      const readTool = tools.get('read');

      const result = await readTool.execute(
        { file_path: filePath },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('too large');
    });
  });
});
