/**
 * SessionSocket — Unix Domain Socket controller for daemonless agent turns.
 *
 * Each active turn creates an ephemeral socket at ~/.libra/sockets/<sessionKey>.sock.
 * The socket provides:
 * 1. Live event streaming to any attached client (TUI, CLI, Slack adapter).
 * 2. Instantaneous, zero-latency steering and halting via direct socket push.
 * 3. Session concurrency locking (connecting to the socket proves an agent is live).
 *
 * When the turn completes, the server closes and the socket file is unlinked.
 * The agent remains completely daemonless.
 */

import net from 'node:net';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunHandle, Extension, TurnContext } from '@xandout/libra-harness';

export type SocketEventType =
  | 'status'
  | 'text'
  | 'tool'
  | 'file'
  | 'steer'
  | 'halt'
  | 'stats'
  | 'done';

export interface SocketEvent {
  type: SocketEventType;
  ts: number;
  message?: string;
  delta?: string;
  name?: string;
  phase?: 'start' | 'end';
  file?: string;
  text?: string;
  reason?: string;
  reply?: string;
  finishReason?: string;
  stats?: Record<string, unknown>;
}

export type SocketCommand =
  | { type: 'steer'; text: string }
  | { type: 'halt'; reason?: string };

export function getSocketPath(socketsDir: string, sessionKey: string): string {
  const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(socketsDir, `${safe}.sock`);
}

/**
 * Check if an agent is currently alive and responding on a session socket.
 */
export async function isSessionActive(socketPath: string, timeoutMs = 300): Promise<boolean> {
  if (!existsSync(socketPath)) return false;

  return new Promise<boolean>((resolve) => {
    const client = net.createConnection(socketPath);
    let resolved = false;

    const cleanup = (active: boolean) => {
      if (resolved) return;
      resolved = true;
      client.destroy();
      resolve(active);
    };

    client.once('connect', () => cleanup(true));
    client.once('error', () => {
      // Stale socket file on disk — safe to clean up
      try { unlinkSync(socketPath); } catch {}
      cleanup(false);
    });

    setTimeout(() => cleanup(false), timeoutMs);
  });
}

/**
 * Server hosted by the running agent process for the duration of a turn.
 */
export class SessionSocketServer {
  private server: net.Server | null = null;
  private clients = new Set<net.Socket>();
  private handle: RunHandle | null = null;

  constructor(
    public readonly socketPath: string,
    public readonly sessionKey: string,
  ) {}

  /**
   * Bind to the socket path. Cleans up any stale socket file first.
   */
  async start(): Promise<void> {
    const dir = join(this.socketPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Clean up stale socket if no live process answers
    if (existsSync(this.socketPath)) {
      const active = await isSessionActive(this.socketPath, 200);
      if (active) {
        throw new Error(`Another agent is already running for session: ${this.sessionKey}`);
      }
      try { unlinkSync(this.socketPath); } catch {}
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.clients.add(socket);

        let buffer = '';
        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const cmd = JSON.parse(line) as SocketCommand;
              this.handleCommand(cmd);
            } catch (err) {
              console.error('[socket] Failed to parse command:', err);
            }
          }
        });

        socket.on('close', () => this.clients.delete(socket));
        socket.on('error', () => this.clients.delete(socket));
      });

      this.server.on('error', (err) => reject(err));
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  /**
   * Attach the active turn handle so incoming steer/halt commands are executed.
   */
  attachHandle(handle: RunHandle): void {
    this.handle = handle;
  }

  /**
   * Handle an incoming command from an attached client.
   */
  private handleCommand(cmd: SocketCommand): void {
    if (!this.handle) return;
    if (cmd.type === 'steer') {
      this.broadcast({ type: 'steer', text: cmd.text, ts: Date.now() });
      this.handle.steer(cmd.text);
    } else if (cmd.type === 'halt') {
      this.broadcast({ type: 'halt', reason: cmd.reason, ts: Date.now() });
      this.handle.halt(cmd.reason);
    }
  }

  /**
   * Broadcast an event to all connected listeners.
   */
  broadcast(event: SocketEvent): void {
    const payload = JSON.stringify(event) + '\n';
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /**
   * Stop the server and unlink the socket file.
   */
  close(): void {
    for (const client of this.clients) {
      try { client.end(); } catch {}
    }
    this.clients.clear();

    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = null;
    }

    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    } catch {}
  }
}

/**
 * Client used by secondary processes (or Slack / CLI reattach) to control or watch an active turn.
 */
export class SessionSocketClient {
  private socket: net.Socket | null = null;
  private buffer = '';

  constructor(public readonly socketPath: string) {}

  /**
   * Connect to the running agent turn's socket.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.socketPath);
      this.socket.once('connect', () => resolve());
      this.socket.once('error', (err) => reject(err));
    });
  }

  /**
   * Send a steer or halt command to the active agent.
   */
  sendCommand(cmd: SocketCommand): void {
    if (!this.socket) throw new Error('Socket client is not connected');
    this.socket.write(JSON.stringify(cmd) + '\n');
  }

  /**
   * Listen for streaming events from the agent turn.
   */
  onEvent(handler: (event: SocketEvent) => void): void {
    if (!this.socket) return;
    this.socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf-8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as SocketEvent;
          handler(ev);
        } catch {}
      }
    });
  }

  /**
   * Close the client connection.
   */
  disconnect(): void {
    if (this.socket) {
      try { this.socket.end(); } catch {}
      this.socket = null;
    }
  }
}

/**
 * Extension that hooks into agent lifecycle and broadcasts events over the active SessionSocketServer.
 */
export function createSocketEventsExtension(): Extension {
  return {
    name: 'socket-events',
    priority: 1000,
    install(agent) {
      agent.hook('beforeTurn', 'socket-events', async (ctx) => {
        const socketServer = ctx.turn.metadata.__socketServer as SessionSocketServer | undefined;
        socketServer?.broadcast({ type: 'status', message: 'Thinking…', ts: Date.now() });
      });

      agent.hook('beforeTool', 'socket-events', async (ctx) => {
        const socketServer = ctx.turn.metadata.__socketServer as SessionSocketServer | undefined;
        if (!socketServer || !ctx.toolCall) return;

        const parsed = (() => { try { return JSON.parse(ctx.toolCall.arguments); } catch { return {}; } })();
        let file: string | undefined;
        if (parsed.file_path) file = String(parsed.file_path);
        else if (parsed.pattern) file = parsed.path ? `${parsed.pattern} in ${parsed.path}` : String(parsed.pattern);
        else if (parsed.command) file = String(parsed.command);

        socketServer.broadcast({
          type: 'tool',
          name: ctx.toolCall.name,
          phase: 'start',
          file,
          ts: Date.now(),
        });
      });

      agent.hook('afterTool', 'socket-events', async (ctx) => {
        const socketServer = ctx.turn.metadata.__socketServer as SessionSocketServer | undefined;
        if (!socketServer || !ctx.toolCall) return;

        socketServer.broadcast({
          type: 'tool',
          name: ctx.toolCall.name,
          phase: 'end',
          ts: Date.now(),
        });
      });

      agent.hook('beforeResponse', 'socket-events', async (ctx) => {
        const socketServer = ctx.turn.metadata.__socketServer as SessionSocketServer | undefined;
        socketServer?.broadcast({ type: 'status', message: 'Writing reply…', ts: Date.now() });
      });
    },
  };
}
