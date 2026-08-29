import type { Extension } from '../../../extension.js';
import type { Tool } from '../../../tool.js';
import { Client, StreamableHTTPClientTransport, SSEClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFileSync, existsSync, statSync } from 'node:fs';

/**
 * MCP server config — supports all three transport types.
 *
 * - `type: 'stdio'` (or omitted, with `command`) — spawns a local process
 * - `type: 'http'` (or omitted, with `url`) — Streamable HTTP transport
 * - `type: 'sse'` — legacy SSE transport
 */
interface McpServerConfig {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /**
   * Bearer token for HTTP/SSE auth. When set, an `AuthProvider` is
   * created that injects `Authorization: Bearer <token>` on every
   * request. If the server returns 401, the request is not retried
   * (use `oauth` for refresh flows).
   */
  authToken?: string;
}

interface McpServersConfig {
  mcpServers: Record<string, McpServerConfig>;
}

function inferType(server: McpServerConfig): 'stdio' | 'http' | 'sse' {
  if (server.type) return server.type;
  if (server.command) return 'stdio';
  if (server.url) return 'http';
  throw new Error('Cannot infer MCP server type: provide "type", "command", or "url"');
}

function createTransport(server: McpServerConfig) {
  const type = inferType(server);
  switch (type) {
    case 'stdio': {
      if (!server.command) throw new Error('stdio MCP server requires "command"');
      return new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: server.env,
      });
    }
    case 'http': {
      if (!server.url) throw new Error('http MCP server requires "url"');
      return new StreamableHTTPClientTransport(new URL(server.url), {
        ...(server.headers && { requestInit: { headers: server.headers } }),
        ...(server.authToken && {
          authProvider: {
            token: async () => server.authToken!,
          },
        }),
      });
    }
    case 'sse': {
      if (!server.url) throw new Error('sse MCP server requires "url"');
      return new SSEClientTransport(new URL(server.url), {
        ...(server.headers && { requestInit: { headers: server.headers } }),
      });
    }
    default:
      throw new Error(`Unknown MCP transport type: ${type}`);
  }
}

/**
 * Config for the MCP extension.
 *
 * Passed by the extension loader from the host's config object.
 * The key `mcpConfigPaths` should be declared in extension.json's `configKeys`.
 */
export interface McpExtensionConfig {
  /** One or more MCP server config file paths. */
  mcpConfigPaths?: string | string[];
  /**
   * Tool names to exclude from being registered on the agent. Each entry
   * is matched against the full namespaced tool name (`serverName__toolName`)
   * using RegExp test(). Tools that match are never registered — they're
   * not on the agent, not in the LLM context, and not callable.
   *
   * Examples:
   *   - `['slack__slack_send_message']`           — exact match
   *   - ['crm__delete_.*']`                      — all CRM delete tools
   *   - ['slack__.*']`                            — all Slack MCP tools
   */
  excludeTools?: string[];
}

/**
 * MCP extension factory.
 *
 * Receives config from the extension loader. The `mcpConfigPaths` key (a
 * path or array of paths) tells the extension where to find MCP server
 * config files. Each config file is a JSON file with an `mcpServers`
 * object (compatible with Claude Desktop, Cursor, etc.). Servers from all
 * configs are merged — if two configs define the same server name, the
 * last one wins.
 *
 * If no `mcpConfigPaths` is provided or none of the files exist, the
 * factory returns `undefined` (opts out).
 *
 * Uses `versionNegotiation: { mode: 'auto' }` so each client dynamically
 * supports both 2025-era and 2026-era servers. Tools are namespaced as
 * `serverName__toolName` to avoid collisions.
 *
 * The returned extension has a `close()` method for cleaning up MCP
 * client connections — call it during shutdown.
 *
 * ## Runtime reload
 *
 * MCP tools are NOT registered on the agent at install time. Instead, a
 * `beforeTurn` hook checks config file mtimes on every turn. If any
 * config file changed (new server added, server removed, server
 * modified), the extension reconnects: closes old clients, opens new
 * ones, and rediscovers tools/resources/prompts. The current set of
 * MCP tools is then injected into `turn.tools` for that turn.
 *
 * This means editing `mcpServers.json` takes effect on the next agent
 * turn — no restart needed. The mtime check is cheap (stat only); the
 * expensive reconnect only happens when config actually changes.
 *
 * Meta-tools (`list_resources`, `read_resource`, `list_prompts`,
 * `use_prompt`) are registered at install time and always available.
 * They read from live state, so they reflect the current set of
 * connected servers even after a reload.
 */
