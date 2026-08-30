import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { makeToolName } from './shared.js';
import type { Tool } from '../../../../tool.js';

// ── Shell registry ───────────────────────────────────────────────────
// Lives at the extension level so backgrounded shells survive across
// turns within the same agent. When a shell is backgrounded (detached),
// its metadata is persisted to disk so it can be reconnected by a
// future agent instance (e.g. a later `lc` invocation).

export interface ShellEntry {
  id: string;
  process?: ChildProcess;   // undefined for reconnected (cross-process) shells
  pid: number;
  output: string;
  done: boolean;
  exitCode: number | null;
  startedAt: number;
  command: string;
  cwd: string;
  outputFile?: string;      // path to detached output file (if backgrounded)
  detached: boolean;        // true if the process was detached from the parent
}

// ── Persisted shell metadata ─────────────────────────────────────────
interface ShellMeta {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  startedAt: number;
  outputFile: string;
}

export class ShellRegistry {
  private shells = new Map<string, ShellEntry>();
  private counter = 0;
  private shellsDir: string;

  constructor(shellsDir?: string) {
    this.shellsDir = shellsDir ?? join(process.cwd(), '.libra-shells');
  }

  private nextId(): string {
    return `shell_${++this.counter}`;
  }

  private metaPath(id: string): string {
    return join(this.shellsDir, `${id}.json`);
  }

