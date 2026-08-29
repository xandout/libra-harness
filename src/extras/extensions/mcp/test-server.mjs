/**
 * Minimal MCP server for testing — speaks JSON-RPC 2.0 over stdio.
 *
 * No SDK dependency. Implements just enough of the MCP protocol for
 * the client to connect, list tools, and call them.
 *
 * Tools exposed:
 *   - echo: returns the text argument
 *   - ping: returns "pong"
 *
 * Resources exposed:
 *   - test://greeting: "Hello from MCP"
 *
 * Prompts exposed:
 *   - greet: returns a greeting message
 */
import { readFileSync } from 'node:fs';

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back the provided text',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'ping',
    description: 'Return pong',
    inputSchema: { type: 'object', properties: {} },
  },
];

const RESOURCES = [
  {
    uri: 'test://greeting',
    name: 'greeting',
    description: 'A test greeting resource',
    mimeType: 'text/plain',
  },
];

const PROMPTS = [
  {
    name: 'greet',
    description: 'Generate a greeting prompt',
  },
];

let initialized = false;

function handleMessage(msg) {
  const { jsonrpc, id, method, params } = msg;

  // Notifications (no id) — just acknowledge silently.
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') {
      initialized = true;
    }
    return null; // no response for notifications
  }

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
          serverInfo: { name: 'test-mcp-server', version: '1.0.0' },
        },
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      };

    case 'tools/call': {
      const { name, arguments: args } = params;
      if (name === 'echo') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: String(args?.text ?? '') }],
          },
        };
      }
      if (name === 'ping') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: 'pong' }],
          },
        };
      }
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${name}` },
      };
    }

    case 'resources/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { resources: RESOURCES },
      };

    case 'resources/read': {
      const { uri } = params;
      if (uri === 'test://greeting') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [{ uri: 'test://greeting', text: 'Hello from MCP' }],
          },
        };
      }
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Unknown resource: ${uri}` },
      };
    }

    case 'prompts/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { prompts: PROMPTS },
      };

    case 'prompts/get': {
      const { name } = params;
      if (name === 'greet') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            messages: [
              { role: 'user', content: { type: 'text', text: 'Say hello!' } },
            ],
          },
        };
      }
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Unknown prompt: ${name}` },
      };
    }

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown method: ${method}` },
      };
  }
}

// Read newline-delimited JSON-RPC from stdin.
let buffer = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const response = handleMessage(msg);
      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (err) {
      // Malformed JSON — skip.
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});
