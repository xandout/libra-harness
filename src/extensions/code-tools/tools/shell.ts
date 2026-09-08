import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync, openSync, closeSync, readFileSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeToolName, type ToolFactory } from './shared.js';

export interface ShellToolConfig {
  toolPrefix: string;
  registry: ShellRegistry;
}

export type ShellToolFactory = (cfg: ShellToolConfig) => ReturnType<ToolFactory>;

export interface ShellEntry {
  id: string;
  process?: ChildProcess;
  pid: number;
  output: string;
  done: boolean;
  exitCode: number | null;
  startedAt: number;
  command: string;
  cwd: string;
  outputFile?: string;
  inputFifo?: string;
  detached: boolean;
  readOffset?: number;
}

interface ShellMeta {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  startedAt: number;
  outputFile: string;
  inputFifo?: string;
}

export interface ShellCallbackConfig {
  /** Path to the `lc` binary (or npx command) to invoke when a backgrounded task exits. */
  lcBin: string;
  /** Session key to pass via `--session` so the callback reaches the right session. */
  sessionKey: string;
}

export class ShellRegistry {
  private shells = new Map<string, ShellEntry>();
  private counter = 0;
  private shellsDir: string;
  public onTaskComplete?: (id: string, code: number, output: string) => void;
  public callback?: ShellCallbackConfig;

  constructor(shellsDir?: string) {
    this.shellsDir = shellsDir ?? join(process.cwd(), '.libra-shells');
  }

  private nextId(): string {
    return `task_${++this.counter}`;
  }

  private metaPath(id: string): string {
    return join(this.shellsDir, `${id}.json`);
  }

  async create(
    command: string,
    cwd: string,
    env: Record<string, string>,
    background: boolean = false
  ): Promise<ShellEntry> {
    const id = this.nextId();
    const shellsDir = this.shellsDir;

    if (background) {
      mkdirSync(shellsDir, { recursive: true });
      const outputFile = join(shellsDir, `${id}.output`);
      const exitFile = join(shellsDir, `${id}.exit`);
      const inputFifo = join(shellsDir, `${id}.in`);
      const metaFile = this.metaPath(id);

      writeFileSync(outputFile, '');

      try {
        if (existsSync(inputFifo)) unlinkSync(inputFifo);
        execFileSync('mkfifo', [inputFifo], { stdio: 'ignore' });
      } catch {}

      const outFd = openSync(outputFile, 'a');
      const errFd = outFd;
      const fifoReady = existsSync(inputFifo);
      const nullFd = openSync('/dev/null', 'r');

      // Wrap in parentheses `( command )` so internal pipes (`a | b | head`)
      // do NOT have the right-hand command stdin redirected to `<&3`!
      // After the command exits, fire a callback into `lc` so the agent can
      // react (steer if a turn is active, or start a new turn). The callback
      // is detached — it does not keep `lc` alive.
      const cb = this.callback
        ? `${this.callback.lcBin} --session ${this.callback.sessionKey} "Background task ${id} finished (exit code $__code). Output file: ${outputFile}" 2>/dev/null &`
        : '';
      const fullCommand = fifoReady
        ? `exec 3<>"${inputFifo}"; ( ${command} ) <&3; __code=$?; echo $__code > "${exitFile}" 2>/dev/null; ${cb}`
        : `( ${command} ) < /dev/null; __code=$?; echo $__code > "${exitFile}" 2>/dev/null; ${cb}`;

      const child = spawn(fullCommand, {
        shell: '/bin/bash',
        cwd,
        env: { ...process.env, ...env },
        stdio: [nullFd, outFd, errFd],
        detached: true,
      });

      closeSync(outFd);
      try { closeSync(nullFd); } catch {}

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
        inputFifo: existsSync(inputFifo) ? inputFifo : undefined,
        detached: true,
        readOffset: 0,
      };

      child.on('exit', (code) => {
        entry.done = true;
        entry.exitCode = code;
        if (this.onTaskComplete) {
          let finalOutput = '';
          if (entry.outputFile && existsSync(entry.outputFile)) {
            try { finalOutput = readFileSync(entry.outputFile, 'utf-8'); } catch {}
          }
          this.onTaskComplete(entry.id, code ?? 0, finalOutput);
        }
      });

      child.unref();

      const meta: ShellMeta = {
        id,
        pid: child.pid ?? -1,
        command,
        cwd,
        startedAt: entry.startedAt,
        outputFile,
        inputFifo,
      };
      try { writeFileSync(metaFile, JSON.stringify(meta, null, 2)); } catch {}

      this.shells.set(id, entry);
      return entry;
    }