  /**
   * Create a foreground shell (pipes connected, parent waits).
   * If background is true, the process is detached and output goes
   * to a file. Metadata is persisted to disk so a future process
   * can reconnect.
   */
  create(command: string, cwd: string, env: Record<string, string>, background: boolean): ShellEntry {
    const id = this.nextId();
    const shellsDir = this.shellsDir;

    if (background) {
      // ── Detached: output to file at OS level, process survives parent exit ──
      // The child's stdout/stderr are connected directly to a file via
      // file descriptors, not Node pipes. This means output continues
      // flowing to the file even after the parent process exits.
      //
      // A wrapper shell command records the exit code to a file after
      // the command finishes, so a future process can see whether it
      // succeeded — without relying on the parent's event handlers.
      mkdirSync(shellsDir, { recursive: true });
      const outputFile = join(shellsDir, `${id}.output`);
      const exitFile = join(shellsDir, `${id}.exit`);
      const metaFile = this.metaPath(id);

      // Create the output file so it exists even if the command produces no output.
      writeFileSync(outputFile, '');

      // Wrap the command so the exit code is recorded to a file.
      // The wrapper runs in the detached shell, not in Node.
      const wrappedCommand = `${command}; echo $? > "${exitFile}" 2>/dev/null`;

      // Open file descriptors for stdout/stderr redirection.
      const outFd = openSync(outputFile, 'a');
      const errFd = outFd;

      const child = spawn(wrappedCommand, {
        shell: true,
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', outFd, errFd],
        detached: true,
      });

      closeSync(outFd);

      const entry: ShellEntry = {
        id,
        process: child,
        pid: child.pid ?? -1,
        output: '',
        done: false,
        exitCode: null,
        startedAt: Date.now(),
        command,
        cwd,
        outputFile,
        detached: true,
      };

      // While the parent is alive, track exit for in-memory queries.
      child.on('exit', (code) => {
        entry.done = true;
        entry.exitCode = code;
      });
      child.on('error', (err) => {
        try { appendFileSync(outputFile, `\nError: ${err.message}\n`); } catch {}
        entry.done = true;
        entry.exitCode = -1;
      });

      child.unref();

      const meta: ShellMeta = {
        id,
        pid: child.pid ?? -1,
        command,
        cwd,
        startedAt: entry.startedAt,
        outputFile,
      };
      try { writeFileSync(metaFile, JSON.stringify(meta, null, 2)); } catch {}

      this.shells.set(id, entry);
      return entry;
    }

    // ── Foreground: pipes connected, parent owns the process ──
    const child = spawn(command, {
      shell: true,
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const entry: ShellEntry = {
      id,
      process: child,
      pid: child.pid ?? -1,
      output: '',
      done: false,
      exitCode: null,
      startedAt: Date.now(),
      command,
      cwd,
      detached: false,
    };

    child.stdout?.on('data', (data: Buffer) => {
      entry.output += data.toString();
    });
    child.stderr?.on('data', (data: Buffer) => {
      entry.output += data.toString();
    });
    child.on('exit', (code) => {
      entry.done = true;
      entry.exitCode = code;
    });
    child.on('error', (err) => {
      entry.output += `\nError: ${err.message}\n`;
      entry.done = true;
      entry.exitCode = -1;
    });

    this.shells.set(id, entry);
    return entry;
  }

  /**
   * Get a shell by ID. If it's not in the in-memory map, try to
   * reconnect from persisted metadata on disk.
   */
  get(id: string): ShellEntry | undefined {
    const cached = this.shells.get(id);
    if (cached) return cached;

    // Try to reconnect from disk.
    const metaFile = this.metaPath(id);
    if (!existsSync(metaFile)) return undefined;

    try {
      const meta = JSON.parse(readFileSync(metaFile, 'utf-8')) as ShellMeta;
      const outputFile = meta.outputFile;
      const exitFile = join(this.shellsDir, `${id}.exit`);

      // Check if the process is still alive (signal 0 = probe).
      let alive = false;
      try {
        process.kill(meta.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }

      // Read accumulated output from file.
      let output = '';
      if (existsSync(outputFile)) {
        output = readFileSync(outputFile, 'utf-8');
      }

      // Check if exit code was recorded.
      let exitCode: number | null = null;
      let done = false;
      if (existsSync(exitFile)) {
        exitCode = Number(readFileSync(exitFile, 'utf-8').trim());
        done = true;
      } else if (!alive) {
        // Process died without recording exit code.
        done = true;
        exitCode = -1;
      }

      const entry: ShellEntry = {
        id,
        pid: meta.pid,
        output,
        done,
        exitCode,
        startedAt: meta.startedAt,
        command: meta.command,
        cwd: meta.cwd,
        outputFile,
        detached: true,
        // No process handle — can't write to stdin or use ChildProcess.kill.
      };

      this.shells.set(id, entry);
      return entry;
    } catch {
      return undefined;
    }
  }

  delete(id: string): boolean {
    const removed = this.shells.delete(id);

    // Clean up disk artifacts for detached shells.
    const metaFile = this.metaPath(id);
    const outputFile = join(this.shellsDir, `${id}.output`);
    const exitFile = join(this.shellsDir, `${id}.exit`);
    for (const f of [metaFile, outputFile, exitFile]) {
      try { unlinkSync(f); } catch {}
    }

    return removed;
  }

  /** Kill all in-memory backgrounded shells. Called on extension close. */
  close(): void {
    for (const [id, entry] of this.shells) {
      if (!entry.done && entry.process) {
        try {
          entry.process.kill('SIGKILL');
        } catch {
          // already dead
        }
      }
      // Detached shells survive — that's the point.
      // Only clean up disk artifacts for non-detached shells.
      if (!entry.detached) {
        this.delete(id);
      }
      this.shells.delete(id);
    }
  }
}

// ── Tool factories that accept a registry ────────────────────────────
export type ShellToolFactory = (cfg: { toolPrefix: string; registry: ShellRegistry }) => Tool;

// ── exec ─────────────────────────────────────────────────────────────
export const execTool: ShellToolFactory = (cfg) => ({
  name: makeToolName(cfg.toolPrefix, 'exec'),
  description:
    'Execute a shell command. By default, runs the command and waits for it to complete, ' +
    'returning stdout and stderr. Set timeout (ms) to limit execution time — if the command ' +
    'is still running when the timeout elapses, it is detached and backgrounded with a shell_id ' +
    'so you can retrieve output later with get_output. ' +
    'Set timeout to 0 to background immediately. ' +
    'Detached shells survive process exit — you can check on them in a later session. ' +
    'Commands run in the current working directory. Do not use this for file operations — ' +
    'use the dedicated file tools instead.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute.',
      },
      timeout: {
        type: 'integer',
        description: 'Timeout in milliseconds. Default: 30000 (30s). Set to 0 to background immediately.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the command. Default: current working directory.',
      },
      env: {
        type: 'object',
        description: 'Additional environment variables (merged with process.env).',
      },
    },
    required: ['command'],
  },
  async execute(args) {
    const command = String(args.command ?? '');
    if (!command) {
      return { toolCallId: '', content: 'Error: command is required' };
    }

    const timeout = Number(args.timeout ?? 30000);
    const cwd = String(args.cwd ?? process.cwd());
    const extraEnv = (args.env ?? {}) as Record<string, string>;

    // Background immediately — detach the process.
    if (timeout === 0) {
      const entry = cfg.registry.create(command, cwd, extraEnv, true);
      return {
        toolCallId: '',
        content: `Backgrounded: ${entry.id} (pid ${entry.pid})\nUse get_output with shell_id "${entry.id}" to read output, or kill_shell to terminate.`,
      };
    }

    // Foreground — wait for completion or timeout.
    const entry = cfg.registry.create(command, cwd, extraEnv, false);

    const elapsed = await new Promise<number>((resolve) => {
      const start = Date.now();
      const check = setInterval(() => {
        if (entry.done) {
          clearInterval(check);
          resolve(Date.now() - start);
        } else if (Date.now() - start >= timeout) {
          clearInterval(check);
          resolve(Date.now() - start);
        }
      }, 50);
    });

    if (entry.done) {
      const output = entry.output || '(no output)';
      const truncated = output.length > 50000
        ? output.slice(0, 50000) + '\n[output truncated]'
        : output;
      cfg.registry.delete(entry.id);
      return {
        toolCallId: '',
        content: `Exit code: ${entry.exitCode}\n${truncated}`,
      };
    }

    // Timed out — re-spawn as detached so it survives.
    // Kill the foreground process first.
    try { entry.process?.kill('SIGKILL'); } catch {}
    cfg.registry.delete(entry.id);

    // Re-create as detached, capturing output from the start.
    const bgEntry = cfg.registry.create(command, cwd, extraEnv, true);
    return {
      toolCallId: '',
      content: `Timed out after ${elapsed}ms. Detached and backgrounded as ${bgEntry.id} (pid ${bgEntry.pid}).\nUse get_output with shell_id "${bgEntry.id}" to read output, or kill_shell to terminate.`,
    };
  },
});

