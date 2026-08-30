/**
 * TurnJournal — decoupled, journaled agent turns for lc.
 *
 * Inspired by zocode's TurnManager. The agent writes events to an
 * append-only JSONL journal. The TUI subscribes to the journal and
 * renders from it. The journal is the source of truth for display
 * state — it survives TUI crashes and can be replayed on restart.
 *
 *   agent runs              → every event appended to journal
 *   TUI subscribes          → replays journal, then live-tails
 *   steer/halt              → RunHandle for control + journal for display
 *
 * The journal lives at ~/.libra/turns/<turnId>.jsonl.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

// ── Event types ─────────────────────────────────────────────────────

export type TurnEventType =
  | 'status'    // status message ("Thinking…", "Writing reply…")
  | 'text'      // streamed text delta
  | 'tool'      // tool call start/end
  | 'file'      // file touched
  | 'done'      // turn finished
  | 'steer'     // steering message injected
  | 'halt'      // turn halted
  | 'stats';    // session stats snapshot

export interface TurnEvent {
  seq: number;
  ts: number;
  type: TurnEventType;
  // status
  message?: string;
  // text
  delta?: string;
  // tool
  name?: string;
  phase?: 'start' | 'end';
  file?: string;
  // done
  reply?: string;
  finishReason?: string;
  // steer
  text?: string;
  // halt
  reason?: string;
  // stats
  stats?: {
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    llmCalls: number;
    turns: number;
    toolCalls: number;
    toolErrors: number;
    lastPromptTokens: number;
    lastCompletionTokens: number;
  };
}

// ── Turn metadata ───────────────────────────────────────────────────

export interface TurnMeta {
  turnId: string;
  prompt: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  status: 'queued' | 'running' | 'done' | 'error' | 'halted';
  reply: string;
}

// ── Journal ─────────────────────────────────────────────────────────

export class TurnJournal {
  private events: TurnEvent[] = [];
  private emitter = new EventEmitter();
  private finished = false;
  private meta: TurnMeta;

  constructor(
    private readonly journalDir: string,
    private readonly metaDir: string,
    turnId: string,
    prompt: string,
  ) {
    if (!existsSync(journalDir)) mkdirSync(journalDir, { recursive: true });
    if (!existsSync(metaDir)) mkdirSync(metaDir, { recursive: true });

    this.meta = {
      turnId,
      prompt,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      status: 'queued',
      reply: '',
    };
    this.writeMeta();
  }

  get turnId(): string { return this.meta.turnId; }
  get isFinished(): boolean { return this.finished; }
  getMeta(): TurnMeta { return { ...this.meta }; }

  // ── Append ────────────────────────────────────────────────────────

  /** Append an event to the journal and notify subscribers. */
  append(type: TurnEventType, data: Partial<Omit<TurnEvent, 'seq' | 'ts' | 'type'>> = {}): void {
    const ev: TurnEvent = {
      seq: this.events.length,
      ts: Date.now(),
      type,
      ...data,
    };
    this.events.push(ev);
    this.persist(ev);
    this.emitter.emit('event', ev);
  }

  private persist(ev: TurnEvent): void {
    try {
      appendFileSync(this.journalPath(), JSON.stringify(ev) + '\n', 'utf-8');
    } catch (e) {
      console.error('[journal] persist error:', e);
    }
  }

  private writeMeta(): void {
    try {
      writeFileSync(this.metaPath(), JSON.stringify(this.meta, null, 2), 'utf-8');
    } catch (e) {
      console.error('[journal] writeMeta error:', e);
    }
  }

  // ── Status transitions ────────────────────────────────────────────

  markRunning(): void {
    this.meta.status = 'running';
    this.meta.startedAt = Date.now();
    this.writeMeta();
  }

  markDone(reply: string): void {
    this.meta.status = 'done';
    this.meta.reply = reply;
    this.meta.finishedAt = Date.now();
    this.finished = true;
    this.writeMeta();
    this.emitter.emit('end');
  }

  markError(reply: string): void {
    this.meta.status = 'error';
    this.meta.reply = reply;
    this.meta.finishedAt = Date.now();
    this.finished = true;
    this.writeMeta();
    this.emitter.emit('end');
  }

  markHalted(): void {
    this.meta.status = 'halted';
    this.meta.finishedAt = Date.now();
    this.finished = true;
    this.writeMeta();
    this.emitter.emit('end');
  }

  // ── Subscribe ─────────────────────────────────────────────────────

  /**
   * Subscribe to journal events. Replays from `fromSeq`, then live-tails.
   * Returns an unsubscribe function.
   */
  subscribe(fromSeq: number, onEvent: (ev: TurnEvent) => void, onEnd?: () => void): () => void {
    // Replay history.
    for (const ev of this.events) {
      if (ev.seq >= fromSeq) onEvent(ev);
    }

    // If already finished, call onEnd immediately.
    if (this.finished) {
      onEnd?.();
      return () => {};
    }

    // Live-tail.
    const handler = (ev: TurnEvent) => onEvent(ev);
    this.emitter.on('event', handler);
    if (onEnd) this.emitter.once('end', onEnd);

    return () => {
      this.emitter.off('event', handler);
      if (onEnd) this.emitter.off('end', onEnd);
    };
  }

  // ── Query ─────────────────────────────────────────────────────────

  /** Get all events (for replay/rebuild). */
  getAll(): TurnEvent[] { return [...this.events]; }

  /** Get events since a sequence number. */
  getSince(seq: number): TurnEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }

  // ── Paths ─────────────────────────────────────────────────────────

  private journalPath(): string { return join(this.journalDir, `${this.meta.turnId}.jsonl`); }
  private metaPath(): string { return join(this.metaDir, `${this.meta.turnId}.meta.json`); }

  // ── Static helpers ────────────────────────────────────────────────

  /** Generate a new turn id. */
  static newTurnId(): string {
    return `turn-${Date.now()}-${randomBytes(3).toString('hex')}`;
  }

  /** Load a journal from disk (for replay on restart). */
  static loadFromDisk(journalDir: string, metaDir: string, turnId: string): TurnJournal | null {
    const metaPath = join(metaDir, `${turnId}.meta.json`);
    const journalPath = join(journalDir, `${turnId}.jsonl`);
    if (!existsSync(metaPath) || !existsSync(journalPath)) return null;

    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as TurnMeta;
      const journal = new TurnJournal(journalDir, metaDir, turnId, meta.prompt);
      journal.meta = meta;

      // Load events into memory without re-emitting.
      const raw = readFileSync(journalPath, 'utf-8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as TurnEvent;
          journal.events.push(ev);
        } catch { /* corrupt line — skip */ }
      }

      // Mark as finished if the turn completed.
      if (meta.status === 'done' || meta.status === 'error' || meta.status === 'halted') {
        journal.finished = true;
      }

      return journal;
    } catch {
      return null;
    }
  }

  /** Find the most recent turn for a session (by meta files). */
  static latestTurnId(metaDir: string): string | null {
    if (!existsSync(metaDir)) return null;
    let latest: string | null = null;
    let latestTime = -1;
    for (const f of readdirSync(metaDir)) {
      if (!f.endsWith('.meta.json')) continue;
      try {
        const meta = JSON.parse(readFileSync(join(metaDir, f), 'utf-8')) as TurnMeta;
        if (meta.createdAt > latestTime) {
          latestTime = meta.createdAt;
          latest = meta.turnId;
        }
      } catch { /* skip */ }
    }
    return latest;
  }

  // ── Command file (TUI → agent) ────────────────────────────────────
  // The TUI writes steer/halt commands to <turnId>.cmd.jsonl.
  // The agent polls this file between iterations.

  private cmdPath(): string { return join(this.journalDir, `${this.meta.turnId}.cmd.jsonl`); }

  /** Write a command (called by TUI). */
  writeCommand(cmd: { type: 'steer'; text: string } | { type: 'halt'; reason: string }): void {
    try {
      appendFileSync(this.cmdPath(), JSON.stringify(cmd) + '\n', 'utf-8');
    } catch (e) {
      console.error('[journal] writeCommand error:', e);
    }
  }

  /** Read and clear pending commands (called by agent). Returns commands. */
  drainCommands(): Array<{ type: 'steer'; text: string } | { type: 'halt'; reason: string }> {
    if (!existsSync(this.cmdPath())) return [];
    try {
      const raw = readFileSync(this.cmdPath(), 'utf-8');
      // Clear the file after reading.
      writeFileSync(this.cmdPath(), '', 'utf-8');
      const cmds: Array<{ type: 'steer'; text: string } | { type: 'halt'; reason: string }> = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          cmds.push(JSON.parse(line));
        } catch { /* skip */ }
      }
      return cmds;
    } catch {
      return [];
    }
  }
}

