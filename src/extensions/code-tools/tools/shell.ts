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

interface ShellEntry {
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

export class ShellRegistry {
  private shells = new Map<string, ShellEntry>();
  private counter = 0;
  private shellsDir: string;
  public onTaskComplete?: (id: string, code: number, output: string) => void;

  constructor(shellsDir?: string) {
    this.shellsDir = shellsDir ?? join(process.cwd(), '.libra-shells');
  }

  private nextId(): string {
    return `task_${++this.counter}`;
  }

  private metaPath(id: string): string {
    return join(this.shellsDir, `${id}.json`);
  }

  async create(command: string, cwd: string, env: Record<string, string>): Promise<ShellEntry> {
    const id = this.nextId();
    const shellsDir = this.shellsDir;

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

    const fullCommand = fifoReady
      ? `exec 3<>"${inputFifo}"; ${command} <&3; echo $? > "${exitFile}" 2>/dev/null`
      : `${command} < /dev/null; echo $? > "${exitFile}" 2>/dev/null`;

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
        try { finalOutput = readFileSync(outputFile, 'utf-8'); } catch {}
        this.onTaskComplete(id, code ?? -1, finalOutput);
      }
    });
    child.on('error', (err) => {
      try { appendFileSync(outputFile, `\nError: ${err.message}\n`); } catch {}
      entry.done = true;
      entry.exitCode = -1;
      if (this.onTaskComplete) {
        let finalOutput = '';
        try { finalOutput = readFileSync(outputFile, 'utf-8'); } catch {}
        this.onTaskComplete(id, -1, finalOutput);
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
      inputFifo: inputFifo,
    };
    try { writeFileSync(metaFile, JSON.stringify(meta, null, 2)); } catch {}

    this.shells.set(id, entry);
    return entry;
  }

  get(id: string): ShellEntry | undefined {
    const cached = this.shells.get(id);
    if (cached) return cached;

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
        try { process.kill(-entry.pid, 'SIGKILL'); } catch {
          try { process.kill(entry.pid, 'SIGKILL'); } catch {}
        }
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
      Cwd: {
        type: 'string',
        description: 'The current working directory for the command.',
      },
      WaitMsBeforeAsync: {
        type: 'integer',
        description: 'Milliseconds to wait after starting the command before sending it to the background.',
      },
      IsDaemon: {
        type: 'boolean',
        description: 'Set to true for long-running support processes.',
      },
    },
    required: ['CommandLine', 'Cwd', 'WaitMsBeforeAsync'],
  },
  async execute(args) {
    const command = String(args.CommandLine ?? '');
    const cwd = String(args.Cwd ?? process.cwd());
    const waitMs = Number(args.WaitMsBeforeAsync ?? 1000);
    const isDaemon = args.IsDaemon === true;

    if (!command) {
      return { toolCallId: '', content: 'Error: CommandLine is required' };
    }

    const entry = await cfg.registry.create(command, cwd, {});

    if (isDaemon || waitMs <= 0) {
      return {
        toolCallId: '',
        content: `Command sent to background. Task ID: ${entry.id}`,
      };
    }

    // Wait up to waitMs
    const start = Date.now();
    while (!entry.done && (Date.now() - start) < waitMs) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (entry.done) {
      cfg.registry.delete(entry.id);
      let output = '';
      if (entry.outputFile && existsSync(entry.outputFile)) {
        try { output = readFileSync(entry.outputFile, 'utf-8'); } catch {}
      }
      const truncated = output.length > 50000 ? output.slice(0, 50000) + '\n[output truncated]' : output;
      return {
        toolCallId: '',
        content: `Command completed (exit code ${entry.exitCode}).\n${truncated}`,
      };
    }

    // Didn't finish in time, background it
    return {
      toolCallId: '',
      content: `Command still running after ${waitMs}ms. Sent to background. Task ID: ${entry.id}`,
    };
  },
});

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
        description: 'The task ID to manage. Required when Action is kill, status, or send_input.',
      },
      Input: {
        type: 'string',
        description: 'The input to send to the task. Required when Action is send_input.',
      },
    },
    required: ['Action'],
  },
  async execute(args) {
    const action = String(args.Action ?? '');
    const taskId = String(args.TaskId ?? '');
    const input = String(args.Input ?? '');

    if (action === 'list') {
      return { toolCallId: '', content: 'Error: list action not supported, track your task IDs.' };
    }

    if (!taskId) {
      return { toolCallId: '', content: 'Error: TaskId is required for this action' };
    }

    const entry = cfg.registry.get(taskId);
    if (!entry) {
      return { toolCallId: '', content: `Error: no task with id "${taskId}"` };
    }

    if (action === 'kill') {
      try { process.kill(-entry.pid, 'SIGKILL'); } catch {
        try { process.kill(entry.pid, 'SIGKILL'); } catch {}
      }
      await new Promise((r) => setTimeout(r, 100));
      let output = '';
      if (entry.outputFile && existsSync(entry.outputFile)) {
        try { output = readFileSync(entry.outputFile, 'utf-8'); } catch {}
      }
      const truncated = output.length > 50000 ? output.slice(0, 50000) + '\n[output truncated]' : output;
      cfg.registry.delete(taskId);
      return {
        toolCallId: '',
        content: `Killed task ${taskId}.\n${truncated}`,
      };
    }

    if (action === 'status') {
      let output = '';
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

    if (action === 'send_input') {
      if (entry.done) {
        return { toolCallId: '', content: `Error: task ${taskId} has already exited` };
      }
      if (entry.inputFifo && existsSync(entry.inputFifo)) {
        const { spawn } = await import('node:child_process');
        return new Promise((resolve) => {
          const writer = spawn('sh', ['-c', `printf %s "$1" >> "${entry.inputFifo}"`, 'write_to_process', input], { stdio: 'ignore' });
          writer.on('exit', (code) => {
            if (code === 0) {
              resolve({ toolCallId: '', content: `Wrote ${input.length} bytes to ${taskId}` });
            } else {
              resolve({ toolCallId: '', content: `Error writing to ${taskId}: exit code ${code}`, isError: true });
            }
          });
        });
      }
      return { toolCallId: '', content: `Error: task ${taskId} has no input fifo`, isError: true };
    }

    return { toolCallId: '', content: `Error: unknown action ${action}` };
  },
});
