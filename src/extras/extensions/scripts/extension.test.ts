import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from 'libra';
import type { Extension } from 'libra';
import createScriptsExtension, { type FsHelper } from './extension.js';

// Minimal model that never calls the LLM — we only need tools registered.
function makeAgent() {
  return new Agent({
    model: {
      async generate() {
        return { message: { role: 'assistant' as const, content: '' }, finishReason: 'stop' as const };
      },
    } as any,
  });
}

function getTool(agent: Agent, name: string): any {
  return (agent as any).tools.get(name);
}

// A fake filesystem helper that mimics the filesystem extension's surface,
// scoped to a single sandbox directory named "data".
function makeFakeFs(sandboxDir: string): FsHelper {
  if (!existsSync(sandboxDir)) mkdirSync(sandboxDir, { recursive: true });
  return {
    resolvePath(path: string): string {
      if (!path.startsWith('data/') && path !== 'data') {
        throw new Error(`Path "${path}" must start with a sandbox name ("data")`);
      }
      const rel = path === 'data' ? '.' : path.slice('data/'.length);
      if (rel.startsWith('..')) throw new Error(`Path "${path}" escapes the sandbox`);
      return join(sandboxDir, rel);
    },
    saveBytes(path: string, data: Buffer): string {
      const abs = this.resolvePath(path);
      const dir = abs.slice(0, abs.lastIndexOf('/'));
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(abs, data);
      return path;
    },
  };
}

