import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeToolName } from './shared.js';

// ── Todo state ───────────────────────────────────────────────────────
// Todos are tracked at the extension level so they persist across
// turns within the same agent. When a todoFile path is configured,
// todos are also persisted to disk and loaded on startup, so they
// survive across separate process invocations.

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
  content: string;
  status: TodoStatus;
}

export class TodoStore {
  private todos: Todo[] = [];
  private filePath?: string;

  constructor(filePath?: string) {
    this.filePath = filePath;
    if (filePath) {
      this.load();
    }
  }

  /** Load todos from disk. */
  private load(): void {
    if (!this.filePath) return;
    try {
      if (existsSync(this.filePath)) {
        const data = JSON.parse(readFileSync(this.filePath, 'utf-8'));
        if (Array.isArray(data)) {
          this.todos = data.map((t: any) => ({
            content: String(t.content ?? ''),
            status: (t.status === 'in_progress' || t.status === 'completed')
              ? t.status
              : 'pending',
          }));
        }
      }
    } catch {
      // ignore corrupt file
    }
  }

  /** Save todos to disk. */
  private save(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.todos, null, 2) + '\n', 'utf-8');
    } catch {
      // ignore write errors
    }
  }

  /** Replace the entire todo list. */
  setAll(todos: Todo[]): void {
    this.todos = todos;
    this.save();
  }

  /** Get a snapshot of the current todos. */
  getAll(): Todo[] {
    return [...this.todos];
  }

  clear(): void {
    this.todos = [];
    this.save();
  }
}

// ── todo_write tool ──────────────────────────────────────────────────
export const todoWriteTool: (cfg: { toolPrefix: string; store: TodoStore }) => any = (cfg) => ({
  name: makeToolName(cfg.toolPrefix, 'todo_write'),
  description:
    'Create and manage a structured task list for tracking multi-step work. ' +
    'Use this for tasks with 3 or more distinct steps. Skip it for trivial single-step work. ' +
    'Each todo has a status: "pending", "in_progress", or "completed". ' +
    'Keep exactly ONE todo as "in_progress" at a time — mark it in_progress when starting, ' +
    'and mark it "completed" immediately when done. ' +
    'The entire list is replaced on each call (not appended). ' +
    'Add follow-up tasks discovered during work. Remove tasks that are no longer relevant. ' +
    'Todos persist across sessions, so you can pick up where you left off.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete todo list. Replaces the previous list on each call.',
        items: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The task description.',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Current status of the todo.',
            },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async execute(args: { todos: unknown }) {
    const input = args.todos;
    if (!Array.isArray(input)) {
      return { toolCallId: '', content: 'Error: todos must be an array' };
    }

    const todos: Todo[] = input.map((t: any) => ({
      content: String(t.content ?? ''),
      status: (t.status === 'in_progress' || t.status === 'completed')
        ? t.status
        : 'pending',
    }));

    // Validate: at most one in_progress.
    const inProgressCount = todos.filter((t) => t.status === 'in_progress').length;
    if (inProgressCount > 1) {
      return {
        toolCallId: '',
        content: 'Error: only one todo can be "in_progress" at a time. Mark the others "pending" or "completed".',
        isError: true,
      };
    }

    cfg.store.setAll(todos);

    // Format the response so the model sees the current state.
    if (todos.length === 0) {
      return { toolCallId: '', content: 'Todo list cleared.' };
    }

    const lines = todos.map((t, i) => {
      const marker = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
      return `${i + 1}. ${marker} ${t.content}`;
    });

    return {
      toolCallId: '',
      content: `Updated todo list:\n${lines.join('\n')}`,
    };
  },
});
