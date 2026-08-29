import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import type { Extension } from '../../../extension.js';

// ── QuickJS types (minimal, to avoid a hard import at type-check time) ──────
// quickjs-emscripten is an optional peer dependency. We dynamic-import it at
// runtime so the extension only loads the WASM runtime when actually used.
interface QuickJSModule {
  evalCode(
    code: string,
    options?: {
      memoryLimitBytes?: number;
      shouldInterrupt?: () => boolean;
    },
  ): unknown;
}

let quickjsPromise: Promise<QuickJSModule> | undefined;

/**
 * Lazily load the QuickJS WASM runtime. The module is cached for the
 * lifetime of the process. Throws if `quickjs-emscripten` is not
 * installed — it's an optional peer dependency.
 */
async function getQuickJS(): Promise<QuickJSModule> {
  if (!quickjsPromise) {
    quickjsPromise = import('quickjs-emscripten').then((mod) => {
      const get = (mod as { getQuickJS: () => Promise<QuickJSModule> }).getQuickJS;
      if (typeof get !== 'function') {
        throw new Error(
          "quickjs-emscripten is installed but has no getQuickJS export. Install 'quickjs-emscripten' (^0.32).",
        );
      }
      return get();
    });
  }
  return quickjsPromise;
}

/**
 * Build a deadline-based interrupt checker. Equivalent to
 * quickjs-emscripten's `shouldInterruptAfterDeadline`, implemented
 * locally to avoid an extra import.
 */
function shouldInterruptAfterDeadline(deadline: number): () => boolean {
  return () => Date.now() > deadline;
}

// ── Registry record ─────────────────────────────────────────────────────────

/**
 * A registered data-processing script, persisted to disk.
 */
export interface ScriptRecord {
  /** Unique script name (also the on-disk filename stem). */
  name: string;
  /** Human-readable description of what the script does. */
  description: string;
  /** JavaScript source — the body of a function that receives `input`. */
  code: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
}

/**
 * Result of running a script.
 */
export interface ScriptRunResult {
  /** Whether execution succeeded. */
  ok: boolean;
  /** The script's return value (JSON-serialized), or an error message. */
  output: string;
  /** Elapsed wall-clock time in milliseconds. */
  elapsedMs: number;
  /** When `outputPath` was used, the path the result was written to. */
  outputPath?: string;
}

/**
 * Result of a single stage within a pipeline run.
 */
export interface PipelineStageResult {
  /** Script name for this stage. */
  name: string;
  /** Whether this stage succeeded. */
  ok: boolean;
  /** Elapsed wall-clock time in milliseconds. */
  elapsedMs: number;
  /** Inline output preview (truncated to `maxOutputChars`). */
  output: string;
  /** Error message when `ok` is false. */
  error?: string;
}

/**
 * Result of running a pipeline of scripts.
 *
 * Each stage receives the previous stage's return value as its `input`.
 * If any stage fails, the pipeline stops — `ok` is false and `output`
 * contains the error from the failing stage. `stages` always contains
 * one entry per stage that was attempted.
 */
export interface PipelineResult {
  /** Whether every stage succeeded. */
  ok: boolean;
  /** Final output (JSON-serialized), or the error from the failed stage. */
  output: string;
  /** Total elapsed wall-clock time in milliseconds. */
  elapsedMs: number;
  /** Per-stage results, in execution order. */
  stages: PipelineStageResult[];
  /** When `outputPath` was used, the path the final result was written to. */
  outputPath?: string;
}

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * Filesystem helper surface the scripts extension reuses. This matches
 * the shape exposed by the `filesystem` extension, so the same sandboxed
 * directories used by the filesystem and slack-files extensions can be
 * used to pass data to/from scripts by disk path.
 */
export interface FsHelper {
  /** Resolve a sandbox-relative path to an absolute path (throws on traversal). */
  resolvePath(path: string): string;
  /** Save raw bytes to a sandbox. Returns the full sandbox-prefixed path. */
  saveBytes(path: string, data: Buffer, mimetype?: string): string;
}

/**
 * Configuration for {@link createScriptsExtension}.
 */
