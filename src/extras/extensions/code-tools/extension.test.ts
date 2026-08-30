import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
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
      expect(tools.size).toBe(10); // read, write, edit, find_file_by_name, grep, exec, get_output, kill_shell, write_to_process, todo_write

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
      expect(tools.get('code_exec')).toBeDefined();
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

  // ── find_file_by_name tool ─────────────────────────────────────────
  describe('find_file_by_name tool', () => {
    it('finds files by glob pattern', async () => {
      writeFileSync(join(tmpDir, 'a.ts'), '');
      writeFileSync(join(tmpDir, 'b.ts'), '');
      writeFileSync(join(tmpDir, 'c.js'), '');
      mkdirSync(join(tmpDir, 'sub'));
      writeFileSync(join(tmpDir, 'sub', 'd.ts'), '');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const findTool = tools.get('find_file_by_name');

      const result = await findTool.execute(
        { pattern: '*.ts', path: tmpDir },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('a.ts');
      expect(result.content).toContain('b.ts');
      expect(result.content).not.toContain('c.js');
      // *.ts should not match in subdirectories
      expect(result.content).not.toContain('d.ts');
    });

    it('finds files recursively with **', async () => {
      writeFileSync(join(tmpDir, 'top.py'), '');
      mkdirSync(join(tmpDir, 'deep', 'nested'), { recursive: true });
      writeFileSync(join(tmpDir, 'deep', 'nested', 'bottom.py'), '');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const findTool = tools.get('find_file_by_name');

      const result = await findTool.execute(
        { pattern: '**/*.py', path: tmpDir },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('top.py');
      expect(result.content).toContain('bottom.py');
    });

    it('supports brace expansion', async () => {
      writeFileSync(join(tmpDir, 'a.ts'), '');
      writeFileSync(join(tmpDir, 'a.tsx'), '');
      writeFileSync(join(tmpDir, 'a.js'), '');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const findTool = tools.get('find_file_by_name');

      const result = await findTool.execute(
        { pattern: '*.{ts,tsx}', path: tmpDir },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('a.ts');
      expect(result.content).toContain('a.tsx');
      expect(result.content).not.toContain('a.js');
    });

    it('returns message when no files match', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const findTool = tools.get('find_file_by_name');

      const result = await findTool.execute(
        { pattern: '*.nonexistent', path: tmpDir },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('No files matching');
    });

    it('skips node_modules and .git', async () => {
      mkdirSync(join(tmpDir, 'node_modules'));
      writeFileSync(join(tmpDir, 'node_modules', 'dep.ts'), '');
      mkdirSync(join(tmpDir, '.git'));
      writeFileSync(join(tmpDir, '.git', 'config.ts'), '');
      writeFileSync(join(tmpDir, 'real.ts'), '');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const findTool = tools.get('find_file_by_name');

      const result = await findTool.execute(
        { pattern: '**/*.ts', path: tmpDir },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('real.ts');
      expect(result.content).not.toContain('dep.ts');
      expect(result.content).not.toContain('config.ts');
    });
  });

  // ── grep tool ──────────────────────────────────────────────────────
  describe('grep tool', () => {
    it('finds matching lines in content mode', async () => {
      writeFileSync(join(tmpDir, 'code.ts'), 'const x = 1;\nconst y = 2;\nconst x = 3;');
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const grepTool = tools.get('grep');

      const result = await grepTool.execute(
        { pattern: 'const x', path: tmpDir },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('code.ts:1:');
      expect(result.content).toContain('code.ts:3:');
      expect(result.content).toContain('2 matches');
    });

    it('supports files_with_matches mode', async () => {
      writeFileSync(join(tmpDir, 'a.txt'), 'hello world');
      writeFileSync(join(tmpDir, 'b.txt'), 'hello there');
      writeFileSync(join(tmpDir, 'c.txt'), 'no match here');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const grepTool = tools.get('grep');

      const result = await grepTool.execute(
        { pattern: 'hello', path: tmpDir, output_mode: 'files_with_matches' },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('a.txt');
      expect(result.content).toContain('b.txt');
      expect(result.content).not.toContain('c.txt');
    });

    it('supports count mode', async () => {
      writeFileSync(join(tmpDir, 'a.txt'), 'foo\nfoo\nbar');
      writeFileSync(join(tmpDir, 'b.txt'), 'foo\nbar');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const grepTool = tools.get('grep');

      const result = await grepTool.execute(
        { pattern: 'foo', path: tmpDir, output_mode: 'count' },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('a.txt:2');
      expect(result.content).toContain('b.txt:1');
      expect(result.content).toContain('Total: 3');
    });

    it('supports case_insensitive', async () => {
      writeFileSync(join(tmpDir, 'mix.txt'), 'Hello\nHELLO\nworld');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const grepTool = tools.get('grep');

      const result = await grepTool.execute(
        { pattern: 'hello', path: tmpDir, case_insensitive: true },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('mix.txt:1:');
      expect(result.content).toContain('mix.txt:2:');
    });

    it('supports context_lines', async () => {
      writeFileSync(join(tmpDir, 'ctx.txt'), 'line1\nline2\nMATCH\nline4\nline5');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const grepTool = tools.get('grep');

      const result = await grepTool.execute(
        { pattern: 'MATCH', path: tmpDir, context_lines: 1 },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('ctx.txt:2:');
      expect(result.content).toContain('ctx.txt:3:');
      expect(result.content).toContain('ctx.txt:4:');
      expect(result.content).toContain('>'); // marker for matching line
    });

    it('supports glob_pattern filter', async () => {
      writeFileSync(join(tmpDir, 'a.ts'), 'target');
      writeFileSync(join(tmpDir, 'b.js'), 'target');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const grepTool = tools.get('grep');

      const result = await grepTool.execute(
        { pattern: 'target', path: tmpDir, glob_pattern: '*.ts' },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('a.ts');
      expect(result.content).not.toContain('b.js');
    });

    it('returns message when no matches', async () => {
      writeFileSync(join(tmpDir, 'empty.txt'), 'nothing here');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const grepTool = tools.get('grep');

      const result = await grepTool.execute(
        { pattern: 'nonexistent', path: tmpDir },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('No matches');
    });

    it('skips node_modules', async () => {
      mkdirSync(join(tmpDir, 'node_modules'));
      writeFileSync(join(tmpDir, 'node_modules', 'dep.ts'), 'secret');
      writeFileSync(join(tmpDir, 'main.ts'), 'secret');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const grepTool = tools.get('grep');

      const result = await grepTool.execute(
        { pattern: 'secret', path: tmpDir },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('main.ts');
      expect(result.content).not.toContain('dep.ts');
    });
  });

  // ── exec tool ──────────────────────────────────────────────────────
  describe('exec tool', () => {
    it('runs a command and returns output', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const execTool = tools.get('exec');

      const result = await execTool.execute(
        { command: 'echo hello world' },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('Exit code: 0');
      expect(result.content).toContain('hello world');
    });

    it('returns exit code for failing commands', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const execTool = tools.get('exec');

      const result = await execTool.execute(
        { command: 'exit 42' },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('Exit code: 42');
    });

    it('captures stderr', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const execTool = tools.get('exec');

      const result = await execTool.execute(
        { command: 'echo "err msg" >&2' },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('err msg');
    });

    it('backgrounds on timeout and returns shell_id', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const execTool = tools.get('exec');

      const result = await execTool.execute(
        { command: 'sleep 10', timeout: 200 },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('Detached');
      expect(result.content).toContain('shell_');
    });

    it('backgrounds immediately with timeout 0', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const execTool = tools.get('exec');

      const result = await execTool.execute(
        { command: 'echo hi', timeout: 0 },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('Backgrounded');
      expect(result.content).toContain('shell_');
    });
  });

  // ── get_output tool ────────────────────────────────────────────────
  describe('get_output tool', () => {
    it('reads output from a backgrounded shell', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const execTool = tools.get('exec');
      const getOutputTool = tools.get('get_output');

      const metadata: Record<string, unknown> = {};
      const execResult = await execTool.execute(
        { command: 'echo background output', timeout: 0 },
        { signal: new AbortController().signal, metadata },
      );

      const shellId = execResult.content.match(/shell_\d+/)?.[0];
      expect(shellId).toBeDefined();

      // Wait for output to accumulate.
      await new Promise((r) => setTimeout(r, 200));

      const result = await getOutputTool.execute(
        { shell_id: shellId! },
        { signal: new AbortController().signal, metadata },
      );

      expect(result.content).toContain('background output');
    });

    it('reports process exited', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const execTool = tools.get('exec');
      const getOutputTool = tools.get('get_output');

      const metadata: Record<string, unknown> = {};
      const execResult = await execTool.execute(
        { command: 'echo done', timeout: 0 },
        { signal: new AbortController().signal, metadata },
      );

      const shellId = execResult.content.match(/shell_\d+/)?.[0]!;
      // Wait for process to finish.
      await new Promise((r) => setTimeout(r, 300));

      const result = await getOutputTool.execute(
        { shell_id: shellId },
        { signal: new AbortController().signal, metadata },
      );

      expect(result.content).toContain('Process exited');
      expect(result.content).toContain('code: 0');
    });

    it('errors for unknown shell_id', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const getOutputTool = tools.get('get_output');

      const result = await getOutputTool.execute(
        { shell_id: 'shell_999' },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('no shell');
    });
  });

  // ── kill_shell tool ────────────────────────────────────────────────
  describe('kill_shell tool', () => {
    it('kills a backgrounded shell', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const execTool = tools.get('exec');
      const killTool = tools.get('kill_shell');

      const metadata: Record<string, unknown> = {};
      const execResult = await execTool.execute(
        { command: 'sleep 30', timeout: 0 },
        { signal: new AbortController().signal, metadata },
      );

      const shellId = execResult.content.match(/shell_\d+/)?.[0]!;

      const result = await killTool.execute(
        { shell_id: shellId },
        { signal: new AbortController().signal, metadata },
      );

      expect(result.content).toContain('Killed');
      // Verify the shell is gone — get_output should report no shell.
      const getResult = await tools.get('get_output').execute(
        { shell_id: shellId },
        { signal: new AbortController().signal, metadata },
      );
      expect(getResult.content).toContain('no shell');
    });

    it('errors for unknown shell_id', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const killTool = tools.get('kill_shell');

      const result = await killTool.execute(
        { shell_id: 'shell_999' },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('no shell');
    });
  });

  // ── write_to_process tool ──────────────────────────────────────────
  describe('write_to_process tool', () => {
    it('writes to stdin of a backgrounded shell', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const execTool = tools.get('exec');
      const writeTool = tools.get('write_to_process');
      const getOutputTool = tools.get('get_output');

      const metadata: Record<string, unknown> = {};
      // Start cat (reads stdin, echoes to stdout)
      const execResult = await execTool.execute(
        { command: 'cat', timeout: 0 },
        { signal: new AbortController().signal, metadata },
      );

      const shellId = execResult.content.match(/shell_\d+/)?.[0]!;

      const writeResult = await writeTool.execute(
        { shell_id: shellId, input: 'hello from stdin\n' },
        { signal: new AbortController().signal, metadata },
      );

      expect(writeResult.content).toContain('Wrote');

      // Wait for cat to echo.
      await new Promise((r) => setTimeout(r, 200));

      const outputResult = await getOutputTool.execute(
        { shell_id: shellId },
        { signal: new AbortController().signal, metadata },
      );

      expect(outputResult.content).toContain('hello from stdin');
    });

    it('errors for unknown shell_id', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const writeTool = tools.get('write_to_process');

      const result = await writeTool.execute(
        { shell_id: 'shell_999', input: 'test' },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('no shell');
    });

    it('errors for exited process', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const execTool = tools.get('exec');
      const writeTool = tools.get('write_to_process');

      const metadata: Record<string, unknown> = {};
      const execResult = await execTool.execute(
        { command: 'echo quick', timeout: 0 },
        { signal: new AbortController().signal, metadata },
      );

      const shellId = execResult.content.match(/shell_\d+/)?.[0]!;
      // Wait for process to exit.
      await new Promise((r) => setTimeout(r, 300));

      const result = await writeTool.execute(
        { shell_id: shellId, input: 'test' },
        { signal: new AbortController().signal, metadata },
      );

      expect(result.content).toContain('already exited');
    });
  });

  // ── todo_write tool ────────────────────────────────────────────────
  describe('todo_write tool', () => {
    it('creates a todo list', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const todoTool = tools.get('todo_write');

      const result = await todoTool.execute(
        { todos: [
          { content: 'Read the file', status: 'completed' },
          { content: 'Edit the file', status: 'in_progress' },
          { content: 'Run tests', status: 'pending' },
        ]},
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('[x] Read the file');
      expect(result.content).toContain('[~] Edit the file');
      expect(result.content).toContain('[ ] Run tests');
    });

    it('replaces the list on each call', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const todoTool = tools.get('todo_write');

      await todoTool.execute(
        { todos: [
          { content: 'Task A', status: 'pending' },
          { content: 'Task B', status: 'pending' },
          { content: 'Task C', status: 'pending' },
        ]},
        { signal: new AbortController().signal, metadata: {} },
      );

      const result = await todoTool.execute(
        { todos: [
          { content: 'Task A', status: 'completed' },
          { content: 'Task B', status: 'in_progress' },
        ]},
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('[x] Task A');
      expect(result.content).toContain('[~] Task B');
      expect(result.content).not.toContain('Task C');
    });

    it('rejects multiple in_progress todos', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const todoTool = tools.get('todo_write');

      const result = await todoTool.execute(
        { todos: [
          { content: 'Task A', status: 'in_progress' },
          { content: 'Task B', status: 'in_progress' },
        ]},
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('only one todo');
    });

    it('clears the list with an empty array', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const todoTool = tools.get('todo_write');

      await todoTool.execute(
        { todos: [{ content: 'Task', status: 'pending' }] },
        { signal: new AbortController().signal, metadata: {} },
      );

      const result = await todoTool.execute(
        { todos: [] },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('cleared');
    });

    it('defaults invalid status to pending', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const tools = (agent as any).tools as Map<string, any>;
      const todoTool = tools.get('todo_write');

      const result = await todoTool.execute(
        { todos: [{ content: 'Task', status: 'bogus' }] },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('[ ] Task');
    });
  });
});
