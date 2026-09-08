import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../../agent.js';
import createCodeToolsExtension from './extension.js';

function mockModel() {
  return {
    id: 'test-model',
    provider: 'test-provider',
    async generate() {
      return {
        role: 'assistant' as const,
        message: 'ok',
        finishReason: 'stop' as const,
        iterations: 1,
        metadata: {},
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

      const tools = (agent as any).tools as Map<string, any>;
      const readTool = tools.get('read');
      expect(readTool).toBeDefined();

      const result = await readTool.execute(
        { file_path: filePath },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('test.txt');
      expect(result.content).toMatch(/1\tline one/);
      expect(result.content).toMatch(/2\tline two/);
      expect(result.content).toMatch(/3\tline three/);
    });

    it('returns error if file_path is missing', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const readTool = (agent as any).tools.get('read');

      const result = await readTool.execute(
        {},
        { signal: new AbortController().signal, metadata: {} },
      );
      expect(result.content).toContain('Error: file_path is required');
    });

    it('returns error for non-existent file', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const readTool = (agent as any).tools.get('read');

      const result = await readTool.execute(
        { file_path: join(tmpDir, 'nope.txt') },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('File not found');
    });

    it('returns error for directory path', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const readTool = (agent as any).tools.get('read');

      const subDir = join(tmpDir, 'subdir');
      mkdirSync(subDir);

      const result = await readTool.execute(
        { file_path: subDir },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('Path is a directory, not a file');
    });

    it('respects startLine and endLine pagination', async () => {
      const filePath = join(tmpDir, 'paginated.txt');
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
      writeFileSync(filePath, lines);

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const readTool = (agent as any).tools.get('read');

      const result = await readTool.execute(
        { file_path: filePath, startLine: 5, endLine: 8 },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).not.toContain('line 4\n');
      expect(result.content).toMatch(/5\tline 5/);
      expect(result.content).toMatch(/8\tline 8/);
      expect(result.content).not.toMatch(/9\tline 9/);
      expect(result.content).toContain('[showing lines 5-8 of 20 total]');
    });

    it('returns base64 for binary files', async () => {
      const filePath = join(tmpDir, 'binary.bin');
      const binData = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
      writeFileSync(filePath, binData);

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const readTool = (agent as any).tools.get('read');

      const result = await readTool.execute(
        { file_path: filePath },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('binary');
      expect(result.content).toContain('base64:');
    });

    it('returns data URL for image files', async () => {
      const filePath = join(tmpDir, 'image.png');
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      writeFileSync(filePath, pngHeader);

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const readTool = (agent as any).tools.get('read');

      const result = await readTool.execute(
        { file_path: filePath },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('data:image/png;base64,');
    });

    it('tracks read paths in metadata for edit/write enforcement', async () => {
      const filePath = join(tmpDir, 'tracked.txt');
      writeFileSync(filePath, 'content');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const readTool = (agent as any).tools.get('read');

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
      const writeTool = (agent as any).tools.get('write');

      const result = await writeTool.execute(
        { file_path: filePath, content: 'created' },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('Wrote 7 chars');
      expect(readFileSync(filePath, 'utf-8')).toBe('created');
    });

    it('creates parent directories recursively', async () => {
      const filePath = join(tmpDir, 'nested', 'sub', 'file.txt');
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const writeTool = (agent as any).tools.get('write');

      await writeTool.execute(
        { file_path: filePath, content: 'nested' },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(readFileSync(filePath, 'utf-8')).toBe('nested');
    });

    it('returns error if file_path is missing', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const writeTool = (agent as any).tools.get('write');

      const result = await writeTool.execute({}, { signal: new AbortController().signal, metadata: {} });
      expect(result.content).toContain('file_path is required');
    });

    it('refuses to overwrite an existing file without reading first', async () => {
      const filePath = join(tmpDir, 'existing.txt');
      writeFileSync(filePath, 'original');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const writeTool = (agent as any).tools.get('write');

      const result = await writeTool.execute(
        { file_path: filePath, content: 'updated' },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('You must read');
      expect(readFileSync(filePath, 'utf-8')).toBe('original');
    });

    it('overwrites an existing file after reading it', async () => {
      const filePath = join(tmpDir, 'allowed.txt');
      writeFileSync(filePath, 'original');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const tools = (agent as any).tools;
      const readTool = tools.get('read');
      const writeTool = tools.get('write');

      const metadata: Record<string, unknown> = {};
      const ctx = { signal: new AbortController().signal, metadata };

      await readTool.execute({ file_path: filePath }, ctx);
      const result = await writeTool.execute({ file_path: filePath, content: 'overwritten' }, ctx);

      expect(result.content).toContain('Wrote 11 chars');
      expect(readFileSync(filePath, 'utf-8')).toBe('overwritten');
    });
  });

  // ── edit tool ──────────────────────────────────────────────────────
  describe('edit tool', () => {
    it('refuses to edit without reading first', async () => {
      const filePath = join(tmpDir, 'edit-me.txt');
      writeFileSync(filePath, 'alpha\nbeta\ngamma');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const editTool = (agent as any).tools.get('edit');

      const result = await editTool.execute(
        {
          file_path: filePath,
          startLine: 1,
          endLine: 3,
          targetContent: 'beta',
          replacementContent: 'BETA',
        },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('You must read');
    });

    it('fails if line range is invalid or startLine > endLine', async () => {
      const filePath = join(tmpDir, 'range-check.txt');
      writeFileSync(filePath, 'a\nb\nc');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const editTool = (agent as any).tools.get('edit');

      const result = await editTool.execute(
        {
          file_path: filePath,
          startLine: 5,
          endLine: 2,
          targetContent: 'b',
          replacementContent: 'B',
        },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('Invalid line range');
    });

    it('fails if targetContent and replacementContent are identical', async () => {
      const filePath = join(tmpDir, 'identical.txt');
      writeFileSync(filePath, 'same');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const editTool = (agent as any).tools.get('edit');

      const result = await editTool.execute(
        {
          file_path: filePath,
          startLine: 1,
          endLine: 1,
          targetContent: 'same',
          replacementContent: 'same',
        },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('identical');
    });

    it('replaces a unique targetContent in the specified line range', async () => {
      const filePath = join(tmpDir, 'block-edit.txt');
      writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5\n');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const tools = (agent as any).tools;
      const readTool = tools.get('read');
      const editTool = tools.get('edit');

      const metadata: Record<string, unknown> = {};
      const ctx = { signal: new AbortController().signal, metadata };

      await readTool.execute({ file_path: filePath }, ctx);
      const result = await editTool.execute(
        {
          file_path: filePath,
          startLine: 2,
          endLine: 4,
          targetContent: 'line3',
          replacementContent: 'MODIFIED_LINE_3',
        },
        ctx,
      );

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('Successfully edited');
      const updated = readFileSync(filePath, 'utf-8');
      expect(updated).toBe('line1\nline2\nMODIFIED_LINE_3\nline4\nline5\n');
    });

    it('replaces a multi-line block across several lines', async () => {
      const filePath = join(tmpDir, 'multiline.txt');
      writeFileSync(filePath, 'start\nfunction test() {\n  return 1;\n}\nend\n');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const tools = (agent as any).tools;
      const readTool = tools.get('read');
      const editTool = tools.get('edit');

      const metadata: Record<string, unknown> = {};
      const ctx = { signal: new AbortController().signal, metadata };

      await readTool.execute({ file_path: filePath }, ctx);
      const result = await editTool.execute(
        {
          file_path: filePath,
          startLine: 2,
          endLine: 4,
          targetContent: 'function test() {\n  return 1;\n}',
          replacementContent: 'function test() {\n  return 42;\n}',
        },
        ctx,
      );

      expect(result.isError).toBeFalsy();
      const updated = readFileSync(filePath, 'utf-8');
      expect(updated).toBe('start\nfunction test() {\n  return 42;\n}\nend\n');
    });

    it('fails if targetContent is not found within line range', async () => {
      const filePath = join(tmpDir, 'not-found.txt');
      writeFileSync(filePath, 'alpha\nbeta\ngamma\ndelta');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const tools = (agent as any).tools;
      const readTool = tools.get('read');
      const editTool = tools.get('edit');

      const metadata: Record<string, unknown> = {};
      const ctx = { signal: new AbortController().signal, metadata };

      await readTool.execute({ file_path: filePath }, ctx);
      const result = await editTool.execute(
        {
          file_path: filePath,
          startLine: 1,
          endLine: 2,
          targetContent: 'delta',
          replacementContent: 'DELTA',
        },
        ctx,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('not found in');
    });

    it('fails if targetContent appears multiple times in the range', async () => {
      const filePath = join(tmpDir, 'duplicate.txt');
      writeFileSync(filePath, 'dup\ndup\ndup\n');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const tools = (agent as any).tools;
      const readTool = tools.get('read');
      const editTool = tools.get('edit');

      const metadata: Record<string, unknown> = {};
      const ctx = { signal: new AbortController().signal, metadata };

      await readTool.execute({ file_path: filePath }, ctx);
      const result = await editTool.execute(
        {
          file_path: filePath,
          startLine: 1,
          endLine: 3,
          targetContent: 'dup',
          replacementContent: 'new',
        },
        ctx,
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain('appears 3 times');
    });

    it('returns error if file_path is missing or file does not exist', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const editTool = (agent as any).tools.get('edit');

      const res1 = await editTool.execute(
        { startLine: 1, endLine: 1, targetContent: 'a', replacementContent: 'b' },
        { signal: new AbortController().signal, metadata: {} },
      );
      expect(res1.content).toContain('file_path is required');

      const res2 = await editTool.execute(
        { file_path: join(tmpDir, 'ghost.txt'), startLine: 1, endLine: 1, targetContent: 'a', replacementContent: 'b' },
        { signal: new AbortController().signal, metadata: {} },
      );
      expect(res2.content).toContain('File not found');
    });
  });

  // ── find_file_by_name tool ──────────────────────────────────────────
  describe('find_file_by_name tool', () => {
    it('finds files by glob pattern', async () => {
      writeFileSync(join(tmpDir, 'foo.ts'), '');
      writeFileSync(join(tmpDir, 'bar.ts'), '');
      writeFileSync(join(tmpDir, 'baz.js'), '');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const findTool = (agent as any).tools.get('find_file_by_name');

      const result = await findTool.execute(
        { pattern: '*.ts', path: tmpDir },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('foo.ts');
      expect(result.content).toContain('bar.ts');
      expect(result.content).not.toContain('baz.js');
    });

    it('returns message when no files match', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const findTool = (agent as any).tools.get('find_file_by_name');

      const result = await findTool.execute(
        { pattern: '*.nonexistent', path: tmpDir },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('No files matching');
    });

    it('returns error for missing pattern or non-existent path', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const findTool = (agent as any).tools.get('find_file_by_name');

      const res1 = await findTool.execute({}, { signal: new AbortController().signal, metadata: {} });
      expect(res1.content).toContain('pattern is required');

      const res2 = await findTool.execute(
        { pattern: '*', path: join(tmpDir, 'does-not-exist') },
        { signal: new AbortController().signal, metadata: {} },
      );
      expect(res2.content).toContain('Directory not found');
    });
  });

  // ── grep tool ───────────────────────────────────────────────────────
  describe('grep tool', () => {
    it('finds matching lines with ripgrep', async () => {
      writeFileSync(join(tmpDir, 'sample.txt'), 'hello world\ngoodbye world\nhello universe\n');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const grepTool = (agent as any).tools.get('grep');

      const result = await grepTool.execute(
        { pattern: 'hello', path: tmpDir },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('hello world');
      expect(result.content).toContain('hello universe');
      expect(result.content).not.toContain('goodbye world');
    });

    it('supports case_insensitive search', async () => {
      writeFileSync(join(tmpDir, 'case.txt'), 'ABC\nabc\n');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const grepTool = (agent as any).tools.get('grep');

      const result = await grepTool.execute(
        { pattern: 'abc', path: tmpDir, case_insensitive: true },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('ABC');
      expect(result.content).toContain('abc');
    });

    it('supports context_lines', async () => {
      writeFileSync(join(tmpDir, 'ctx.txt'), 'line1\nTARGET\nline3\n');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const grepTool = (agent as any).tools.get('grep');

      const result = await grepTool.execute(
        { pattern: 'TARGET', path: tmpDir, context_lines: 1 },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('line1');
      expect(result.content).toContain('TARGET');
      expect(result.content).toContain('line3');
    });

    it('returns message when no matches are found', async () => {
      writeFileSync(join(tmpDir, 'empty.txt'), 'nothing here');

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const grepTool = (agent as any).tools.get('grep');

      const result = await grepTool.execute(
        { pattern: 'MISSING_KEYWORD', path: tmpDir },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('No matches found for');
    });
  });

  // ── run_command & manage_task tools ─────────────────────────────────
  describe('run_command and manage_task tools', () => {
    it('executes a command synchronously and returns output', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const runTool = (agent as any).tools.get('run_command');

      const result = await runTool.execute(
        { CommandLine: 'echo "hello from bash"', Cwd: tmpDir, WaitMsBeforeAsync: 3000 },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('Command completed');
      expect(result.content).toContain('hello from bash');
    });

    it('preserves shell quoting, substitution, and command separators', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const runTool = (agent as any).tools.get('run_command');

      const result = await runTool.execute(
        { CommandLine: 'printf "quoted value\\n"; echo "stamp-$(printf 123)"', Cwd: tmpDir, WaitMsBeforeAsync: 3000 },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('quoted value\nstamp-123');
      expect(result.content).not.toContain('"quoted value');
    });

    it('captures failing commands with non-zero exit code', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const runTool = (agent as any).tools.get('run_command');

      const result = await runTool.execute(
        { CommandLine: 'exit 42', Cwd: tmpDir, WaitMsBeforeAsync: 3000 },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('exit code 42');
    });

    it('backgrounds immediately when WaitMsBeforeAsync is 0', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const runTool = (agent as any).tools.get('run_command');
      const manageTool = (agent as any).tools.get('manage_task');

      const result = await runTool.execute(
        { CommandLine: 'sleep 1', Cwd: tmpDir, WaitMsBeforeAsync: 0 },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(result.content).toContain('Command sent to background. Task ID:');
      const match = result.content.match(/Task ID: (task_[\w-]+)/);
      expect(match).toBeTruthy();
      const taskId = match![1];

      // Check status using manage_task
      const statusRes = await manageTool.execute(
        { Action: 'status', TaskId: taskId },
        { signal: new AbortController().signal, metadata: {} },
      );
      expect(statusRes.content).toBeDefined();

      // Kill the task
      const killRes = await manageTool.execute(
        { Action: 'kill', TaskId: taskId },
        { signal: new AbortController().signal, metadata: {} },
      );
      expect(killRes.content).toContain(`Killed task ${taskId}`);
    });

    it('fires the configured callback after a background task exits', async () => {
      const callbackFile = join(tmpDir, 'callback.txt');
      const callbackScript = join(tmpDir, 'callback.sh');
      const shellsDir = join(tmpDir, 'shells');
      writeFileSync(callbackScript, `printf '%s\\n' "$*" > "${callbackFile}"\n`);

      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension({
        shellsDir,
        callbackBin: '/bin/bash',
        callbackEntry: callbackScript,
        callbackSessionKey: 'test-session',
      }));
      const runTool = (agent as any).tools.get('run_command');

      const result = await runTool.execute(
        { CommandLine: 'sleep 0.1; echo finished', Cwd: tmpDir, WaitMsBeforeAsync: 0 },
        { signal: new AbortController().signal, metadata: { sessionId: 'slack-session' } },
      );
      const taskId = result.content.match(/Task ID: (task_[\w-]+)/)![1];

      for (let i = 0; i < 20 && !existsSync(callbackFile); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(readFileSync(join(shellsDir, `${taskId}.output`), 'utf-8')).toContain('finished');
      expect(readFileSync(callbackFile, 'utf-8')).toContain(`--session slack-session FYI: Background task ${taskId} finished`);
    });

    it('handles run_command and manage_task error conditions', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const runTool = (agent as any).tools.get('run_command');
      const manageTool = (agent as any).tools.get('manage_task');

      const noCmd = await runTool.execute({}, { signal: new AbortController().signal, metadata: {} });
      expect(noCmd.content).toContain('CommandLine is required');

      const noTaskId = await manageTool.execute({ Action: 'kill' }, { signal: new AbortController().signal, metadata: {} });
      expect(noTaskId.content).toContain('TaskId is required');

      const unknownTask = await manageTool.execute({ Action: 'status', TaskId: 'task_99999' }, { signal: new AbortController().signal, metadata: {} });
      expect(unknownTask.content).toContain('no task with id "task_99999"');

      const unknownAction = await manageTool.execute({ Action: 'dance', TaskId: 'task_1' }, { signal: new AbortController().signal, metadata: {} });
      expect(unknownAction.content).toContain('no task with id');
    });
  });

  // ── todo_write tool ─────────────────────────────────────────────────
  describe('todo_write tool', () => {
    it('creates and updates todos', async () => {
      const todoFile = join(tmpDir, 'todos.json');
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension({ todoFile }));
      const todoTool = (agent as any).tools.get('todo_write');

      const res1 = await todoTool.execute(
        {
          todos: [
            { content: 'Task 1', status: 'completed' },
            { content: 'Task 2', status: 'in_progress' },
            { content: 'Task 3', status: 'pending' },
          ],
        },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(res1.content).toContain('Updated todo list:');
      expect(res1.content).toContain('[x] Task 1');
      expect(res1.content).toContain('[~] Task 2');
      expect(res1.content).toContain('[ ] Task 3');

      // Check file persistence
      const diskContent = JSON.parse(readFileSync(todoFile, 'utf-8'));
      expect(diskContent).toHaveLength(3);
      expect(diskContent[0].content).toBe('Task 1');
    });

    it('rejects multiple in_progress todos', async () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());
      const todoTool = (agent as any).tools.get('todo_write');

      const res = await todoTool.execute(
        {
          todos: [
            { content: 'Task 1', status: 'in_progress' },
            { content: 'Task 2', status: 'in_progress' },
          ],
        },
        { signal: new AbortController().signal, metadata: {} },
      );

      expect(res.isError).toBe(true);
      expect(res.content).toContain('only one todo can be "in_progress"');
    });
  });

  // ── configuration & extension wiring ────────────────────────────────
  describe('configuration', () => {
    it('registers all 8 expected tools without prefix', () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension());

      const toolNames = Array.from(((agent as any).tools as Map<string, any>).keys());
      expect(toolNames).toContain('read');
      expect(toolNames).toContain('write');
      expect(toolNames).toContain('edit');
      expect(toolNames).toContain('find_file_by_name');
      expect(toolNames).toContain('grep');
      expect(toolNames).toContain('run_command');
      expect(toolNames).toContain('manage_task');
      expect(toolNames).toContain('todo_write');
    });

    it('supports custom tool prefix', () => {
      const agent = new Agent({ model: mockModel() as any });
      agent.use(createCodeToolsExtension({ toolPrefix: 'custom' }));

      const toolNames = Array.from(((agent as any).tools as Map<string, any>).keys());
      expect(toolNames).toContain('custom_read');
      expect(toolNames).toContain('custom_write');
      expect(toolNames).toContain('custom_edit');
      expect(toolNames).toContain('custom_find_file_by_name');
      expect(toolNames).toContain('custom_grep');
      expect(toolNames).toContain('custom_run_command');
      expect(toolNames).toContain('custom_manage_task');
      expect(toolNames).toContain('custom_todo_write');
    });
  });
});