describe('scripts extension', () => {
  let registry: string;
  let sandbox: string;

  beforeEach(() => {
    registry = mkdtempSync(join(tmpdir(), 'scripts-reg-'));
    sandbox = mkdtempSync(join(tmpdir(), 'scripts-fs-'));
  });

  afterEach(() => {
    rmSync(registry, { recursive: true, force: true });
    rmSync(sandbox, { recursive: true, force: true });
  });

  function makeExt(overrides: Partial<Parameters<typeof createScriptsExtension>[0]> = {}): Extension & {
    runScript: (n: string, i: unknown, o?: { outputPath?: string }) => Promise<any>;
    runPipeline: (stages: string[], input: unknown, o?: { outputPath?: string }) => Promise<any>;
    getScript: (n: string) => any;
    listScripts: () => any[];
  } {
    return createScriptsExtension({
      registryDir: registry,
      interruptMs: 2000,
      ...overrides,
    }) as any;
  }

  // ── Registry persistence ───────────────────────────────────────────────

  it('persists a saved script to disk as JSON', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    const tool = getTool(agent, 'script_save');
    const result = await tool.execute({ name: 'filter-active', description: 'filters', code: 'return input' });
    expect(result.content).toContain('Saved script "filter-active"');
    expect(result.content).toContain('created');

    const files = ext.listScripts();
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('filter-active');
    expect(files[0].code).toBe('return input');

    // Persisted to disk.
    const onDisk = JSON.parse(readFileSync(join(registry, 'filter-active.json'), 'utf-8'));
    expect(onDisk.code).toBe('return input');
  });

  it('updates an existing script and preserves createdAt', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 's', code: 'return 1' });
    const first = ext.getScript('s');
    await getTool(agent, 'script_save').execute({ name: 's', description: 'now described', code: 'return 2' });
    const second = ext.getScript('s');
    expect(second.code).toBe('return 2');
    expect(second.description).toBe('now described');
    expect(second.createdAt).toBe(first!.createdAt);
    expect(second.updatedAt).not.toBe(first!.createdAt);
  });

  it('rejects saving without a name or code', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    const noName = await getTool(agent, 'script_save').execute({ code: 'return 1' });
    expect(noName.content).toContain('name is required');
    const noCode = await getTool(agent, 'script_save').execute({ name: 'x' });
    expect(noCode.content).toContain('code is required');
  });

  // ── list / get / delete ────────────────────────────────────────────────

  it('lists registered scripts', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'a', description: 'first', code: 'return 1' });
    await getTool(agent, 'script_save').execute({ name: 'b', description: 'second', code: 'return 2' });
    const result = await getTool(agent, 'script_list').execute({});
    expect(result.content).toContain('Registered scripts (2)');
    expect(result.content).toContain('a — first');
    expect(result.content).toContain('b — second');
  });

  it('reports empty registry', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    const result = await getTool(agent, 'script_list').execute({});
    expect(result.content).toContain('No scripts registered');
  });

  it('gets a script source', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'g', description: 'd', code: 'return input.x' });
    const result = await getTool(agent, 'script_get').execute({ name: 'g' });
    expect(result.content).toContain('return input.x');
    expect(result.content).toContain('Description: d');
  });

  it('deletes a script', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'del', code: 'return 1' });
    const result = await getTool(agent, 'script_delete').execute({ name: 'del' });
    expect(result.content).toContain('Deleted script: del');
    expect(ext.getScript('del')).toBeUndefined();
    expect(existsSync(join(registry, 'del.json'))).toBe(false);
  });

  // ── Execution (QuickJS sandbox) ────────────────────────────────────────

  it('runs a script with inline input and returns JSON output', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({
      name: 'sum',
      code: 'return input.a + input.b',
    });
    const result = await getTool(agent, 'script_run').execute({ name: 'sum', input: { a: 2, b: 3 } });
    expect(result.content).toContain('OK');
    expect(result.content).toContain('5');
  });

  it('filters an array input', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({
      name: 'active',
      code: 'return input.filter(x => x.active).map(x => x.name)',
    });
    const result = await getTool(agent, 'script_run').execute({
      name: 'active',
      input: [
        { name: 'a', active: true },
        { name: 'b', active: false },
        { name: 'c', active: true },
      ],
    });
    expect(result.content).toContain('"a"');
    expect(result.content).toContain('"c"');
    expect(result.content).not.toContain('"b"');
  });

  it('reports a runtime error from the script', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({
      name: 'boom',
      code: 'throw new Error("kaboom")',
    });
    const result = await getTool(agent, 'script_run').execute({ name: 'boom', input: null });
    expect(result.content).toContain('ERROR');
    expect(result.content).toContain('kaboom');
  });

  it('reports when the script is not found', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    const result = await getTool(agent, 'script_run').execute({ name: 'missing', input: 1 });
    expect(result.content).toContain('Script not found: missing');
  });

  it('defaults input to null when neither input nor inputPath given', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'id', code: 'return input' });
    const result = await getTool(agent, 'script_run').execute({ name: 'id' });
    expect(result.content).toContain('null');
  });

  it('cannot access the host process from inside the sandbox', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({
      name: 'escape',
      code: 'return typeof process',
    });
    const result = await getTool(agent, 'script_run').execute({ name: 'escape', input: null });
    // `process` is undefined inside QuickJS.
    expect(result.content).toContain('undefined');
  });

  // ── Disk path input (fs helper + allowlist) ────────────────────────────

  it('reads input from a sandbox disk path via fs helper', async () => {
    const fs = makeFakeFs(sandbox);
    const ext = makeExt({ fs, allowedFsDirs: ['data'] });
    const agent = makeAgent();
    agent.use(ext);
    // Write input file into the sandbox directly.
    writeFileSync(join(sandbox, 'in.json'), JSON.stringify({ value: 42 }));
    await getTool(agent, 'script_save').execute({ name: 'read', code: 'return input.value * 2' });
    const result = await getTool(agent, 'script_run').execute({ name: 'read', inputPath: 'data/in.json' });
    expect(result.content).toContain('84');
  });

  it('blocks disk paths from a non-allowed sandbox dir', async () => {
    const fs = makeFakeFs(sandbox);
    const ext = makeExt({ fs, allowedFsDirs: ['data'] });
    const agent = makeAgent();
    agent.use(ext);
    writeFileSync(join(sandbox, 'secret.json'), JSON.stringify({ x: 1 }));
    await getTool(agent, 'script_save').execute({ name: 'r', code: 'return input' });
    const result = await getTool(agent, 'script_run').execute({ name: 'r', inputPath: 'secret/secret.json' });
    expect(result.content).toContain('not allowed for scripts');
  });

  it('writes output to a sandbox disk path via outputPath', async () => {
    const fs = makeFakeFs(sandbox);
    const ext = makeExt({ fs, allowedFsDirs: ['data'] });
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'gen', code: 'return { n: 7 }' });
    const result = await getTool(agent, 'script_run').execute({
      name: 'gen',
      input: null,
      outputPath: 'data/out.json',
    });
    expect(result.content).toContain('data/out.json');
    const written = JSON.parse(readFileSync(join(sandbox, 'out.json'), 'utf-8'));
    expect(written.n).toBe(7);
  });

  it('refuses disk paths when no fs or allowedDirs configured', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'r', code: 'return input' });
    const result = await getTool(agent, 'script_run').execute({ name: 'r', inputPath: '/etc/passwd' });
    expect(result.content).toContain('Disk path input is not configured');
  });

  // ── Standalone allowedDirs ─────────────────────────────────────────────

  it('supports standalone allowedDirs for disk input', async () => {
    const ext = makeExt({ allowedDirs: [sandbox] });
    const agent = makeAgent();
    agent.use(ext);
    writeFileSync(join(sandbox, 'val.json'), JSON.stringify({ v: 'hi' }));
    await getTool(agent, 'script_save').execute({ name: 'r', code: 'return input.v.toUpperCase()' });
    const result = await getTool(agent, 'script_run').execute({ name: 'r', inputPath: join(sandbox, 'val.json') });
    expect(result.content).toContain('HI');
  });

  it('blocks standalone paths outside allowedDirs', async () => {
    const ext = makeExt({ allowedDirs: [sandbox] });
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'r', code: 'return input' });
    const result = await getTool(agent, 'script_run').execute({ name: 'r', inputPath: '/etc/hosts' });
    expect(result.content).toContain('not within an allowed directory');
  });

  // ── Programmatic API ───────────────────────────────────────────────────

  it('exposes runScript/getScript/listScripts on the extension object', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'p', code: 'return input + 1' });
    const res = await ext.runScript('p', 41);
    expect(res.ok).toBe(true);
    expect(res.output).toBe('42');
    expect(ext.getScript('p').code).toBe('return input + 1');
    expect(ext.listScripts().map((s) => s.name)).toEqual(['p']);
  });

  it('truncates large inline output', async () => {
    const ext = makeExt({ maxOutputChars: 100 });
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'big', code: 'return "x".repeat(500)' });
    const result = await getTool(agent, 'script_run').execute({ name: 'big', input: null });
    expect(result.content).toContain('truncated');
  });

  // ── Disk I/O edge cases ────────────────────────────────────────────────

  it('readInputPath reports missing file (fs mode)', async () => {
    const fs = makeFakeFs(sandbox);
    const ext = makeExt({ fs, allowedFsDirs: ['data'] });
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'r', code: 'return input' });
    const result = await getTool(agent, 'script_run').execute({ name: 'r', inputPath: 'data/missing.json' });
    expect(result.content).toContain('Input file not found');
  });

  it('readInputPath rejects a directory (fs mode)', async () => {
    const fs = makeFakeFs(sandbox);
    const ext = makeExt({ fs, allowedFsDirs: ['data'] });
    const agent = makeAgent();
    agent.use(ext);
    mkdirSync(join(sandbox, 'sub'), { recursive: true });
    await getTool(agent, 'script_save').execute({ name: 'r', code: 'return input' });
    const result = await getTool(agent, 'script_run').execute({ name: 'r', inputPath: 'data/sub' });
    expect(result.content).toContain('Input path is a directory');
  });

  it('readInputPath rejects oversized files', async () => {
    const fs = makeFakeFs(sandbox);
    const ext = makeExt({ fs, allowedFsDirs: ['data'], maxInputBytes: 4 });
    const agent = makeAgent();
    agent.use(ext);
    writeFileSync(join(sandbox, 'big.json'), JSON.stringify({ v: 'way too long' }));
    await getTool(agent, 'script_save').execute({ name: 'r', code: 'return input' });
    const result = await getTool(agent, 'script_run').execute({ name: 'r', inputPath: 'data/big.json' });
    expect(result.content).toContain('Input file too large');
  });

  it('readInputPath passes raw string when file is not JSON', async () => {
    const fs = makeFakeFs(sandbox);
    const ext = makeExt({ fs, allowedFsDirs: ['data'] });
    const agent = makeAgent();
    agent.use(ext);
    writeFileSync(join(sandbox, 'plain.txt'), 'hello world');
    await getTool(agent, 'script_save').execute({ name: 'r', code: 'return input.toUpperCase()' });
    const result = await getTool(agent, 'script_run').execute({ name: 'r', inputPath: 'data/plain.txt' });
    expect(result.content).toContain('HELLO WORLD');
  });

  it('writes output via standalone allowedDirs', async () => {
    const ext = makeExt({ allowedDirs: [sandbox] });
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'g', code: 'return { ok: true }' });
    const result = await getTool(agent, 'script_run').execute({
      name: 'g',
      input: null,
      outputPath: join(sandbox, 'out.json'),
    });
    expect(result.content).toContain('out.json');
    const written = JSON.parse(readFileSync(join(sandbox, 'out.json'), 'utf-8'));
    expect(written.ok).toBe(true);
  });

  it('refuses outputPath when no disk config is present', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'g', code: 'return 1' });
    const result = await getTool(agent, 'script_run').execute({ name: 'g', input: null, outputPath: 'out.json' });
    expect(result.content).toContain('Disk path output is not configured');
  });

  it('listScripts skips corrupt registry files', async () => {
    const ext = makeExt();
    writeFileSync(join(registry, 'broken.json'), '{ not valid json');
    writeFileSync(join(registry, 'good.json'), JSON.stringify({ name: 'good', description: '', code: 'return 1', createdAt: 't', updatedAt: 't' }));
    const list = ext.listScripts();
    expect(list.map((s) => s.name)).toEqual(['good']);
  });

  // ── save error + error rendering ───────────────────────────────────────

  it('script_save reports an error for a name that sanitizes to empty', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    const result = await getTool(agent, 'script_save').execute({ name: '!!!', code: 'return 1' });
    expect(result.content).toContain('Error:');
    expect(result.content).toContain('empty after sanitization');
  });

  it('renders a thrown plain object with a message', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'obj', code: 'throw { message: "obj-err" }' });
    const result = await getTool(agent, 'script_run').execute({ name: 'obj', input: null });
    expect(result.content).toContain('obj-err');
  });

  it('renders a thrown plain object without a message', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'obj2', code: 'throw { code: 42 }' });
    const result = await getTool(agent, 'script_run').execute({ name: 'obj2', input: null });
    expect(result.content).toContain('ERROR');
    expect(result.content).toContain('42');
  });

  it('renders a thrown string', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'str', code: 'throw "string-err"' });
    const result = await getTool(agent, 'script_run').execute({ name: 'str', input: null });
    expect(result.content).toContain('string-err');
  });

  // ── Pipeline ───────────────────────────────────────────────────────────

  async function setupPipelineScripts(agent: Agent) {
    await getTool(agent, 'script_save').execute({
      name: 'extract',
      code: 'return input.items.map(x => x.value)',
    });
    await getTool(agent, 'script_save').execute({
      name: 'sum',
      code: 'return input.reduce((a, b) => a + b, 0)',
    });
    await getTool(agent, 'script_save').execute({
      name: 'label',
      code: 'return { total: input, label: "sum=" + input }',
    });
  }

  it('chains script outputs through a pipeline', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await setupPipelineScripts(agent);
    const result = await getTool(agent, 'script_pipeline').execute({
      stages: ['extract', 'sum', 'label'],
      input: { items: [{ value: 1 }, { value: 2 }, { value: 3 }] },
    });
    expect(result.content).toContain('Pipeline OK');
    expect(result.content).toContain('[1] extract: OK');
    expect(result.content).toContain('[2] sum: OK');
    expect(result.content).toContain('[3] label: OK');
    expect(result.content).toContain('"total": 6');
    expect(result.content).toContain('"label": "sum=6"');
  });

  it('runs a single-stage pipeline', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'double', code: 'return input * 2' });
    const result = await getTool(agent, 'script_pipeline').execute({
      stages: ['double'],
      input: 21,
    });
    expect(result.content).toContain('Pipeline OK');
    expect(result.content).toContain('42');
  });

  it('stops the pipeline when a stage fails', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'ok', code: 'return input + 1' });
    await getTool(agent, 'script_save').execute({ name: 'boom', code: 'throw new Error("stage-2-fail")' });
    await getTool(agent, 'script_save').execute({ name: 'never', code: 'return input' });
    const result = await getTool(agent, 'script_pipeline').execute({
      stages: ['ok', 'boom', 'never'],
      input: 0,
    });
    expect(result.content).toContain('Pipeline ERROR');
    expect(result.content).toContain('[1] ok: OK');
    expect(result.content).toContain('[2] boom: FAIL');
    expect(result.content).toContain('stage-2-fail');
    // Third stage should not appear.
    expect(result.content).not.toContain('[3] never');
  });

  it('stops when a stage script is not found', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'ok', code: 'return input' });
    const result = await getTool(agent, 'script_pipeline').execute({
      stages: ['ok', 'missing'],
      input: 1,
    });
    expect(result.content).toContain('Pipeline ERROR');
    expect(result.content).toContain('[2] missing: FAIL');
    expect(result.content).toContain('Script not found');
  });

  it('rejects an empty stages array', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    const result = await getTool(agent, 'script_pipeline').execute({ stages: [], input: 1 });
    expect(result.content).toContain('stages must be a non-empty array');
  });

  it('reads pipeline input from disk via inputPath', async () => {
    const fs = makeFakeFs(sandbox);
    const ext = makeExt({ fs, allowedFsDirs: ['data'] });
    const agent = makeAgent();
    agent.use(ext);
    writeFileSync(join(sandbox, 'in.json'), JSON.stringify({ n: 10 }));
    await getTool(agent, 'script_save').execute({ name: 'add5', code: 'return input.n + 5' });
    await getTool(agent, 'script_save').execute({ name: 'square', code: 'return input * input' });
    const result = await getTool(agent, 'script_pipeline').execute({
      stages: ['add5', 'square'],
      inputPath: 'data/in.json',
    });
    expect(result.content).toContain('Pipeline OK');
    // 10 + 5 = 15, 15 * 15 = 225
    expect(result.content).toContain('225');
  });

  it('writes pipeline final output to outputPath', async () => {
    const fs = makeFakeFs(sandbox);
    const ext = makeExt({ fs, allowedFsDirs: ['data'] });
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'inc', code: 'return input + 1' });
    await getTool(agent, 'script_save').execute({ name: 'str', code: 'return "v=" + input' });
    const result = await getTool(agent, 'script_pipeline').execute({
      stages: ['inc', 'str'],
      input: 41,
      outputPath: 'data/pipe-out.json',
    });
    expect(result.content).toContain('data/pipe-out.json');
    const written = JSON.parse(readFileSync(join(sandbox, 'pipe-out.json'), 'utf-8'));
    expect(written).toBe('v=42');
  });

  it('exposes runPipeline on the extension object', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await setupPipelineScripts(agent);
    const res = await ext.runPipeline(
      ['extract', 'sum', 'label'],
      { items: [{ value: 10 }, { value: 20 }] },
    );
    expect(res.ok).toBe(true);
    expect(res.stages).toHaveLength(3);
    expect(res.stages[0].name).toBe('extract');
    expect(res.stages[2].name).toBe('label');
    expect(res.output).toContain('"total": 30');
  });

  it('runPipeline returns per-stage results on failure', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    await getTool(agent, 'script_save').execute({ name: 'a', code: 'return input' });
    await getTool(agent, 'script_save').execute({ name: 'b', code: 'throw "boom"' });
    const res = await ext.runPipeline(['a', 'b'], 1);
    expect(res.ok).toBe(false);
    expect(res.stages).toHaveLength(2);
    expect(res.stages[0].ok).toBe(true);
    expect(res.stages[1].ok).toBe(false);
    expect(res.stages[1].error).toBe('boom');
  });

  it('stages are isolated — a stage cannot see variables from a prior stage', async () => {
    const ext = makeExt();
    const agent = makeAgent();
    agent.use(ext);
    // Stage 1 declares a variable; stage 2 tries to use it.
    await getTool(agent, 'script_save').execute({ name: 'declare', code: 'var secret = 42; return input' });
    await getTool(agent, 'script_save').execute({ name: 'access', code: 'return typeof secret' });
    const result = await getTool(agent, 'script_pipeline').execute({
      stages: ['declare', 'access'],
      input: null,
    });
    expect(result.content).toContain('Pipeline OK');
    // `secret` is undefined in stage 2 — each stage is a fresh eval.
    expect(result.content).toContain('undefined');
  });
});