export interface ScriptsConfig {
  /**
   * Directory where registered scripts are persisted (one JSON file per
   * script). Created if it doesn't exist. Required.
   */
  registryDir: string;
  /**
   * The filesystem extension helper, to allow scripts to read input
   * from and write output to the sandboxed directories. When provided,
   * {@link allowedFsDirs} gates which sandbox directory names may be
   * used for `inputPath` / `outputPath`.
   */
  fs?: FsHelper;
  /**
   * Sandbox directory names (as configured on the filesystem extension)
   * that scripts are allowed to read from / write to via `inputPath` /
   * `outputPath`. Required when `fs` is provided and disk paths are
   * used. Example: `['slack-files', 'documents']`.
   */
  allowedFsDirs?: string[];
  /**
   * Absolute parent paths allowed for direct disk reads/writes when no
   * `fs` helper is configured. Paths supplied via `inputPath` /
   * `outputPath` must resolve within one of these. Use this for
   * standalone deployments without the filesystem extension.
   */
  allowedDirs?: string[];
  /**
   * Max size of an input file read from disk (bytes). Default: 10MB.
   */
  maxInputBytes?: number;
  /**
   * Max chars of script output returned inline to the agent. Output
   * longer than this is truncated (and, if `outputPath` is given,
   * written to disk in full). Default: 50000.
   */
  maxOutputChars?: number;
  /**
   * QuickJS memory limit in bytes. Default: 128MB.
   */
  memoryLimitBytes?: number;
  /**
   * Execution deadline in milliseconds. Scripts that run longer are
   * interrupted. Default: 5000.
   */
  interruptMs?: number;
  /**
   * Tool name prefix. Default: 'script'.
   */
  toolPrefix?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Sanitize a script name into a safe filename stem. */
function safeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned) throw new Error(`Script name "${name}" is empty after sanitization`);
  return cleaned;
}

/** Read a script record from disk, or return undefined. */
function readScript(registryDir: string, name: string): ScriptRecord | undefined {
  const path = join(registryDir, `${safeName(name)}.json`);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as ScriptRecord;
}

