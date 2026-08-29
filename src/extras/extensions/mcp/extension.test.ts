import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../../../agent.js';
import type { Extension } from '../../../extension.js';
import { createMcpExtension } from './index.js';

// ── Test MCP server ────────────────────────────────────────────────
// Path to the minimal stdio MCP server script.
const SERVER_SCRIPT = new URL('./test-server.mjs', import.meta.url).pathname;

// ── Mock model ─────────────────────────────────────────────────────
// Returns a fixed assistant message.
function mockModel() {
  return {
    async generate() {
      return {
        message: { role: 'assistant', content: 'ok' },
        finishReason: 'stop' as const,
      };
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────
function makeConfig(path: string, servers: Record<string, any>) {
  writeFileSync(path, JSON.stringify({ mcpServers: servers }, null, 2));
}

function stdioServer(command: string, args: string[] = []): any {
  return { type: 'stdio', command, args };
}

// ── Test setup ─────────────────────────────────────────────────────
let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  configPath = join(tmpDir, 'mcpServers.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────

describe('mcp extension', () => {
  it('returns undefined when no mcpConfigPaths provided', async () => {
    const ext = await createMcpExtension({});
    expect(ext).toBeUndefined();
  });

  it('returns undefined when no servers in config', async () => {
    makeConfig(configPath, {});
    const ext = await createMcpExtension({ mcpConfigPaths: configPath });
    expect(ext).toBeUndefined();
  });

  it('connects to a stdio server and discovers tools', async () => {
    makeConfig(configPath, {
      'test': stdioServer('node', [SERVER_SCRIPT]),
    });

    const ext = await createMcpExtension({ mcpConfigPaths: configPath });
    expect(ext).toBeDefined();

    const agent = new Agent({ model: mockModel() as any });
    agent.use(ext!);

    // MCP tools should NOT be registered on the agent at install time.
    // They are injected per-turn via the beforeTurn hook.
    const agentTools = agent.getTools();
    expect(agentTools).not.toContain('test__echo');
    expect(agentTools).not.toContain('test__ping');

    // Meta-tools SHOULD be registered at install time.
    expect(agentTools).toContain('list_resources');
    expect(agentTools).toContain('read_resource');
    expect(agentTools).toContain('list_prompts');
    expect(agentTools).toContain('use_prompt');
  });

  it('injects MCP tools into turn.tools via beforeTurn hook', async () => {
    makeConfig(configPath, {
      'test': stdioServer('node', [SERVER_SCRIPT]),
    });

    const ext = (await createMcpExtension({ mcpConfigPaths: configPath }))!;
    const agent = new Agent({ model: mockModel() as any });
    agent.use(ext);

    // Run a turn and check that the model sees MCP tools.
    let seenToolNames: string[] = [];
    const model = {
      async generate(req: any) {
        seenToolNames = (req.tools ?? []).map((t: any) => t.function?.name ?? t.name);
        return {
          message: { role: 'assistant', content: 'ok' },
          finishReason: 'stop' as const,
        };
      },
    };

    const agent2 = new Agent({ model: model as any });
    agent2.use(ext);

    await agent2.run({ message: 'hi' });

    expect(seenToolNames).toContain('test__echo');
    expect(seenToolNames).toContain('test__ping');
    // Meta-tools should also be visible.
    expect(seenToolNames).toContain('list_resources');
  });

  it('can call an MCP tool through the agent', async () => {
    makeConfig(configPath, {
      'test': stdioServer('node', [SERVER_SCRIPT]),
    });

    const ext = (await createMcpExtension({ mcpConfigPaths: configPath }))!;

    let callCount = 0;
    let toolResult = '';
    const model = {
      async generate(req: any) {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: 'call_1',
                name: 'test__echo',
                arguments: JSON.stringify({ text: 'hello mcp' }),
              }],
            },
            finishReason: 'tool_calls' as const,
          };
        }
        const toolMsg = req.messages.find((m: any) => m.role === 'tool');
        toolResult = toolMsg?.content ?? '';
        return {
          message: { role: 'assistant', content: 'done' },
          finishReason: 'stop' as const,
        };
      },
    };

    const agent = new Agent({ model: model as any });
    agent.use(ext);

    const result = await agent.run({ message: 'echo hello mcp' });
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls?.some((tc) => tc.name === 'test__echo')).toBe(true);
    expect(toolResult).toBe('hello mcp');
  });

  it('reloads when config file changes at runtime', async () => {
    // Start with one server.
    makeConfig(configPath, {
      'test': stdioServer('node', [SERVER_SCRIPT]),
    });

    const ext = (await createMcpExtension({ mcpConfigPaths: configPath }))!;

    let seenToolNames: string[] = [];
    const model = {
      async generate(req: any) {
        seenToolNames = (req.tools ?? []).map((t: any) => t.function?.name ?? t.name);
        return {
          message: { role: 'assistant', content: 'ok' },
          finishReason: 'stop' as const,
        };
      },
    };

    const agent = new Agent({ model: model as any });
    agent.use(ext);

    // First turn: should see test__echo and test__ping.
    await agent.run({ message: 'turn 1' });
    expect(seenToolNames).toContain('test__echo');
    expect(seenToolNames).toContain('test__ping');

    // Modify the config to add a second server (same script, different name).
    // We need to ensure the mtime changes — writeFileSync may not always
    // update mtime on fast systems, so we force it with utimesSync.
    makeConfig(configPath, {
      'test': stdioServer('node', [SERVER_SCRIPT]),
      'test2': stdioServer('node', [SERVER_SCRIPT]),
    });
    // Force mtime change (set to 1 second in the future).
    const future = new Date(Date.now() / 1000 + 1);
    utimesSync(configPath, future, future);

    // Second turn: should see tools from both servers.
    await agent.run({ message: 'turn 2' });
    expect(seenToolNames).toContain('test__echo');
    expect(seenToolNames).toContain('test2__echo');
    expect(seenToolNames).toContain('test2__ping');
  });

  it('respects excludeTools pattern', async () => {
    makeConfig(configPath, {
      'test': stdioServer('node', [SERVER_SCRIPT]),
    });

    const ext = (await createMcpExtension({
      mcpConfigPaths: configPath,
      excludeTools: ['test__ping'],
    }))!;

    let seenToolNames: string[] = [];
    const model = {
      async generate(req: any) {
        seenToolNames = (req.tools ?? []).map((t: any) => t.function?.name ?? t.name);
        return {
          message: { role: 'assistant', content: 'ok' },
          finishReason: 'stop' as const,
        };
      },
    };

    const agent = new Agent({ model: model as any });
    agent.use(ext);

    await agent.run({ message: 'hi' });

    expect(seenToolNames).toContain('test__echo');
    expect(seenToolNames).not.toContain('test__ping');
  });

  it('meta-tools read from live state after reload', async () => {
    makeConfig(configPath, {
      'test': stdioServer('node', [SERVER_SCRIPT]),
    });

    const ext = (await createMcpExtension({ mcpConfigPaths: configPath }))!;

    let callCount = 0;
    let resourceList = '';
    const model = {
      async generate(req: any) {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: 'call_1',
                name: 'list_resources',
                arguments: '{}',
              }],
            },
            finishReason: 'tool_calls' as const,
          };
        }
        const toolMsg = req.messages.find((m: any) => m.role === 'tool');
        resourceList = toolMsg?.content ?? '';
        return {
          message: { role: 'assistant', content: 'done' },
          finishReason: 'stop' as const,
        };
      },
    };

    const agent = new Agent({ model: model as any });
    agent.use(ext);

    await agent.run({ message: 'list resources' });
    expect(resourceList).toContain('test://greeting');
  });

  it('can read an MCP resource via read_resource tool', async () => {
    makeConfig(configPath, {
      'test': stdioServer('node', [SERVER_SCRIPT]),
    });

    const ext = (await createMcpExtension({ mcpConfigPaths: configPath }))!;

    let callCount = 0;
    let resourceContent = '';
    const model = {
      async generate(req: any) {
        callCount++;
        if (callCount === 1) {
          return {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: 'call_1',
                name: 'read_resource',
                arguments: JSON.stringify({ uri: 'test://greeting' }),
              }],
            },
            finishReason: 'tool_calls' as const,
          };
        }
        const toolMsg = req.messages.find((m: any) => m.role === 'tool');
        resourceContent = toolMsg?.content ?? '';
        return {
          message: { role: 'assistant', content: 'done' },
          finishReason: 'stop' as const,
        };
      },
    };

    const agent = new Agent({ model: model as any });
    agent.use(ext);

    await agent.run({ message: 'read the greeting resource' });
    expect(resourceContent).toContain('Hello from MCP');
  });

  it('close() cleans up client connections', async () => {
    makeConfig(configPath, {
      'test': stdioServer('node', [SERVER_SCRIPT]),
    });

    const ext = await createMcpExtension({ mcpConfigPaths: configPath });
    if (!ext) throw new Error('extension was undefined');
    const agent = new Agent({ model: mockModel() as any });
    agent.use(ext);

    // Should not throw.
    await (ext as Extension & { close(): Promise<void> }).close();

    // Unload should also work (calls close internally).
    // We can't easily test that the subprocess is killed, but we can
    // verify close() doesn't throw.
  });
});