// ── Turn-events extension ───────────────────────────────────────────
// Forwards agent lifecycle events to the journal. The journal reference
// travels in `turn.metadata.__journal` (set per request in sendPrompt),
// so the same extension is safe to install once per agent.

import type { Extension } from '@xandout/libra-harness';

export function createTurnEventsExtension(): Extension {
  return {
    name: 'turn-events',
    priority: 1000,
    install(agent) {
      agent.hook('beforeTurn', 'turn-events', async (ctx) => {
        const journal = ctx.turn.metadata.__journal as TurnJournal | undefined;
        journal?.markRunning();
        journal?.append('status', { message: 'Thinking…' });
      });

      agent.hook('beforeTool', 'turn-events', async (ctx) => {
        const journal = ctx.turn.metadata.__journal as TurnJournal | undefined;
        if (!journal || !ctx.toolCall) return;

        const parsed = (() => { try { return JSON.parse(ctx.toolCall.arguments); } catch { return {}; } })();
        let file: string | undefined;
        if (parsed.file_path) file = String(parsed.file_path);
        else if (parsed.pattern) file = parsed.path ? `${parsed.pattern} in ${parsed.path}` : String(parsed.pattern);
        else if (parsed.command) file = String(parsed.command);

        journal.append('tool', {
          name: ctx.toolCall.name,
          phase: 'start',
          file,
        });
      });

      agent.hook('afterTool', 'turn-events', async (ctx) => {
        const journal = ctx.turn.metadata.__journal as TurnJournal | undefined;
        if (!journal || !ctx.toolCall) return;
        journal.append('tool', {
          name: ctx.toolCall.name,
          phase: 'end',
        });
      });

      agent.hook('beforeResponse', 'turn-events', async (ctx) => {
        const journal = ctx.turn.metadata.__journal as TurnJournal | undefined;
        journal?.append('status', { message: 'Writing reply…' });
      });
    },
  };
}