/** Write a script record to disk. */
function writeScript(registryDir: string, record: ScriptRecord): void {
  const path = join(registryDir, `${safeName(record.name)}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2), 'utf-8');
}

/** Extract the sandbox directory name prefix from a sandbox-relative path. */
function fsDirOf(path: string): string {
  const sep = path.indexOf('/');
  return sep === -1 ? path : path.slice(0, sep);
}

/**
 * Resolve a sandbox-relative path via the fs helper, verifying the
 * sandbox directory is in the allowlist.
 */
function resolveFsPath(
  userPath: string,
  fs: FsHelper,
  allowedFsDirs: string[],
): string {
  const dirName = fsDirOf(userPath);
  if (!allowedFsDirs.includes(dirName)) {
    throw new Error(
      `Sandbox directory "${dirName}" is not allowed for scripts. Allowed: ${allowedFsDirs.map((d) => `"${d}"`).join(', ') || '(none)'}`,
    );
  }
  return fs.resolvePath(userPath);
}

/**
 * Resolve an absolute path against the standalone allowlist, verifying
 * it stays within an allowed parent.
 */
function resolveStandalonePath(userPath: string, allowedDirs: string[]): string {
  const abs = resolve(userPath);
  for (const dir of allowedDirs) {
    const absDir = resolve(dir);
    const rel = relative(absDir, abs);
    // Inside if rel is non-empty and doesn't escape upward.
    if (rel && !rel.startsWith('..') && resolve(rel) !== rel) return abs;
  }
  throw new Error(
    `Path "${userPath}" is not within an allowed directory. Allowed: ${allowedDirs.map((d) => `"${d}"`).join(', ') || '(none)'}`,
  );
}

/** Try to parse a string as JSON; fall back to the raw string. */
function parseInput(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed[0] === '{' || trimmed[0] === '[' || trimmed[0] === '"' || trimmed[0] === '-' || /\d/.test(trimmed[0])) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * Render a thrown value into a readable string. QuickJS evalCode throws
 * the native JS representation of the sandbox's thrown value, which may
 * be an Error, a string, or a plain object (e.g. `{ message: '...' }`).
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

// ── Extension factory ───────────────────────────────────────────────────────

/**
 * Create a scripts extension that implements a durable, on-disk script
 * registry and a focused tool interface for agents to write their own
 * data-processing scripts.
 *
 * Scripts are JavaScript functions (written as the function body) that
 * receive an `input` value and return a JSON-serializable result. They
 * are executed in a sandboxed QuickJS WASM runtime with a memory limit
 * and execution deadline, so agent-authored code cannot access the
 * host process, filesystem, or network.
 *
 * Data can be passed to a script either:
 * - inline, via the `input` argument (any JSON value), or
 * - by disk path, via `inputPath` (the file is read and parsed).
 *
 * Disk path access is gated by an allowlist. When the `filesystem`
 * extension is provided via {@link ScriptsConfig.fs}, paths are
 * sandbox-relative (e.g. `"slack-files/data.json"`) and only the
 * sandbox directory names listed in {@link ScriptsConfig.allowedFsDirs}
 * are permitted — the same sandboxes the filesystem and slack-files
 * extensions use. Without `fs`, {@link ScriptsConfig.allowedDirs}
 * gates absolute parent paths.
 *
 * Scripts are persisted as JSON files under {@link ScriptsConfig.registryDir}
 * and survive across sessions and process restarts.
 *
 * Tools provided (prefix defaults to `script`):
 * - `script_save` — create or update a named script
 * - `script_list` — list registered scripts
 * - `script_get` — view a script's source and description
 * - `script_delete` — remove a script
 * - `script_run` — execute a script by name with inline or disk input
 * - `script_pipeline` — run a chain of scripts, feeding each stage's
 *   output into the next stage's input
 */
export default function createScriptsExtension(
  config: ScriptsConfig,
): Extension & {
  /** Run a registered script by name with a given input value. */
  runScript(name: string, input: unknown, opts?: { outputPath?: string }): Promise<ScriptRunResult>;
  /** Run a pipeline of scripts, chaining each stage's output to the next. */
  runPipeline(stages: string[], input: unknown, opts?: { outputPath?: string }): Promise<PipelineResult>;
  /** Read a script record from the registry. */
  getScript(name: string): ScriptRecord | undefined;
  /** List all registered scripts. */
  listScripts(): ScriptRecord[];
} {
  const registryDir = resolve(config.registryDir);
  if (!existsSync(registryDir)) mkdirSync(registryDir, { recursive: true });

  const prefix = config.toolPrefix ?? 'script';
  const maxInputBytes = config.maxInputBytes ?? 10 * 1024 * 1024;
  const maxOutputChars = config.maxOutputChars ?? 50_000;
  const memoryLimitBytes = config.memoryLimitBytes ?? 128 * 1024 * 1024;
  const interruptMs = config.interruptMs ?? 5_000;
  const fs = config.fs;
  const allowedFsDirs = config.allowedFsDirs ?? [];
  const allowedDirs = config.allowedDirs ?? [];

  // ── Disk I/O helpers ────────────────────────────────────────────────────
  function readInputPath(inputPath: string): unknown {
    let abs: string;
    if (fs) {
      abs = resolveFsPath(inputPath, fs, allowedFsDirs);
    } else if (allowedDirs.length > 0) {
      abs = resolveStandalonePath(inputPath, allowedDirs);
    } else {
      throw new Error(
        'Disk path input is not configured. Provide `fs` with `allowedFsDirs`, or `allowedDirs`.',
      );
    }
    if (!existsSync(abs)) throw new Error(`Input file not found: ${inputPath}`);
    const stat = statSync(abs);
    if (stat.isDirectory()) throw new Error(`Input path is a directory: ${inputPath}`);
    if (stat.size > maxInputBytes) {
      throw new Error(`Input file too large (${stat.size} bytes, max ${maxInputBytes}): ${inputPath}`);
    }
    const raw = readFileSync(abs, 'utf-8');
    return parseInput(raw);
  }

  function writeOutputPath(outputPath: string, json: string): string {
    const buf = Buffer.from(json, 'utf-8');
    if (fs) {
      // saveBytes creates parent dirs and returns the sandbox-prefixed path.
      return fs.saveBytes(outputPath, buf, 'application/json');
    }
    if (allowedDirs.length > 0) {
      const abs = resolveStandalonePath(outputPath, allowedDirs);
      const dir = dirname(abs);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(abs, buf);
      return outputPath;
    }
    throw new Error(
      'Disk path output is not configured. Provide `fs` with `allowedFsDirs`, or `allowedDirs`.',
    );
  }

  // ── Core execution ──────────────────────────────────────────────────────
  async function executeCode(code: string, input: unknown): Promise<unknown> {
    const QuickJS = await getQuickJS();
    // Wrap the agent-authored body as a function that receives `input`.
    // The input is embedded as a JSON literal so the sandbox has no
    // reference to host objects.
    const wrapped = `((input) => {\n${code}\n})(${JSON.stringify(input)})`;
    return QuickJS.evalCode(wrapped, {
      memoryLimitBytes,
      shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + interruptMs),
    });
  }

  async function runScript(
    name: string,
    input: unknown,
    opts?: { outputPath?: string },
  ): Promise<ScriptRunResult> {
    const record = readScript(registryDir, name);
    if (!record) {
      return { ok: false, output: `Script not found: ${name}`, elapsedMs: 0 };
    }
    const start = Date.now();
    try {
      const result = await executeCode(record.code, input);
      const json = JSON.stringify(result ?? null, null, 2);
      let outputPath: string | undefined;
      if (opts?.outputPath) {
        outputPath = writeOutputPath(opts.outputPath, json);
      }
      const inline =
        json.length > maxOutputChars
          ? json.slice(0, maxOutputChars) +
            `\n\n[truncated — ${json.length} chars total${outputPath ? `, full output at ${outputPath}` : ''}]`
          : json;
      return { ok: true, output: inline, elapsedMs: Date.now() - start, outputPath };
    } catch (err) {
      return {
        ok: false,
        output: describeError(err),
        elapsedMs: Date.now() - start,
      };
    }
  }

  /**
   * Run a pipeline of scripts. Each stage receives the previous stage's
   * return value (as a native JS value) as its `input`. The first stage
   * receives the initial `input`. If a stage fails, the pipeline stops
   * and the error is reported.
   *
   * Each stage runs in its own isolated QuickJS eval — stages cannot
   * share state except through the chained value.
   */
  async function runPipeline(
    stages: string[],
    input: unknown,
    opts?: { outputPath?: string },
  ): Promise<PipelineResult> {
    const start = Date.now();
    const stageResults: PipelineStageResult[] = [];
    let current: unknown = input;

    for (const name of stages) {
      const record = readScript(registryDir, name);
      if (!record) {
        stageResults.push({
          name,
          ok: false,
          elapsedMs: 0,
          output: '',
          error: `Script not found: ${name}`,
        });
        return {
          ok: false,
          output: `Pipeline stopped at stage "${name}": Script not found`,
          elapsedMs: Date.now() - start,
          stages: stageResults,
        };
      }

      const stageStart = Date.now();
      try {
        const value = await executeCode(record.code, current);
        const json = JSON.stringify(value ?? null, null, 2);
        const preview =
          json.length > maxOutputChars
            ? json.slice(0, maxOutputChars) + `\n\n[truncated — ${json.length} chars]`
            : json;
        stageResults.push({
          name,
          ok: true,
          elapsedMs: Date.now() - stageStart,
          output: preview,
        });
        // Chain the native value to the next stage.
        current = value ?? null;
      } catch (err) {
        const msg = describeError(err);
        stageResults.push({
          name,
          ok: false,
          elapsedMs: Date.now() - stageStart,
          output: '',
          error: msg,
        });
        return {
          ok: false,
          output: `Pipeline stopped at stage "${name}": ${msg}`,
          elapsedMs: Date.now() - start,
          stages: stageResults,
        };
      }
    }

    // All stages succeeded — serialize the final value.
    const finalJson = JSON.stringify(current, null, 2);
    let outputPath: string | undefined;
    if (opts?.outputPath) {
      try {
        outputPath = writeOutputPath(opts.outputPath, finalJson);
      } catch (err) {
        return {
          ok: false,
          output: `Pipeline succeeded but output write failed: ${describeError(err)}`,
          elapsedMs: Date.now() - start,
          stages: stageResults,
        };
      }
    }
    const inline =
      finalJson.length > maxOutputChars
        ? finalJson.slice(0, maxOutputChars) +
          `\n\n[truncated — ${finalJson.length} chars total${outputPath ? `, full output at ${outputPath}` : ''}]`
        : finalJson;
    return {
      ok: true,
      output: inline,
      elapsedMs: Date.now() - start,
      stages: stageResults,
      outputPath,
    };
  }

  function getScript(name: string): ScriptRecord | undefined {
    return readScript(registryDir, name);
  }

  function listScripts(): ScriptRecord[] {
    if (!existsSync(registryDir)) return [];
    return readdirSync(registryDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(registryDir, f), 'utf-8')) as ScriptRecord;
        } catch {
          return undefined;
        }
      })
      .filter((r): r is ScriptRecord => r !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Build a description of the available disk-path options for tool docs.
  const diskDesc = fs
    ? `Disk paths are sandbox-relative (e.g. "${allowedFsDirs[0] ?? 'sandbox'}/data.json") and limited to: ${allowedFsDirs.map((d) => `"${d}"`).join(', ') || '(none configured)'}.`
    : allowedDirs.length > 0
      ? `Disk paths must resolve within: ${allowedDirs.map((d) => `"${d}"`).join(', ')}.`
      : 'Disk paths are not configured — pass data inline via `input`.';

  return {
    name: 'scripts',
    priority: 50,
    runScript,
    runPipeline,
    getScript,
    listScripts,

    install(agent) {
      // ── script_save ──────────────────────────────────────────────────────
      agent.tool({
        name: `${prefix}_save`,
        description:
          'Create or update a named data-processing script. The script is JavaScript ' +
          'written as the BODY of a function that receives `input` and returns a ' +
          'JSON-serializable result. It runs in a sandboxed QuickJS runtime (no fs, ' +
          'network, or host access). Scripts are persisted to disk and can be reused ' +
          'across sessions. Use `return <value>` to produce output.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Unique script name (letters, numbers, ., -, _). Used to run it later.',
            },
            description: {
              type: 'string',
              description: 'Short description of what the script does and what input it expects.',
            },
            code: {
              type: 'string',
              description:
                'JavaScript function body. Receives `input` (the parsed input value). ' +
                'Example: `return input.items.filter(x => x.active).map(x => x.name)`',
            },
          },
          required: ['name', 'code'],
        },
        async execute(args) {
          const name = String(args.name ?? '');
          const description = String(args.description ?? '');
          const code = String(args.code ?? '');
          if (!name.trim()) return { toolCallId: '', content: 'Error: name is required' };
          if (!code.trim()) return { toolCallId: '', content: 'Error: code is required' };

          try {
            const existing = readScript(registryDir, name);
            const now = new Date().toISOString();
            const createdAt = existing?.createdAt ?? now;
            // Ensure updatedAt differs from createdAt even when saves happen
            // within the same millisecond.
            const updatedAt = createdAt === now ? new Date(Date.now() + 1).toISOString() : now;
            const record: ScriptRecord = {
              name,
              description: description || existing?.description || '',
              code,
              createdAt,
              updatedAt,
            };
            writeScript(registryDir, record);
            console.log(`[scripts] saved "${name}" (${code.length} chars)`);
            return {
              toolCallId: '',
              content: `Saved script "${name}" (${existing ? 'updated' : 'created'}, ${code.length} chars). Run it with ${prefix}_run.`,
            };
          } catch (err) {
            return { toolCallId: '', content: `Error: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      });

      // ── script_list ──────────────────────────────────────────────────────
      agent.tool({
        name: `${prefix}_list`,
        description: 'List all registered data-processing scripts in the registry.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          const scripts = listScripts();
          if (scripts.length === 0) {
            return { toolCallId: '', content: 'No scripts registered. Use script_save to create one.' };
          }
          const lines = scripts.map((s) => {
            const desc = s.description ? ` — ${s.description}` : '';
            return `  ${s.name}${desc} (updated ${s.updatedAt})`;
          });
          return { toolCallId: '', content: `Registered scripts (${scripts.length}):\n${lines.join('\n')}` };
        },
      });

      // ── script_get ───────────────────────────────────────────────────────
      agent.tool({
        name: `${prefix}_get`,
        description: 'View the source code and description of a registered script.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Script name' },
          },
          required: ['name'],
        },
        async execute(args) {
          const name = String(args.name ?? '');
          const record = readScript(registryDir, name);
          if (!record) return { toolCallId: '', content: `Script not found: ${name}` };
          return {
            toolCallId: '',
            content:
              `Script: ${record.name}\n` +
              `Description: ${record.description || '(none)'}\n` +
              `Created: ${record.createdAt}\n` +
              `Updated: ${record.updatedAt}\n\n` +
              `--- code ---\n${record.code}\n--- end ---`,
          };
        },
      });

      // ── script_delete ────────────────────────────────────────────────────
      agent.tool({
        name: `${prefix}_delete`,
        description: 'Delete a registered script from the registry.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Script name' },
          },
          required: ['name'],
        },
        async execute(args) {
          const name = String(args.name ?? '');
          const path = join(registryDir, `${safeName(name)}.json`);
          if (!existsSync(path)) return { toolCallId: '', content: `Script not found: ${name}` };
          unlinkSync(path);
          console.log(`[scripts] deleted "${name}"`);
          return { toolCallId: '', content: `Deleted script: ${name}` };
        },
      });

      // ── script_run ───────────────────────────────────────────────────────
      agent.tool({
        name: `${prefix}_run`,
        description:
          'Execute a registered script by name. Pass data inline via `input` (any JSON ' +
          'value) or via `inputPath` (a disk path that is read and parsed as JSON). ' +
          diskDesc +
          ' Optionally write the full result to `outputPath` instead of returning it inline.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Script name to run' },
            input: {
              description:
                'Inline input value passed to the script as `input`. Any JSON value ' +
                '(object, array, string, number, boolean). Use this or `inputPath`.',
            },
            inputPath: {
              type: 'string',
              description: 'Disk path to read input from (parsed as JSON, or raw string).',
            },
            outputPath: {
              type: 'string',
              description: 'Optional disk path to write the full JSON result to.',
            },
          },
          required: ['name'],
        },
        async execute(args) {
          const name = String(args.name ?? '');
          const outputPath = args.outputPath ? String(args.outputPath) : undefined;

          let input: unknown;
          try {
            if (args.inputPath) {
              input = readInputPath(String(args.inputPath));
            } else if (args.input !== undefined) {
              input = args.input;
            } else {
              input = null;
            }
          } catch (err) {
            return { toolCallId: '', content: `Error reading input: ${err instanceof Error ? err.message : String(err)}` };
          }

          const result = await runScript(name, input, outputPath ? { outputPath } : undefined);
          const status = result.ok ? 'OK' : 'ERROR';
          const head = `Script "${name}" ${status} (${result.elapsedMs}ms)${result.outputPath ? ` → ${result.outputPath}` : ''}`;
          return { toolCallId: '', content: `${head}\n${result.output}` };
        },
      });

      // ── script_pipeline ─────────────────────────────────────────────────
      agent.tool({
        name: `${prefix}_pipeline`,
        description:
          'Run a chain of registered scripts in sequence. Each stage receives the ' +
          'previous stage\'s return value as its `input` (the first stage gets the ' +
          'initial `input` or `inputPath` value). If any stage fails, the pipeline ' +
          'stops and reports which stage failed. Each stage runs in its own isolated ' +
          'sandbox — stages share state only through the chained value. ' +
          diskDesc +
          ' Optionally write the final result to `outputPath`.',
        parameters: {
          type: 'object',
          properties: {
            stages: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Ordered list of script names to run. Stage 1 output → stage 2 input, etc.',
            },
            input: {
              description:
                'Initial input value for the first stage (any JSON value). ' +
                'Use this or `inputPath`.',
            },
            inputPath: {
              type: 'string',
              description: 'Disk path to read the initial input from (parsed as JSON).',
            },
            outputPath: {
              type: 'string',
              description: 'Optional disk path to write the final JSON result to.',
            },
          },
          required: ['stages'],
        },
        async execute(args) {
          const stages = Array.isArray(args.stages)
            ? args.stages.map((s) => String(s))
            : [];
          if (stages.length === 0) {
            return { toolCallId: '', content: 'Error: stages must be a non-empty array of script names' };
          }
          const outputPath = args.outputPath ? String(args.outputPath) : undefined;

          let input: unknown;
          try {
            if (args.inputPath) {
              input = readInputPath(String(args.inputPath));
            } else if (args.input !== undefined) {
              input = args.input;
            } else {
              input = null;
            }
          } catch (err) {
            return { toolCallId: '', content: `Error reading input: ${err instanceof Error ? err.message : String(err)}` };
          }

          const result = await runPipeline(stages, input, outputPath ? { outputPath } : undefined);

          // Build a per-stage summary so the agent can see the flow.
          const stageLines = result.stages.map((s, i) => {
            const status = s.ok ? 'OK' : 'FAIL';
            const err = s.error ? ` — ${s.error}` : '';
            return `  [${i + 1}] ${s.name}: ${status} (${s.elapsedMs}ms)${err}`;
          });
          const status = result.ok ? 'OK' : 'ERROR';
          const head =
            `Pipeline ${status} (${result.elapsedMs}ms, ${result.stages.length} stage(s))` +
            `${result.outputPath ? ` → ${result.outputPath}` : ''}\n` +
            stageLines.join('\n') +
            `\n--- final output ---`;
          return { toolCallId: '', content: `${head}\n${result.output}` };
        },
      });
    },
  };
}