    // ── Foreground: direct in-memory pipes, parent owns the process ──
    const child = spawn(command, {
      shell: '/bin/bash',
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
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

    child.stdout?.on('data', (data) => {
      entry.output += data.toString();
    });
    child.stderr?.on('data', (data) => {
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

  get(id: string): ShellEntry | undefined {
    const cached = this.shells.get(id);    if (cached) {
      if (!cached.done && cached.detached) {
        const exitFile = join(this.shellsDir, `${id}.exit`);
        if (existsSync(exitFile)) {
          try {
            cached.exitCode = Number(readFileSync(exitFile, 'utf-8').trim());
            cached.done = true;
          } catch {}
        } else if (cached.pid > 0) {
          try {
            process.kill(cached.pid, 0);
          } catch {
            cached.done = true;
            cached.exitCode = -1;
          }
        }
      }
      return cached;
    }

    const metaFile = this.metaPath(id);
    if (!existsSync(metaFile)) return undefined;

    try {
      const meta = JSON.parse(readFileSync(metaFile, 'utf-8')) as ShellMeta;
      const outputFile = meta.outputFile;
      const exitFile = join(this.shellsDir, `${id}.exit`);

      let alive = false;
      try {
        process.kill(meta.pid, 0);
        alive = true;
      } catch {
        alive = false;
      }

      let output = '';
      if (existsSync(outputFile)) {
        output = readFileSync(outputFile, 'utf-8');
      }

      let exitCode: number | null = null;
      let done = false;
      if (existsSync(exitFile)) {
        exitCode = Number(readFileSync(exitFile, 'utf-8').trim());
        done = true;
      } else if (!alive) {
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
        inputFifo: meta.inputFifo,
        detached: true,
        readOffset: output.length,
      };

      this.shells.set(id, entry);
      return entry;
    } catch {
      return undefined;
    }
  }

  delete(id: string): boolean {
    const entry = this.shells.get(id);
    if (entry && !entry.done) {
      try {
        if (entry.process) {
          entry.process.kill('SIGKILL');
        } else if (entry.pid > 0) {
          process.kill(entry.pid, 'SIGKILL');
        }
      } catch {}
    }

    const removed = this.shells.delete(id);
    const metaFile = this.metaPath(id);
    const outputFile = join(this.shellsDir, `${id}.output`);
    const exitFile = join(this.shellsDir, `${id}.exit`);
    const inputFifo = join(this.shellsDir, `${id}.in`);
    for (const f of [metaFile, outputFile, exitFile, inputFifo]) {
      try { if (existsSync(f)) unlinkSync(f); } catch {}
    }
    return removed;
  }

  close() {
    for (const entry of this.shells.values()) {
      if (!entry.done) {
        try {
          if (entry.process) {
            entry.process.kill('SIGKILL');
          } else if (entry.pid > 0) {
            process.kill(entry.pid, 'SIGKILL');
          }
        } catch {}
      }
      this.delete(entry.id);
    }
    this.shells.clear();
  }
}

// ── run_command ───────────────────────────────────────────────────────
export const runCommandTool: ShellToolFactory = (cfg) => ({
  name: makeToolName(cfg.toolPrefix, 'run_command'),
  description:
    'PROPOSE a command to run on behalf of the user. Operating System: mac. Shell: bash. ' +
    'If the step doesn\'t return the command output, it means that the command was sent to the background as a task. ' +
    'You will receive messages with the command\'s output as it runs. To interact with a running command, use the manage_task tool.',
  parameters: {
    type: 'object',
    properties: {
      CommandLine: {
        type: 'string',
        description: 'The exact command line string to execute.',
      },
      command: {
        type: 'string',
        description: 'Alias for CommandLine.',
      },
      Cwd: {
        type: 'string',
        description: 'The current working directory for the command.',
      },
      cwd: {
        type: 'string',
        description: 'Alias for Cwd.',
      },
      WaitMsBeforeAsync: {
        type: 'integer',
        description: 'Milliseconds to wait after starting the command before sending it to the background. Default: 30000 (30s).',
      },
      timeout: {
        type: 'integer',
        description: 'Alias for WaitMsBeforeAsync.',
      },
      IsDaemon: {
        type: 'boolean',
        description: 'Set to true for long-running support processes.',
      },
    },
    required: ['CommandLine'],
  },
  async execute(args) {
    const command = String(args.CommandLine ?? args.command ?? '');
    const cwd = String(args.Cwd ?? args.cwd ?? process.cwd());
    const waitMs = args.WaitMsBeforeAsync !== undefined
      ? Number(args.WaitMsBeforeAsync)
      : (args.timeout !== undefined ? Number(args.timeout) : 30000);
    const isDaemon = args.IsDaemon === true;

    if (!command) {
      return { toolCallId: '', content: 'Error: CommandLine is required' };
    }

    if (isDaemon || waitMs <= 0) {
      const entry = await cfg.registry.create(command, cwd, {}, true);
      return {
        toolCallId: '',
        content: `Command sent to background. Task ID: ${entry.id}`,
      };
    }

    // Foreground execution with direct pipes
    const entry = await cfg.registry.create(command, cwd, {}, false);

    // Wait up to waitMs
    const start = Date.now();
    while (!entry.done && (Date.now() - start) < waitMs) {
      await new Promise((r) => setTimeout(r, 50));
    }

    if (entry.done) {
      cfg.registry.delete(entry.id);
      const output = entry.output;
      const truncated = output.length > 50000 ? output.slice(0, 50000) + '\n[output truncated]' : output;
      return {
        toolCallId: '',
        content: `Command completed (exit code ${entry.exitCode}).\n${truncated}`,
      };
    }

    // Didn't finish in time, report backgrounded
    return {
      toolCallId: '',
      content: `Command still running after ${waitMs}ms. Sent to background. Task ID: ${entry.id}`,
    };
  },
});

export const execTool: ShellToolFactory = (cfg) => {
  const base = runCommandTool(cfg);
  return {
    ...base,
    name: makeToolName(cfg.toolPrefix, 'exec'),
    description: 'Execute a shell command. Alias for run_command.',
  };
};

// ── manage_task ───────────────────────────────────────────────────────
export const manageTaskTool: ShellToolFactory = (cfg) => ({
  name: makeToolName(cfg.toolPrefix, 'manage_task'),
  description:
    'Manage background tasks. Use this tool to list running tasks or interact with tasks that were sent to the background. ' +
    'Actions: "list" (not supported here, use ps), "kill" (cancel the task), "status" (check current status), "send_input" (send input to a running task).',
  parameters: {
    type: 'object',
    properties: {
      Action: {
        type: 'string',
        enum: ['list', 'kill', 'status', 'send_input'],
        description: 'The action to perform.',
      },
      TaskId: {
        type: 'string',
        description: 'The task ID to manage.',
      },
      Input: {
        type: 'string',
        description: 'The input to send to the task (required for send_input).',
      },
    },
    required: ['Action'],
  },
  async execute(args) {
    const action = String(args.Action ?? '');
    const taskId = String(args.TaskId ?? '');

    if (action === 'list') {
      return { toolCallId: '', content: 'Error: list action not supported, track your task IDs.' };
    }

    if (!taskId) {
      return { toolCallId: '', content: 'Error: TaskId is required' };
    }

    const entry = cfg.registry.get(taskId);
    if (!entry) {
      return { toolCallId: '', content: `Error: no task with id "${taskId}"` };
    }

    if (action === 'status') {
      let output = entry.output;
      if (entry.outputFile && existsSync(entry.outputFile)) {
        try { output = readFileSync(entry.outputFile, 'utf-8'); } catch {}
      }
      const truncated = output.length > 50000 ? output.slice(0, 50000) + '\n[output truncated]' : output;
      
      if (entry.done) {
        cfg.registry.delete(taskId);
        return { toolCallId: '', content: `Task finished (code: ${entry.exitCode}).\n${truncated}` };
      }

      return { toolCallId: '', content: `Task still running.\n${truncated}` };
    }

    if (action === 'kill') {
      try {
        if (entry.process) {
          entry.process.kill('SIGKILL');
        } else if (entry.pid > 0) {
          process.kill(entry.pid, 'SIGKILL');
        }
      } catch {}

      let output = entry.output;
      if (entry.outputFile && existsSync(entry.outputFile)) {
        try { output = readFileSync(entry.outputFile, 'utf-8'); } catch {}
      }
      cfg.registry.delete(taskId);
      const truncated = output.length > 50000 ? output.slice(0, 50000) + '\n[output truncated]' : output;

      return {
        toolCallId: '',
        content: `Killed task ${taskId}.\n${truncated}`,
      };
    }

    if (action === 'send_input') {
      const input = String(args.Input ?? '');

      if (entry.done) {
        return { toolCallId: '', content: `Error: task "${taskId}" has already exited` };
      }

      if (entry.inputFifo && existsSync(entry.inputFifo)) {
        try {
          appendFileSync(entry.inputFifo, input + '\n');
          return { toolCallId: '', content: `Sent input to task ${taskId}` };
        } catch (err: any) {
          return { toolCallId: '', content: `Error writing to input FIFO: ${err.message}` };
        }
      }

      return { toolCallId: '', content: `Error: task "${taskId}" does not accept input` };
    }

    return { toolCallId: '', content: `Unknown action: "${action}"` };
  },
});