export default async function createMcpExtension(
  config?: McpExtensionConfig,
): Promise<Extension | undefined> {
  const configPaths = config?.mcpConfigPaths;
  if (!configPaths) {
    console.log('[mcp] no mcpConfigPaths in config — skipping MCP extension');
    return undefined;
  }
  const paths = Array.isArray(configPaths) ? configPaths : [configPaths];
  const excludePatterns = (config?.excludeTools ?? []).map((p) => new RegExp(p));

  // ── Live state ───────────────────────────────────────────────────
  // These arrays are mutated by connectAll() — cleared and repopulated
  // on each reload. Meta-tools and buildMcpTools() read from them, so
  // they always reflect the current set of connected servers.
  const clients: Array<{ client: Client; name: string }> = [];
  const discoveredTools: Array<{
    serverName: string;
    toolName: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    client: Client;
  }> = [];
  const discoveredResources: Array<{
    serverName: string;
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
    client: Client;
  }> = [];
  const discoveredPrompts: Array<{
    serverName: string;
    promptName: string;
    description?: string;
    client: Client;
  }> = [];

  // Config mtimes for change detection. Keyed by config path.
  // If a path's mtime changes (or the file appears/disappears), we
  // trigger a reload on the next turn.
  const configMtimes = new Map<string, number>();

  /**
   * Read and merge all config files, returning the merged server map.
   * Also updates configMtimes for change detection.
   */
  function loadMergedServers(): Record<string, McpServerConfig> {
    const merged: Record<string, McpServerConfig> = {};
    configMtimes.clear();
    for (const configPath of paths) {
      if (!existsSync(configPath)) {
        configMtimes.set(configPath, -1); // track non-existence
        continue;
      }
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as McpServersConfig;
      if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
        throw new Error(`Invalid MCP config: missing "mcpServers" object in ${configPath}`);
      }
      Object.assign(merged, parsed.mcpServers);
      configMtimes.set(configPath, statSync(configPath).mtimeMs);
    }
    return merged;
  }

  /**
   * Check if any config file changed since the last loadMergedServers().
   * Returns true if a reload is needed.
   */
  function configChanged(): boolean {
    for (const [configPath, knownMtime] of configMtimes) {
      try {
        if (!existsSync(configPath)) {
          if (knownMtime !== -1) return true; // file was deleted
          continue;
        }
        const currentMtime = statSync(configPath).mtimeMs;
        if (currentMtime !== knownMtime) return true;
      } catch {
        return true; // stat failed — assume changed
      }
    }
    return false;
  }

  /**
   * Connect to all configured servers, discover tools/resources/prompts.
   * Closes existing clients first. Safe to call repeatedly.
   */
  async function connectAll(): Promise<void> {
    // Tear down existing connections.
    await Promise.all(
      clients.map(({ client }) => client.close().catch(() => {})),
    );
    clients.length = 0;
    discoveredTools.length = 0;
    discoveredResources.length = 0;
    discoveredPrompts.length = 0;

    const mergedServers = loadMergedServers();
    const serverNames = Object.keys(mergedServers);

    if (serverNames.length === 0) {
      console.log('[mcp] no server configs found');
      return;
    }

    console.log(`[mcp] connecting to ${serverNames.length} server(s): ${serverNames.join(', ')}`);

    for (const [name, server] of Object.entries(mergedServers)) {
      try {
        const transport = createTransport(server);
        const client = new Client(
          { name: 'libra-example', version: '1.0.0' },
          { versionNegotiation: { mode: 'auto' } },
        );

        await client.connect(transport);
        clients.push({ client, name });

        const { tools } = await client.listTools();
        for (const tool of tools) {
          discoveredTools.push({
            serverName: name,
            toolName: tool.name,
            description: tool.description,
            inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
            client,
          });
        }

        // Discover resources (reference docs, data sources).
        try {
          const { resources } = await client.listResources();
          for (const res of resources) {
            discoveredResources.push({
              serverName: name,
              uri: res.uri,
              name: res.name,
              description: res.description,
              mimeType: res.mimeType,
              client,
            });
          }
        } catch {
          // Server may not support resources — that's fine.
        }

        // Discover prompts (templated workflows).
        try {
          const { prompts } = await client.listPrompts();
          for (const p of prompts) {
            discoveredPrompts.push({
              serverName: name,
              promptName: p.name,
              description: p.description,
              client,
            });
          }
        } catch {
          // Server may not support prompts — that's fine.
        }

        const resCount = discoveredResources.filter((r) => r.serverName === name).length;
        const promptCount = discoveredPrompts.filter((p) => p.serverName === name).length;
        console.log(
          `[mcp] ${name}: ${tools.length} tool(s)${resCount > 0 ? `, ${resCount} resource(s)` : ''}${promptCount > 0 ? `, ${promptCount} prompt(s)` : ''}` +
            (tools.length > 0 ? ' — ' + tools.map((t: { name: string }) => t.name).join(', ') : ''),
        );
      } catch (err) {
        // Don't let one broken MCP server abort the whole extension.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[mcp] failed to connect to "${name}": ${msg}`);
      }
    }

    console.log(
      `[mcp] total: ${discoveredTools.length} tool(s)` +
        (discoveredResources.length > 0 ? `, ${discoveredResources.length} resource(s)` : '') +
        (discoveredPrompts.length > 0 ? `, ${discoveredPrompts.length} prompt(s)` : '') +
        ` from ${clients.length} server(s)`,
    );
  }

  // Initial connection.
  await connectAll();

  if (clients.length === 0) {
    console.log('[mcp] no servers connected — skipping MCP extension');
    return undefined;
  }

  /**
   * Build Tool[] from discovered tools, applying excludePatterns.
   * Called on each turn to inject current MCP tools into turn.tools.
   */
  function buildMcpTools(): Tool[] {
    return discoveredTools
      .filter((dt) => !excludePatterns.some((re) => re.test(`${dt.serverName}__${dt.toolName}`)))
      .map((dt) => ({
        name: `${dt.serverName}__${dt.toolName}`,
        description: dt.description,
        parameters: dt.inputSchema,
        async execute(args) {
          const result = await dt.client.callTool({
            name: dt.toolName,
            arguments: args,
          });
          const text = (result.content ?? [])
            .filter((c: { type: string }) => c.type === 'text')
            .map((c: { type: string; text?: string }) => c.text ?? '')
            .join('\n');
          return {
            toolCallId: '',
            content: text || JSON.stringify(result.content),
          };
        },
      }));
  }

  const extension: Extension & { close(): Promise<void> } = {
    name: 'mcp',
    priority: 50,
    install(agent) {
      // ── beforeTurn: reload on config change + inject tools ──────
      // On every turn, check if config files changed. If so, reconnect.
      // Then inject the current set of MCP tools into turn.tools so
      // the LLM can call them this turn.
      agent.hook('beforeTurn', 'mcp', async (ctx) => {
        if (configChanged()) {
          console.log('[mcp] config changed — reloading servers');
          await connectAll();
        }
        const mcpTools = buildMcpTools();
        if (mcpTools.length > 0) {
          ctx.turn.tools.push(...mcpTools);
        }
      });

      // ── Resources ────────────────────────────────────────────────
      // Meta-tools are registered at install time and always available.
      // They read from the live discoveredResources array, so they
      // reflect the current set of connected servers even after reload.
      agent.tool({
        name: 'list_resources',
        description:
          'List available MCP resources (reference docs, data sources) ' +
          'from connected servers. Use this to discover what reference ' +
          'material is available, then call read_resource to read one.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          if (discoveredResources.length === 0) {
            return { toolCallId: '', content: 'No resources available.' };
          }
          const lines = discoveredResources.map(
            (r) =>
              `- ${r.serverName}://${r.uri}: ${r.name}` +
              (r.description ? ` — ${r.description}` : ''),
          );
          return {
            toolCallId: '',
            content: `Available resources (${discoveredResources.length}):\n${lines.join('\n')}`,
          };
        },
      });

      agent.tool({
        name: 'read_resource',
        description:
          'Read an MCP resource by its URI. Returns the resource content ' +
          '(typically markdown or text). Use list_resources first to see ' +
          'available URIs.',
        parameters: {
          type: 'object',
          properties: {
            uri: {
              type: 'string',
              description: 'The resource URI to read (e.g. "pave://job-statuses").',
            },
          },
          required: ['uri'],
        },
        async execute(args) {
          const uri = args.uri as string;
          const res = discoveredResources.find((r) => r.uri === uri || r.uri.endsWith(uri));
          if (!res) {
            const available = discoveredResources.map((r) => r.uri).join(', ');
            return {
              toolCallId: '',
              content: `Resource "${uri}" not found. Available: ${available || '(none)'}`,
              isError: true,
            };
          }
          try {
            const result = await res.client.readResource({ uri: res.uri });
            const text = (result.contents ?? [])
              .map((c: { text?: string; uri?: string }) => c.text ?? `[${c.uri}]`)
              .join('\n');
            return { toolCallId: '', content: text || '(empty resource)' };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { toolCallId: '', content: `Failed to read resource: ${msg}`, isError: true };
          }
        },
      });

      // ── Prompts ──────────────────────────────────────────────────
      agent.tool({
        name: 'list_prompts',
        description:
          'List available MCP prompts (templated workflows) from ' +
          'connected servers. Use this to discover pre-built workflows, ' +
          'then call use_prompt to invoke one.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          if (discoveredPrompts.length === 0) {
            return { toolCallId: '', content: 'No prompts available.' };
          }
          const lines = discoveredPrompts.map(
            (p) =>
              `- ${p.serverName}__${p.promptName}` +
              (p.description ? ` — ${p.description}` : ''),
          );
          return {
            toolCallId: '',
            content: `Available prompts (${discoveredPrompts.length}):\n${lines.join('\n')}`,
          };
        },
      });

      agent.tool({
        name: 'use_prompt',
        description:
          'Invoke an MCP prompt by name. Returns the generated prompt ' +
          'text — follow the instructions in it to complete the task. ' +
          'Use list_prompts first to see available prompt names.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The prompt name (e.g. "crm__account-summary").',
            },
            args: {
              type: 'object',
              description: 'Arguments for the prompt (e.g. { "accountId": "account-123" }).',
              additionalProperties: true,
            },
          },
          required: ['name'],
        },
        async execute(args) {
          const name = args.name as string;
          // Accept "server__prompt" or just "prompt" (if unambiguous).
          let prompt = discoveredPrompts.find((p) => `${p.serverName}__${p.promptName}` === name);
          if (!prompt) {
            const matches = discoveredPrompts.filter((p) => p.promptName === name);
            if (matches.length === 1) prompt = matches[0];
            else if (matches.length > 1) {
              return {
                toolCallId: '',
                content: `Ambiguous prompt name "${name}". Use server__prompt format. Matches: ${matches.map((m) => `${m.serverName}__${m.promptName}`).join(', ')}`,
                isError: true,
              };
            }
          }
          if (!prompt) {
            const available = discoveredPrompts.map((p) => `${p.serverName}__${p.promptName}`).join(', ');
            return {
              toolCallId: '',
              content: `Prompt "${name}" not found. Available: ${available || '(none)'}`,
              isError: true,
            };
          }
          try {
            const promptArgs = (args.args as Record<string, string>) ?? {};
            const result = await prompt.client.getPrompt({
              name: prompt.promptName,
              arguments: promptArgs,
            });
            const text = (result.messages ?? [])
              .map((m: { content: { text?: string; type?: string } | string }) => {
                if (typeof m.content === 'string') return m.content;
                if (m.content?.type === 'text') return m.content.text ?? '';
                return '';
              })
              .join('\n');
            return { toolCallId: '', content: text || '(empty prompt)' };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { toolCallId: '', content: `Failed to invoke prompt: ${msg}`, isError: true };
          }
        },
      });
    },
    async close() {
      await Promise.all(clients.map(({ client }) => client.close()));
    },
  };

  return extension;
}
