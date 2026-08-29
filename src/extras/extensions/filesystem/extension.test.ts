import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from 'libra';
import createFilesystemExtension from './extension.js';

// Minimal model that never actually calls the LLM — we just need the
// agent to register tools so we can call them directly.
function makeAgent() {
  return new Agent({
    model: {
      async generate() {
        return { message: { role: 'assistant' as const, content: '' }, finishReason: 'stop' as const };
      },
    } as any,
  });
}

describe('filesystem extension', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'fs-test-'));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function makeExt() {
    return createFilesystemExtension({
      directories: [{ name: 'sandbox', path: sandbox }],
    });
  }

  function getTool(agent: Agent, name: string): any {
    return (agent as any).tools.get(name);
  }

  // ── Path safety ──────────────────────────────────────────────────

  it('blocks path traversal with ..', () => {
    const ext = makeExt();
    expect(() => ext.resolvePath('sandbox/../etc/passwd')).toThrow('escapes');
  });

  it('blocks absolute paths', () => {
    const ext = makeExt();
    expect(() => ext.resolvePath('/etc/passwd')).toThrow('must start with a sandbox name');
  });

  it('blocks paths without a sandbox prefix', () => {
    const ext = makeExt();
    expect(() => ext.resolvePath('foo/bar.txt')).toThrow('must start with a sandbox name');
  });

  it('resolves normal paths within sandbox', () => {
    const ext = makeExt();
    const resolved = ext.resolvePath('sandbox/foo/bar.txt');
    expect(resolved).toBe(join(sandbox, 'foo', 'bar.txt'));
  });

  // ── saveBytes ────────────────────────────────────────────────────

  it('saveBytes writes file and creates parent dirs', () => {
    const ext = makeExt();
    ext.saveBytes('sandbox/subdir/file.bin', Buffer.from('hello'), 'text/plain');
    const data = readFileSync(join(sandbox, 'subdir', 'file.bin'), 'utf-8');
    expect(data).toBe('hello');
  });

  it('saveBytes returns the prefixed path', () => {
    const ext = makeExt();
    const path = ext.saveBytes('sandbox/test.txt', Buffer.from('data'));
    expect(path).toBe('sandbox/test.txt');
  });

  // ── fs_write ─────────────────────────────────────────────────────

  it('fs_write creates a text file', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_write');
    const result = await tool.execute({ path: 'sandbox/hello.txt', content: 'Hello world' });
    expect(result.content).toContain('Wrote');
    expect(existsSync(join(sandbox, 'hello.txt'))).toBe(true);
    expect(readFileSync(join(sandbox, 'hello.txt'), 'utf-8')).toBe('Hello world');
  });

  it('fs_write creates parent directories', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_write');
    await tool.execute({ path: 'sandbox/a/b/c/file.txt', content: 'nested' });
    expect(readFileSync(join(sandbox, 'a', 'b', 'c', 'file.txt'), 'utf-8')).toBe('nested');
  });

  it('fs_write overwrites existing files', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_write');
    await tool.execute({ path: 'sandbox/file.txt', content: 'first' });
    await tool.execute({ path: 'sandbox/file.txt', content: 'second' });
    expect(readFileSync(join(sandbox, 'file.txt'), 'utf-8')).toBe('second');
  });

  it('fs_write blocks path traversal', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_write');
    const result = await tool.execute({ path: 'sandbox/../escape.txt', content: 'bad' });
    expect(result.content).toContain('escapes');
    expect(existsSync(join(sandbox, '..', 'escape.txt'))).toBe(false);
  });

  it('fs_write rejects paths without sandbox prefix', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_write');
    const result = await tool.execute({ path: 'file.txt', content: 'x' });
    expect(result.content).toContain('must start with a sandbox name');
  });

  // ── fs_read ──────────────────────────────────────────────────────

  it('fs_read returns text content for text files', async () => {
    const ext = makeExt();
    ext.saveBytes('sandbox/notes.txt', Buffer.from('Hello from the file'));
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_read');
    const result = await tool.execute({ path: 'sandbox/notes.txt' });
    expect(result.content).toContain('Hello from the file');
  });

  it('fs_read returns base64 for binary files', async () => {
    const ext = makeExt();
    ext.saveBytes('sandbox/data.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_read');
    const result = await tool.execute({ path: 'sandbox/data.bin' });
    expect(result.content).toContain('base64');
    expect(result.content).toContain('iVBOR'); // base64 of PNG header
  });

  it('fs_read returns error for missing files', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_read');
    const result = await tool.execute({ path: 'sandbox/nope.txt' });
    expect(result.content).toContain('not found');
  });

  it('fs_read returns error for directories', async () => {
    const ext = makeExt();
    ext.saveBytes('sandbox/dir/file.txt', Buffer.from('x'));
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_read');
    const result = await tool.execute({ path: 'sandbox/dir' });
    expect(result.content).toContain('directory');
  });

  it('fs_read blocks path traversal', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_read');
    const result = await tool.execute({ path: 'sandbox/../../../etc/passwd' });
    expect(result.content).toContain('escapes');
  });

  // ── fs_list ──────────────────────────────────────────────────────

  it('fs_list with no path lists sandbox directories', async () => {
    const ext = makeExt();
    ext.saveBytes('sandbox/file1.txt', Buffer.from('a'));
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_list');
    const result = await tool.execute({});
    expect(result.content).toContain('sandbox');
  });

  it('fs_list lists sandbox contents', async () => {
    const ext = makeExt();
    ext.saveBytes('sandbox/file1.txt', Buffer.from('a'));
    ext.saveBytes('sandbox/file2.csv', Buffer.from('b'));
    ext.saveBytes('sandbox/subdir/file3.txt', Buffer.from('c'));
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_list');
    const result = await tool.execute({ path: 'sandbox' });
    expect(result.content).toContain('file1.txt');
    expect(result.content).toContain('file2.csv');
    expect(result.content).toContain('[dir]');
    expect(result.content).toContain('subdir/');
  });

  it('fs_list lists subdirectory contents', async () => {
    const ext = makeExt();
    ext.saveBytes('sandbox/data/a.txt', Buffer.from('1'));
    ext.saveBytes('sandbox/data/b.txt', Buffer.from('2'));
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_list');
    const result = await tool.execute({ path: 'sandbox/data' });
    expect(result.content).toContain('a.txt');
    expect(result.content).toContain('b.txt');
  });

  it('fs_list returns empty for empty directories', async () => {
    const ext = makeExt();
    ext.saveBytes('sandbox/empty/.keep', Buffer.from(''));
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_list');
    // Remove the .keep to make it truly empty
    rmSync(join(sandbox, 'empty', '.keep'));
    const result = await tool.execute({ path: 'sandbox/empty' });
    expect(result.content).toContain('empty');
  });

  // ── fs_delete ────────────────────────────────────────────────────

  it('fs_delete removes a file', async () => {
    const ext = makeExt();
    ext.saveBytes('sandbox/temp.txt', Buffer.from('delete me'));
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_delete');
    const result = await tool.execute({ path: 'sandbox/temp.txt' });
    expect(result.content).toContain('Deleted');
    expect(existsSync(join(sandbox, 'temp.txt'))).toBe(false);
  });

  it('fs_delete removes an empty directory', async () => {
    const ext = makeExt();
    ext.saveBytes('sandbox/empty/.keep', Buffer.from(''));
    rmSync(join(sandbox, 'empty', '.keep'));
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_delete');
    const result = await tool.execute({ path: 'sandbox/empty' });
    expect(result.content).toContain('Deleted');
    expect(existsSync(join(sandbox, 'empty'))).toBe(false);
  });

  it('fs_delete refuses non-empty directories', async () => {
    const ext = makeExt();
    ext.saveBytes('sandbox/dir/file.txt', Buffer.from('x'));
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_delete');
    const result = await tool.execute({ path: 'sandbox/dir' });
    expect(result.content).toContain('not empty');
  });

  it('fs_delete refuses to delete sandbox root', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_delete');
    const result = await tool.execute({ path: 'sandbox' });
    expect(result.content).toContain('Refusing');
  });

  it('fs_delete returns error for missing files', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_delete');
    const result = await tool.execute({ path: 'sandbox/nope.txt' });
    expect(result.content).toContain('not found');
  });

  it('fs_delete blocks path traversal', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_delete');
    const result = await tool.execute({ path: 'sandbox/../../../etc/passwd' });
    expect(result.content).toContain('escapes');
  });

  // ── fs_info ──────────────────────────────────────────────────────

  it('fs_info returns file metadata', async () => {
    const ext = makeExt();
    ext.saveBytes('sandbox/report.csv', Buffer.from('a,b,c\n1,2,3'));
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_info');
    const result = await tool.execute({ path: 'sandbox/report.csv' });
    expect(result.content).toContain('report.csv');
    expect(result.content).toContain('file');
    expect(result.content).toContain('.csv');
    expect(result.content).toContain('Text file: true');
  });

  it('fs_info returns directory metadata', async () => {
    const ext = makeExt();
    ext.saveBytes('sandbox/dir/file.txt', Buffer.from('x'));
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_info');
    const result = await tool.execute({ path: 'sandbox/dir' });
    expect(result.content).toContain('directory');
  });

  it('fs_info returns error for missing paths', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'fs_info');
    const result = await tool.execute({ path: 'sandbox/nope' });
    expect(result.content.toLowerCase()).toContain('not found');
  });

  // ── Multi-directory mode ─────────────────────────────────────────

  describe('multi-directory mode', () => {
    let dirA: string;
    let dirB: string;

    beforeEach(() => {
      dirA = mkdtempSync(join(tmpdir(), 'fs-a-'));
      dirB = mkdtempSync(join(tmpdir(), 'fs-b-'));
    });

    afterEach(() => {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    });

    function makeMultiExt() {
      return createFilesystemExtension({
        directories: [
          { name: 'downloads', path: dirA },
          { name: 'documents', path: dirB },
        ],
      });
    }

    it('saveBytes with prefix saves to the named directory', () => {
      const ext = makeMultiExt();
      ext.saveBytes('documents/info.txt', Buffer.from('ACME Inc'));
      expect(readFileSync(join(dirB, 'info.txt'), 'utf-8')).toBe('ACME Inc');
      expect(existsSync(join(dirA, 'info.txt'))).toBe(false);
    });

    it('saveBytes returns the full prefixed path', () => {
      const ext = makeMultiExt();
      const path = ext.saveBytes('documents/info.txt', Buffer.from('x'));
      expect(path).toBe('documents/info.txt');
    });

    it('resolvePath resolves to the correct directory', () => {
      const ext = makeMultiExt();
      expect(ext.resolvePath('downloads/report.txt')).toBe(join(dirA, 'report.txt'));
      expect(ext.resolvePath('documents/data.json')).toBe(join(dirB, 'data.json'));
    });

    it('resolvePath blocks traversal within a named directory', () => {
      const ext = makeMultiExt();
      expect(() => ext.resolvePath('downloads/../../../etc/passwd')).toThrow('escapes');
    });

    it('resolvePath rejects paths without a sandbox prefix', () => {
      const ext = makeMultiExt();
      expect(() => ext.resolvePath('file.txt')).toThrow('must start with a sandbox name');
    });

    it('fs_write writes to the named directory', async () => {
      const ext = makeMultiExt();
      const agent = makeAgent();
      agent.use(ext);
      const tool = getTool(agent, 'fs_write');
      await tool.execute({ path: 'documents/notes.md', content: '# Company' });
      expect(readFileSync(join(dirB, 'notes.md'), 'utf-8')).toBe('# Company');
    });

    it('fs_read reads from the named directory', async () => {
      const ext = makeMultiExt();
      ext.saveBytes('documents/readme.txt', Buffer.from('Hello'));
      const agent = makeAgent();
      agent.use(ext);
      const tool = getTool(agent, 'fs_read');
      const result = await tool.execute({ path: 'documents/readme.txt' });
      expect(result.content).toContain('Hello');
    });

    it('fs_list with no path lists the sandbox directories', async () => {
      const ext = makeMultiExt();
      ext.saveBytes('downloads/a.txt', Buffer.from('x'));
      const agent = makeAgent();
      agent.use(ext);
      const tool = getTool(agent, 'fs_list');
      const result = await tool.execute({});
      expect(result.content).toContain('downloads');
      expect(result.content).toContain('documents');
    });

    it('fs_list with a sandbox name lists its contents', async () => {
      const ext = makeMultiExt();
      ext.saveBytes('documents/a.txt', Buffer.from('1'));
      ext.saveBytes('documents/b.txt', Buffer.from('2'));
      const agent = makeAgent();
      agent.use(ext);
      const tool = getTool(agent, 'fs_list');
      const result = await tool.execute({ path: 'documents' });
      expect(result.content).toContain('a.txt');
      expect(result.content).toContain('b.txt');
    });

    it('fs_delete refuses to delete a sandbox root', async () => {
      const ext = makeMultiExt();
      const agent = makeAgent();
      agent.use(ext);
      const tool = getTool(agent, 'fs_delete');
      const result = await tool.execute({ path: 'downloads' });
      expect(result.content).toContain('Refusing');
    });

    it('fs_delete deletes a file within a named directory', async () => {
      const ext = makeMultiExt();
      ext.saveBytes('documents/temp.txt', Buffer.from('x'));
      const agent = makeAgent();
      agent.use(ext);
      const tool = getTool(agent, 'fs_delete');
      const result = await tool.execute({ path: 'documents/temp.txt' });
      expect(result.content).toContain('Deleted');
      expect(existsSync(join(dirB, 'temp.txt'))).toBe(false);
    });
  });
});