// ── get_output ───────────────────────────────────────────────────────
export const getOutputTool: ShellToolFactory = (cfg) => ({
  name: makeToolName(cfg.toolPrefix, 'get_output'),
  description:
    'Read output from a backgrounded shell process. Returns accumulated stdout and stderr. ' +
    'If the process has exited, includes the exit code and the shell is cleaned up. ' +
    'Works across sessions — if the shell was started in a previous invocation, it is ' +
    'reconnected from persisted metadata. Use the shell_id returned by exec.',
  parameters: {
    type: 'object',
    properties: {
      shell_id: {
        type: 'string',
        description: 'The shell ID returned by exec when the command was backgrounded.',
      },
    },
    required: ['shell_id'],
  },
  async execute(args) {
    const shellId = String(args.shell_id ?? '');
    if (!shellId) {
      return { toolCallId: '', content: 'Error: shell_id is required' };
    }

    // get() auto-reconnects from disk if the shell isn't in memory.
    const entry = cfg.registry.get(shellId);
    if (!entry) {
      return { toolCallId: '', content: `Error: no shell with id "${shellId}"` };
    }

    // For reconnected shells, re-read the output file to get latest.
    let output = entry.output;
    if (entry.detached && entry.outputFile && existsSync(entry.outputFile)) {
      try {
        output = readFileSync(entry.outputFile, 'utf-8');
        entry.output = output;
      } catch {}
    }

    const truncated = output.length > 50000
      ? output.slice(0, 50000) + '\n[output truncated]'
      : output;

    if (entry.done) {
      cfg.registry.delete(shellId);
      return {
        toolCallId: '',
        content: `Process exited (code: ${entry.exitCode}).\n${truncated}`,
      };
    }

    return {
      toolCallId: '',
      content: `Still running (pid ${entry.pid}).\n${truncated}`,
    };
  },
});