// ── Command-polling extension ────────────────────────────────────────
// Polls the journal's command file before each LLM call and after each
// tool batch. Translates steer/halt commands into RunHandle calls.
// The journal reference travels in `turn.metadata.__journal`.

export function createCommandPollingExtension(): Extension {
  return {
    name: 'command-polling',
    priority: 999,
    install(agent) {
      // Check for commands before each LLM call.
      agent.hook('beforeLLM', 'command-polling', async (ctx) => {
        const journal = ctx.turn.metadata.__journal as TurnJournal | undefined;
        if (!journal) return;
        const cmds = journal.drainCommands();
        for (const cmd of cmds) {
          if (cmd.type === 'steer') {
            ctx.turn.steer(cmd.text);
            journal.append('steer', { text: cmd.text });
          } else if (cmd.type === 'halt') {
            ctx.turn.halt(cmd.reason);
          }
        }
      });

      // Check for commands after each tool batch (before next LLM call).
      agent.hook('afterTool', 'command-polling', async (ctx) => {
        const journal = ctx.turn.metadata.__journal as TurnJournal | undefined;
        if (!journal) return;
        const cmds = journal.drainCommands();
        for (const cmd of cmds) {
          if (cmd.type === 'steer') {
            ctx.turn.steer(cmd.text);
            journal.append('steer', { text: cmd.text });
          } else if (cmd.type === 'halt') {
            ctx.turn.halt(cmd.reason);
          }
        }
      });
    },
  };
}

// ── Session lock ─────────────────────────────────────────────────────
// PID-based lock file to prevent two agent processes on the same session.

export interface SessionLock {
  pid: number;
  turnId: string;
  startedAt: number;
}

export class SessionLockManager {
  constructor(private readonly lockDir: string) {
    if (!existsSync(lockDir)) mkdirSync(lockDir, { recursive: true });
  }

  private lockPath(sessionKey: string): string { return join(this.lockDir, `${sessionKey}.lock`); }

  /** Try to acquire a lock. Returns true if acquired, false if held by a live process. */
  acquire(sessionKey: string, turnId: string): boolean {
    const existing = this.readLock(sessionKey);
    if (existing && this.isAlive(existing.pid)) {
      // Lock is held by a live process.
      return false;
    }
    // Lock is free or stale — take it.
    const lock: SessionLock = { pid: process.pid, turnId, startedAt: Date.now() };
    writeFileSync(this.lockPath(sessionKey), JSON.stringify(lock, null, 2), 'utf-8');
    return true;
  }

  /** Release the lock if we hold it. */
  release(sessionKey: string): void {
    const existing = this.readLock(sessionKey);
    if (existing && existing.pid === process.pid) {
      try {
        
        unlinkSync(this.lockPath(sessionKey));
      } catch { /* already gone */ }
    }
  }

  /** Read the current lock for a session, or null. */
  readLock(sessionKey: string): SessionLock | null {
    try {
      if (!existsSync(this.lockPath(sessionKey))) return null;
      return JSON.parse(readFileSync(this.lockPath(sessionKey), 'utf-8')) as SessionLock;
    } catch {
      return null;
    }
  }

  /** Check if a PID is alive. */
  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Force-kill the process holding the lock (if any). Returns true if killed. */
  forceBreak(sessionKey: string): boolean {
    const existing = this.readLock(sessionKey);
    if (!existing) return true;
    if (this.isAlive(existing.pid)) {
      try {
        process.kill(existing.pid, 'SIGTERM');
      } catch { /* may have died */ }
    }
    // Remove the lock regardless.
    try {
      
      unlinkSync(this.lockPath(sessionKey));
    } catch { /* already gone */ }
    return true;
  }
}

