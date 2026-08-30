import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
      expect(tools.size).toBe(3); // read, write, edit

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

  // ── write tool ─────────────────────────────────────────────────────
  describe('write tool', () => {
    it('creates a new file', async () => {
      const filePath = join(tmpDir, 'new.txt');
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const writeTool = tools.get('write');

      const result = await writeTool.execute(
        { file_path: filePath, content: 'hello world' },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('Wrote 11 chars');
      expect(readFileSync(filePath, 'utf-8')).toBe('hello world');
    });

    it('creates parent directories', async () => {
      const filePath = join(tmpDir, 'sub', 'dir', 'file.txt');
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const writeTool = tools.get('write');

      const result = await writeTool.execute(
        { file_path: filePath, content: 'nested' },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('Wrote');
      expect(readFileSync(filePath, 'utf-8')).toBe('nested');
    });

    it('overwrites an existing file after reading it', async () => {
      const filePath = join(tmpDir, 'existing.txt');
      writeFileSync(filePath, 'old content');
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const readTool = tools.get('read');
      const writeTool = tools.get('write');

      const metadata: Record<string, unknown> = {};
      // Read first
      await readTool.execute(
        { file_path: filePath },
        { signal: new AbortController().signal, metadata },
      );
      // Now overwrite
      const result = await writeTool.execute(
        { file_path: filePath, content: 'new content' },
        { signal: new AbortController().signal, metadata },
      );

      expect(result.content).toContain('Wrote');
      expect(readFileSync(filePath, 'utf-8')).toBe('new content');
    });

    it('refuses to overwrite without reading first', async () => {
      const filePath = join(tmpDir, 'protected.txt');
      writeFileSync(filePath, 'original');
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const writeTool = tools.get('write');

      const result = await writeTool.execute(
        { file_path: filePath, content: 'hacked' },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('must read');
      expect(readFileSync(filePath, 'utf-8')).toBe('original');
    });
  });

  // ── edit tool ──────────────────────────────────────────────────────
  describe('edit tool', () => {
    it('replaces a unique string', async () => {
      const filePath = join(tmpDir, 'edit.txt');
      writeFileSync(filePath, 'const x = 1;\nconst y = 2;\n');
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const readTool = tools.get('read');
      const editTool = tools.get('edit');

      const metadata: Record<string, unknown> = {};
      await readTool.execute(
        { file_path: filePath },
        { signal: new AbortController().signal, metadata },
      );

      const result = await editTool.execute(
        { file_path: filePath, old_string: 'const x = 1;', new_string: 'const x = 42;' },
        { signal: new AbortController().signal, metadata },
      );

      expect(result.content).toContain('Replaced 1 occurrence');
      expect(readFileSync(filePath, 'utf-8')).toBe('const x = 42;\nconst y = 2;\n');
    });

    it('fails if old_string not found', async () => {
      const filePath = join(tmpDir, 'no-match.txt');
      writeFileSync(filePath, 'hello world');
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const readTool = tools.get('read');
      const editTool = tools.get('edit');

      const metadata: Record<string, unknown> = {};
      await readTool.execute(
        { file_path: filePath },
        { signal: new AbortController().signal, metadata },
      );

      const result = await editTool.execute(
        { file_path: filePath, old_string: 'nonexistent', new_string: 'replacement' },
        { signal: new AbortController().signal, metadata },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('not found');
    });

    it('fails on non-unique match without replace_all', async () => {
      const filePath = join(tmpDir, 'dup.txt');
      writeFileSync(filePath, 'const x = 1;\nconst x = 1;\n');
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const readTool = tools.get('read');
      const editTool = tools.get('edit');

      const metadata: Record<string, unknown> = {};
      await readTool.execute(
        { file_path: filePath },
        { signal: new AbortController().signal, metadata },
      );

      const result = await editTool.execute(
        { file_path: filePath, old_string: 'const x = 1;', new_string: 'const x = 2;' },
        { signal: new AbortController().signal, metadata },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('2 times');
    });

    it('replaces all occurrences with replace_all', async () => {
      const filePath = join(tmpDir, 'all.txt');
      writeFileSync(filePath, 'foo bar foo bar foo');
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const readTool = tools.get('read');
      const editTool = tools.get('edit');

      const metadata: Record<string, unknown> = {};
      await readTool.execute(
        { file_path: filePath },
        { signal: new AbortController().signal, metadata },
      );

      const result = await editTool.execute(
        { file_path: filePath, old_string: 'foo', new_string: 'baz', replace_all: true },
        { signal: new AbortController().signal, metadata },
      );

      expect(result.content).toContain('Replaced 3 occurrences');
      expect(readFileSync(filePath, 'utf-8')).toBe('baz bar baz bar baz');
    });

    it('refuses to edit without reading first', async () => {
      const filePath = join(tmpDir, 'unread.txt');
      writeFileSync(filePath, 'original');
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const editTool = tools.get('edit');

      const result = await editTool.execute(
        { file_path: filePath, old_string: 'original', new_string: 'changed' },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('must read');
    });

    it('rejects identical old_string and new_string', async () => {
      const filePath = join(tmpDir, 'same.txt');
      writeFileSync(filePath, 'hello');
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const readTool = tools.get('read');
      const editTool = tools.get('edit');

      const metadata: Record<string, unknown> = {};
      await readTool.execute(
        { file_path: filePath },
        { signal: new AbortController().signal, metadata },
      );

      const result = await editTool.execute(
        { file_path: filePath, old_string: 'hello', new_string: 'hello' },
        { signal: new AbortController().signal, metadata },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('must differ');
    });
  });

  // ── Extension config ───────────────────────────────────────────────
  describe('configuration', () => {
    it('supports tool prefix', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension({ toolPrefix: 'code' }));

      const tools = (agent as any).tools as Map<string, any>;
      expect(tools.get('code_read')).toBeDefined();
      expect(tools.get('code_write')).toBeDefined();
      expect(tools.get('code_edit')).toBeDefined();
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