// ── kill_shell ───────────────────────────────────────────────────────
export const killShellTool: ShellToolFactory = (cfg) => ({
  name: makeToolName(cfg.toolPrefix, 'kill_shell'),
  description:
    'Kill a backgrounded shell process by its shell_id. Sends SIGKILL. ' +
    'Returns the final accumulated output. Works across sessions.',
  parameters: {
    type: 'object',
    properties: {
      shell_id: {
        type: 'string',
        description: 'The shell ID returned by exec.',
      },
    },
    required: ['shell_id'],
  },
  async execute(args) {
    const shellId = String(args.shell_id ?? '');
    if (!shellId) {
      return { toolCallId: '', content: 'Error: shell_id is required' };
    }

    const entry = cfg.registry.get(shellId);
    if (!entry) {
      return { toolCallId: '', content: `Error: no shell with id "${shellId}"` };
    }

    // Kill via PID (works for both in-memory and reconnected shells).
    try {
      process.kill(entry.pid, 'SIGKILL');
    } catch {
      // already dead
    }

    // Give it a moment to flush output.
    await new Promise((r) => setTimeout(r, 100));

    // Re-read output file for detached shells.
    let output = entry.output;
    if (entry.detached && entry.outputFile && existsSync(entry.outputFile)) {
      try { output = readFileSync(entry.outputFile, 'utf-8'); } catch {}
    }

    const truncated = output.length > 50000
      ? output.slice(0, 50000) + '\n[output truncated]'
      : output;

    cfg.registry.delete(shellId);
    return {
      toolCallId: '',
      content: `Killed ${shellId} (pid ${entry.pid}).\n${truncated}`,
    };
  },
});

// ── write_to_process ─────────────────────────────────────────────────
export const writeToProcessTool: ShellToolFactory = (cfg) => ({
  name: makeToolName(cfg.toolPrefix, 'write_to_process'),
  description:
    'Write input to the stdin of a backgrounded interactive shell process. ' +
    'Use this for shells running TUI programs, REPLs, or commands that wait for input. ' +
    'For a simple Enter keypress, send "\\n". ' +
    'Only works for shells started in the current session (not reconnected).',
  parameters: {
    type: 'object',
    properties: {
      shell_id: {
        type: 'string',
        description: 'The shell ID returned by exec.',
      },
      input: {
        type: 'string',
        description: 'The text to write to the process stdin.',
      },
    },
    required: ['shell_id', 'input'],
  },
  async execute(args) {
    const shellId = String(args.shell_id ?? '');
    const input = String(args.input ?? '');
    if (!shellId) {
      return { toolCallId: '', content: 'Error: shell_id is required' };
    }
    if (!input) {
      return { toolCallId: '', content: 'Error: input is required' };
    }

    const entry = cfg.registry.get(shellId);
    if (!entry) {
      return { toolCallId: '', content: `Error: no shell with id "${shellId}"` };
    }

    if (entry.done) {
      return { toolCallId: '', content: `Error: process ${shellId} has already exited` };
    }

    // write_to_process only works for in-memory shells with a live stdin.
    if (!entry.process) {
      return {
        toolCallId: '',
        content: `Error: shell ${shellId} was reconnected from a previous session and has no writable stdin. Only shells started in the current session accept input.`,
        isError: true,
      };
    }

    const stdin = entry.process.stdin;
    if (!stdin || stdin.destroyed) {
      return { toolCallId: '', content: `Error: process ${shellId} has no writable stdin` };
    }

    return new Promise((resolve) => {
      stdin.write(input, (err) => {
        if (err) {
          resolve({
            toolCallId: '',
            content: `Error writing to ${shellId}: ${err.message}`,
            isError: true,
          });
        } else {
          resolve({
            toolCallId: '',
            content: `Wrote ${input.length} bytes to ${shellId}`,
          });
        }
      });
    });
  },
});
