import { describe, it, expect } from 'vitest';
import {
  Agent,
  type Extension,
  type HookContext,
  type ModelResponse,
  type ToolResult,
  HookError,
  LibraError,
  ModelError,
  ToolError,
  HaltedError,
  MaxIterationsError,
  HookRegistry,
  createAgentTool,
  type AgentResponse,
  type Message,
} from '../src/index.js';
import { MockModel, textResponse, toolCallResponse, toolCall, makeTool } from './helpers.js';

// ─────────────────────────────────────────────────────────────────────
// 1. Bare agent with no extensions
// ─────────────────────────────────────────────────────────────────────

describe('1. Bare agent with no extensions', () => {
  it('runs a simple turn and returns the model response', async () => {
    const model = new MockModel([textResponse('Hello!')]);
    const agent = new Agent({ model });

    const result = await agent.run({ message: 'Hi' });

    expect(result.message).toBe('Hello!');
    expect(result.finishReason).toBe('stop');
    expect(result.iterations).toBe(1);
    expect(result.role).toBe('assistant');
  });

  it('passes the user message to the model', async () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });

    await agent.run({ message: 'What is 2+2?' });

    expect(model.receivedCalls[0].messages).toEqual([{ role: 'user', content: 'What is 2+2?' }]);
  });

  it('passes the system prompt to the model', async () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model, systemPrompt: 'You are a pirate.' });

    await agent.run({ message: 'Hello' });

    expect(model.receivedCalls[0].systemPrompt).toBe('You are a pirate.');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. Extension that modifies context
// ─────────────────────────────────────────────────────────────────────

describe('2. Extension that modifies context', () => {
  it('can mutate turn metadata in beforeTurn', async () => {
    const model = new MockModel([textResponse('done')]);
    const agent = new Agent({ model });

    const stampExtension: Extension = {
      name: 'stamp',
      install(a) {
        a.hook('beforeTurn', 'stamp', async (ctx) => {
          ctx.turn.metadata.requestId = 'req-123';
        });
      },
    };
    agent.use(stampExtension);

    const result = await agent.run({ message: 'Hi' });

    expect(result.metadata.requestId).toBe('req-123');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. Extension that modifies messages
// ─────────────────────────────────────────────────────────────────────

describe('3. Extension that modifies messages', () => {
  it('can inject a system message in beforeContext', async () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });

    const contextExtension: Extension = {
      name: 'context-injector',
      install(a) {
        a.hook('beforeContext', 'context-injector', async (ctx) => {
          ctx.turn.messages.unshift({ role: 'system', content: 'Always respond in French.' });
        });
      },
    };
    agent.use(contextExtension);

    await agent.run({ message: 'Hello' });

    expect(model.receivedCalls[0].messages[0]).toEqual({ role: 'system', content: 'Always respond in French.' });
    expect(model.receivedCalls[0].messages[1]).toEqual({ role: 'user', content: 'Hello' });
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Extension that adds a tool
// ─────────────────────────────────────────────────────────────────────

describe('4. Extension that adds a tool', () => {
  it('can register a tool during install', async () => {
    const model = new MockModel([
      toolCallResponse([toolCall('tc1', 'search')]),
      textResponse('Found it!'),
    ]);
    const agent = new Agent({ model });

    const searchExtension: Extension = {
      name: 'search-tool',
      install(a) {
        a.tool(
          makeTool('search', async (args) => `results for ${args.query}`, {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          }),
        );
      },
    };
    agent.use(searchExtension);

    const result = await agent.run({ message: 'search for cats' });

    expect(result.message).toBe('Found it!');
    expect(result.iterations).toBe(2);
    // Verify the tool was called and result was fed back to the model.
    const secondCall = model.receivedCalls[1];
    const toolMsg = secondCall.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('results for');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. Extension that observes an LLM response
// ─────────────────────────────────────────────────────────────────────

describe('5. Extension that observes an LLM response', () => {
  it('can read the model response in afterLLM', async () => {
    const model = new MockModel([textResponse('The answer is 42.')]);
    const agent = new Agent({ model });

    const observed: string[] = [];
    const observerExtension: Extension = {
      name: 'observer',
      install(a) {
        a.hook('afterLLM', 'observer', async (ctx) => {
          if (ctx.modelResponse) {
            observed.push(ctx.modelResponse.message.content);
          }
        });
      },
    };
    agent.use(observerExtension);

    await agent.run({ message: 'What is the answer?' });

    expect(observed).toEqual(['The answer is 42.']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 6. Multiple extensions with deterministic ordering
// ─────────────────────────────────────────────────────────────────────

describe('6. Multiple extensions with deterministic ordering', () => {
  it('executes hooks in registration order', async () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });

    const order: string[] = [];

    const extA: Extension = {
      name: 'A',
      install(a) {
        a.hook('beforeLLM', 'A', async () => { order.push('A'); });
      },
    };
    const extB: Extension = {
      name: 'B',
      install(a) {
        a.hook('beforeLLM', 'B', async () => { order.push('B'); });
      },
    };
    const extC: Extension = {
      name: 'C',
      install(a) {
        a.hook('beforeLLM', 'C', async () => { order.push('C'); });
      },
    };

    agent.use(extA).use(extB).use(extC);

    await agent.run({ message: 'Hi' });

    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('executes hooks in priority order regardless of use() call order', async () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });

    const order: string[] = [];

    const extLow: Extension = {
      name: 'low',
      priority: -100,
      install(a) {
        a.hook('beforeLLM', 'low', async () => { order.push('low'); });
      },
    };
    const extHigh: Extension = {
      name: 'high',
      priority: 100,
      install(a) {
        a.hook('beforeLLM', 'high', async () => { order.push('high'); });
      },
    };
    const extDefault: Extension = {
      name: 'default',
      install(a) {
        a.hook('beforeLLM', 'default', async () => { order.push('default'); });
      },
    };

    // Intentionally "wrong" use() order — priority should fix it.
    agent.use(extLow).use(extDefault).use(extHigh);

    await agent.run({ message: 'Hi' });

    expect(order).toEqual(['high', 'default', 'low']);
  });

  it('same-priority hooks retain registration order (stable sort)', async () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });

    const order: string[] = [];

    const extA: Extension = {
      name: 'A',
      priority: 50,
      install(a) {
        a.hook('beforeLLM', 'A', async () => { order.push('A'); });
      },
    };
    const extB: Extension = {
      name: 'B',
      priority: 50,
      install(a) {
        a.hook('beforeLLM', 'B', async () => { order.push('B'); });
      },
    };
    const extC: Extension = {
      name: 'C',
      priority: 50,
      install(a) {
        a.hook('beforeLLM', 'C', async () => { order.push('C'); });
      },
    };

    agent.use(extA).use(extB).use(extC);

    await agent.run({ message: 'Hi' });

    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('priority works across different lifecycle stages', async () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });

    const order: string[] = [];

    const extLow: Extension = {
      name: 'low',
      priority: -100,
      install(a) {
        a.hook('beforeTurn', 'low', async () => { order.push('low:beforeTurn'); });
        a.hook('afterTurn', 'low', async () => { order.push('low:afterTurn'); });
      },
    };
    const extHigh: Extension = {
      name: 'high',
      priority: 100,
      install(a) {
        a.hook('beforeTurn', 'high', async () => { order.push('high:beforeTurn'); });
        a.hook('afterTurn', 'high', async () => { order.push('high:afterTurn'); });
      },
    };

    agent.use(extLow).use(extHigh);

    await agent.run({ message: 'Hi' });

    expect(order).toEqual(['high:beforeTurn', 'low:beforeTurn', 'high:afterTurn', 'low:afterTurn']);
  });

  it('priority affects onError hooks too', async () => {
    const model = new MockModel([textResponse('ok')]);
    model.generate = async () => { throw new Error('fail'); };
    const agent = new Agent({ model });

    const order: string[] = [];

    const extLow: Extension = {
      name: 'low',
      priority: -100,
      install(a) {
        a.hook('onError', 'low', async () => { order.push('low'); });
      },
    };
    const extHigh: Extension = {
      name: 'high',
      priority: 100,
      install(a) {
        a.hook('onError', 'high', async (ctx) => {
          order.push('high');
          return {
            skip: true,
            value: {
              role: 'assistant' as const,
              message: 'high recovered',
              finishReason: 'stop' as const,
              iterations: 0,
              metadata: ctx.turn.metadata,
            },
          };
        });
      },
    };

    agent.use(extLow).use(extHigh);

    const result = await agent.run({ message: 'Hi' });

    expect(order).toEqual(['high']);
    expect(result.message).toBe('high recovered');
  });

  it("direct agent.hook() outside use() uses the named extension's priority", async () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });

    const order: string[] = [];

    const ext: Extension = {
      name: 'ext',
      priority: 100,
      install(a) {
        a.hook('beforeLLM', 'ext', async () => { order.push('ext'); });
      },
    };
    agent.use(ext);

    // Direct hook registered AFTER use() — should still get priority 0
    // (no installed extension named 'observer'), so runs after 'ext'.
    agent.hook('beforeLLM', 'observer', async () => { order.push('observer'); });

    await agent.run({ message: 'Hi' });

    expect(order).toEqual(['ext', 'observer']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 7. Tool-call continuation through multiple LLM iterations
// ─────────────────────────────────────────────────────────────────────

describe('7. Tool-call continuation through multiple LLM iterations', () => {
  it('continues the loop until the model stops requesting tools', async () => {
    const model = new MockModel([
      toolCallResponse([toolCall('tc1', 'calc')]),
      toolCallResponse([toolCall('tc2', 'calc')]),
      textResponse('Final answer: 42'),
    ]);
    const agent = new Agent({
      model,
      tools: [makeTool('calc', async () => '42')],
    });

    const result = await agent.run({ message: 'compute' });

    expect(result.message).toBe('Final answer: 42');
    expect(result.iterations).toBe(3);
    expect(model.callCount).toBe(3);

    // Verify tool results were fed back.
    const secondCall = model.receivedCalls[1];
    expect(secondCall.messages.filter((m) => m.role === 'tool')).toHaveLength(1);
    const thirdCall = model.receivedCalls[2];
    expect(thirdCall.messages.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('handles multiple tool calls in a single LLM response', async () => {
    const model = new MockModel([
      toolCallResponse([toolCall('tc1', 'add'), toolCall('tc2', 'add')]),
      textResponse('Done'),
    ]);
    const agent = new Agent({
      model,
      tools: [makeTool('add', async (args) => String(Number(args.a) + Number(args.b)), {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
      })],
    });

    const result = await agent.run({ message: 'add stuff' });

    expect(result.iterations).toBe(2);
    const secondCall = model.receivedCalls[1];
    expect(secondCall.messages.filter((m) => m.role === 'tool')).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 8. Session implemented as an extension
// ─────────────────────────────────────────────────────────────────────

describe('8. Session implemented as an extension', () => {
  it('loads and persists messages across turns', async () => {
    const store = new Map<string, Message[]>();
    const model = new MockModel([
      textResponse('Turn 1 response'),
      textResponse('Turn 2 response'),
    ]);
    const agent = new Agent({ model });

    const sessionExtension: Extension = {
      name: 'session',
      install(a) {
        a.hook('beforeTurn', 'session', async (ctx) => {
          const sessionId = (ctx.turn.request.metadata?.sessionId as string) ?? 'default';
          const history = store.get(sessionId) ?? [];
          // Prepend history before the current user message.
          ctx.turn.messages = [...history, ...ctx.turn.messages];
        });
        a.hook('afterTurn', 'session', async (ctx) => {
          const sessionId = (ctx.turn.request.metadata?.sessionId as string) ?? 'default';
          // Save all messages including this turn.
          store.set(sessionId, [...ctx.turn.messages]);
        });
      },
    };
    agent.use(sessionExtension);

    // Turn 1
    await agent.run({ message: 'Hello', metadata: { sessionId: 's1' } });

    // Turn 2 — should see history from turn 1
    await agent.run({ message: 'Follow up', metadata: { sessionId: 's1' } });

    const saved = store.get('s1')!;
    // Turn 1: user + assistant = 2 messages
    // Turn 2: history(2) + user + assistant = 4 messages
    expect(saved).toHaveLength(4);
    expect(saved[0].content).toBe('Hello');
    expect(saved[1].content).toBe('Turn 1 response');
    expect(saved[2].content).toBe('Follow up');
    expect(saved[3].content).toBe('Turn 2 response');

    // Verify the model saw history in turn 2
    expect(model.receivedCalls[1].messages[0].content).toBe('Hello');
    expect(model.receivedCalls[1].messages[1].content).toBe('Turn 1 response');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 9. Memory implemented as an extension
// ─────────────────────────────────────────────────────────────────────

describe('9. Memory implemented as an extension', () => {
  it('retrieves and injects memories before context is sent to the LLM', async () => {
    const memories = ['User prefers concise answers.', 'User likes TypeScript.'];
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });

    const memoryExtension: Extension = {
      name: 'memory',
      install(a) {
        a.hook('beforeContext', 'memory', async (ctx) => {
          // Inject memories as a system message.
          const memoryText = memories.map((m) => `- ${m}`).join('\n');
          ctx.turn.messages.unshift({
            role: 'system',
            content: `Relevant memories:\n${memoryText}`,
          });
        });
        a.hook('afterTurn', 'memory', async (ctx) => {
          // In a real impl, extract and persist new memories here.
          ctx.turn.metadata.memoryExtracted = true;
        });
      },
    };
    agent.use(memoryExtension);

    const result = await agent.run({ message: 'Help me code' });

    // Memories were injected before the user message.
    expect(model.receivedCalls[0].messages[0].role).toBe('system');
    expect(model.receivedCalls[0].messages[0].content).toContain('User prefers concise');
    expect(result.metadata.memoryExtracted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 10. MCP-style tools implemented as an extension
// ─────────────────────────────────────────────────────────────────────

describe('10. MCP-style tools implemented as an extension', () => {
  it('registers tools from a "remote server" without core knowing about MCP', async () => {
    // Simulate an MCP server that exposes tools.
    const mcpServer = {
      tools: [
        { name: 'fetch', description: 'Fetch a URL', parameters: { type: 'object', properties: {} } },
        { name: 'search', description: 'Search the web', parameters: { type: 'object', properties: {} } },
      ],
      async call(name: string): Promise<string> {
        return `mcp result for ${name}`;
      },
    };

    const model = new MockModel([
      toolCallResponse([toolCall('tc1', 'fetch')]),
      textResponse('Done fetching'),
    ]);
    const agent = new Agent({ model });

    const mcpExtension: Extension = {
      name: 'mcp',
      install(a) {
        // Register each MCP tool as a native tool.
        for (const t of mcpServer.tools) {
          a.tool({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            async execute() {
              const content = await mcpServer.call(t.name);
              return { toolCallId: '', content };
            },
          });
        }
      },
    };
    agent.use(mcpExtension);

    const result = await agent.run({ message: 'fetch example.com' });

    expect(result.message).toBe('Done fetching');
    // Verify the MCP tool result was fed back.
    const toolMsg = model.receivedCalls[1].messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('mcp result for fetch');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 11. Extension errors
// ─────────────────────────────────────────────────────────────────────

describe('11. Extension errors', () => {
  it('throws HookError when a hook fails', async () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model, errorPolicy: 'throw' });

    const badExtension: Extension = {
      name: 'bad',
      install(a) {
        a.hook('beforeLLM', 'bad', async () => {
          throw new Error('kaboom');
        });
      },
    };
    agent.use(badExtension);

    await expect(agent.run({ message: 'Hi' })).rejects.toThrow(HookError);
    await expect(agent.run({ message: 'Hi' })).rejects.toThrow('kaboom');
  });

  it('HookError contains the extension name and hook stage', async () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model, errorPolicy: 'throw' });

    const badExtension: Extension = {
      name: 'crasher',
      install(a) {
        a.hook('afterLLM', 'crasher', async () => {
          throw new Error('nope');
        });
      },
    };
    agent.use(badExtension);

    try {
      await agent.run({ message: 'Hi' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HookError);
      const he = err as HookError;
      expect(he.extensionName).toBe('crasher');
      expect(he.hookName).toBe('afterLLM');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// 12. Hook mutation
// ─────────────────────────────────────────────────────────────────────

describe('12. Hook mutation', () => {
  it('afterLLM hook can mutate the model response content', async () => {
    const model = new MockModel([textResponse('original')]);
    const agent = new Agent({ model });

    const censorExtension: Extension = {
      name: 'censor',
      install(a) {
        a.hook('afterLLM', 'censor', async (ctx) => {
          if (ctx.modelResponse) {
            ctx.modelResponse.message.content = 'CENSORED';
          }
        });
      },
    };
    agent.use(censorExtension);

    const result = await agent.run({ message: 'Hi' });

    expect(result.message).toBe('CENSORED');
  });

  it('beforeTool hook can short-circuit with a synthetic result', async () => {
    const model = new MockModel([
      toolCallResponse([toolCall('tc1', 'expensive')]),
      textResponse('ok'),
    ]);
    const agent = new Agent({
      model,
      tools: [makeTool('expensive', async () => 'REAL EXPENSIVE RESULT')],
    });

    const interceptExtension: Extension = {
      name: 'intercept',
      install(a) {
        a.hook('beforeTool', 'intercept', async (ctx) => {
          if (ctx.toolCall?.name === 'expensive') {
            return {
              skip: true,
              value: { toolCallId: ctx.toolCall.id, content: 'CACHED RESULT' },
            };
          }
        });
      },
    };
    agent.use(interceptExtension);

    const result = await agent.run({ message: 'run expensive op' });

    // The tool was never actually executed — cached result was used.
    const toolMsg = model.receivedCalls[1].messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('CACHED RESULT');
  });

  it('beforeLLM hook can short-circuit with a synthetic response', async () => {
    const model = new MockModel([textResponse('should not be called')]);
    const agent = new Agent({ model });

    const stubExtension: Extension = {
      name: 'stub',
      install(a) {
        a.hook('beforeLLM', 'stub', async () => ({
          skip: true,
          value: textResponse('STUBBED RESPONSE'),
        }));
      },
    };
    agent.use(stubExtension);

    const result = await agent.run({ message: 'Hi' });

    expect(result.message).toBe('STUBBED RESPONSE');
    expect(model.callCount).toBe(0); // model was never called
  });
});

// ─────────────────────────────────────────────────────────────────────
// 13. Multiple independent agents in one process
// ─────────────────────────────────────────────────────────────────────

describe('13. Multiple independent agents in one process', () => {
  it('runs two agents with different models independently', async () => {
    const modelA = new MockModel([textResponse('Agent A says hello')]);
    const modelB = new MockModel([textResponse('Agent B says goodbye')]);

    const agentA = new Agent({ model: modelA, systemPrompt: 'You are A.' });
    const agentB = new Agent({ model: modelB, systemPrompt: 'You are B.' });

    const [resultA, resultB] = await Promise.all([
      agentA.run({ message: 'Hi' }),
      agentB.run({ message: 'Hi' }),
    ]);

    expect(resultA.message).toBe('Agent A says hello');
    expect(resultB.message).toBe('Agent B says goodbye');
    expect(modelA.receivedCalls[0].systemPrompt).toBe('You are A.');
    expect(modelB.receivedCalls[0].systemPrompt).toBe('You are B.');
  });

  it('agents have independent tools and extensions', async () => {
    const modelA = new MockModel([
      toolCallResponse([toolCall('tc1', 'toolA')]),
      textResponse('A done'),
    ]);
    const modelB = new MockModel([textResponse('B done')]);

    const agentA = new Agent({
      model: modelA,
      tools: [makeTool('toolA', async () => 'A tool result')],
    });
    const agentB = new Agent({ model: modelB });

    const resultA = await agentA.run({ message: 'use tool' });
    const resultB = await agentB.run({ message: 'use tool' });

    expect(resultA.message).toBe('A done');
    expect(resultB.message).toBe('B done');
    // Agent B's model was never offered toolA.
    expect(modelB.receivedCalls[0].tools).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 14. Agent calling another agent locally
// ─────────────────────────────────────────────────────────────────────

describe('14. Agent calling another agent locally', () => {
  it('an agent can call another agent as a tool, in-process', async () => {
    // Inner agent: the "research" agent.
    const researchModel = new MockModel([textResponse('Research complete: the sky is blue.')]);
    const researchAgent = new Agent({
      model: researchModel,
      systemPrompt: 'You are a research agent.',
    });

    // Outer agent: calls the research agent via a tool.
    const outerModel = new MockModel([
      toolCallResponse([toolCall('tc1', 'research', { query: 'What color is the sky?' })]),
      textResponse('Based on research, the sky is blue.'),
    ]);
    const outerAgent = new Agent({
      model: outerModel,
      tools: [
        {
          name: 'research',
          description: 'Delegate a research question to the research agent.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
          async execute(args) {
            const res = await researchAgent.run({ message: String(args.query) });
            return { toolCallId: '', content: res.message };
          },
        },
      ],
    });

    const result = await outerAgent.run({ message: 'What color is the sky?' });

    expect(result.message).toBe('Based on research, the sky is blue.');
    expect(result.iterations).toBe(2);

    // Verify the research agent was actually called.
    expect(researchModel.callCount).toBe(1);
    expect(researchModel.receivedCalls[0].messages[0]).toEqual({
      role: 'user',
      content: 'What color is the sky?',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// 15. Steering
// ─────────────────────────────────────────────────────────────────────

describe('15. Steering (mid-turn redirection)', () => {
  it('injects a steering message before the next LLM iteration', async () => {
    // First LLM call: requests a tool. After the tool result, before the
    // second LLM call, we steer. The second call should see the steering msg.
    const model = new MockModel([
      toolCallResponse([toolCall('tc1', 'work')]),
      (req) => {
        // Verify the steering message was injected.
        const steeringMsg = req.messages.find(
          (m) => m.role === 'user' && m.content === '[STEER] Stop, just say done.',
        );
        if (!steeringMsg) throw new Error('steering message not found in second call');
        return textResponse('done');
      },
    ]);
    const agent = new Agent({
      model,
      tools: [makeTool('work', async () => 'working...')],
    });

    const promise = agent.run({ message: 'do work' });

    // Steer while the turn is active (after the first tool call completes).
    // We use a microtask to ensure the turn has started.
    queueMicrotask(() => {
      agent.steer('[STEER] Stop, just say done.');
    });

    const result = await promise;

    expect(result.message).toBe('done');
    expect(result.finishReason).toBe('stop');
  });

  it('steer is a no-op when no turn is active', async () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });

    // Should not throw.
    agent.steer('hello');

    const result = await agent.run({ message: 'Hi' });
    expect(result.message).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 16. Halting
// ─────────────────────────────────────────────────────────────────────

describe('16. Halting (mid-turn cancellation)', () => {
  it('halts via agent.halt() and returns finishReason "halted"', async () => {
    // Model requests a tool, then we halt before the next iteration.
    const model = new MockModel([
      toolCallResponse([toolCall('tc1', 'work')]),
      textResponse('should not reach'),
    ]);
    const agent = new Agent({
      model,
      tools: [makeTool('work', async () => 'working...')],
    });

    // Halt after the first LLM response (which requested a tool).
    const haltExtension: Extension = {
      name: 'halt',
      install(a) {
        a.hook('afterLLM', 'halt', async () => {
          agent.halt('user cancelled');
        });
      },
    };
    agent.use(haltExtension);

    const result = await agent.run({ message: 'do work' });

    expect(result.finishReason).toBe('halted');
    expect(result.iterations).toBe(1); // one LLM call happened before halt
    // Model was only called once — the second call never happened.
    expect(model.callCount).toBe(1);
  });

  it('halts via AbortSignal in the request', async () => {
    const controller = new AbortController();
    const model = new MockModel([textResponse('should not reach')]);
    const agent = new Agent({ model });

    const promise = agent.run({ message: 'Hi', signal: controller.signal });

    controller.abort('cancelled');

    const result = await promise;

    expect(result.finishReason).toBe('halted');
  });

  it('halt is a no-op when no turn is active', async () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });

    // Should not throw.
    agent.halt('no active turn');

    const result = await agent.run({ message: 'Hi' });
    expect(result.finishReason).toBe('stop');
  });

  it('respects maxIterations', async () => {
    // Model always requests a tool — will hit the iteration cap.
    const model = new MockModel([
      toolCallResponse([toolCall('tc1', 'loop')]),
      toolCallResponse([toolCall('tc2', 'loop')]),
      toolCallResponse([toolCall('tc3', 'loop')]),
    ]);
    const agent = new Agent({
      model,
      tools: [makeTool('loop', async () => 'looping')],
      maxIterations: 2,
    });

    const result = await agent.run({ message: 'loop' });

    expect(result.finishReason).toBe('max_iterations');
    expect(result.iterations).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 17. beforeResponse hook
// ─────────────────────────────────────────────────────────────────────

describe('17. beforeResponse hook', () => {
  it('can modify the final response before it is returned', async () => {
    const model = new MockModel([textResponse('original response')]);
    const agent = new Agent({ model });

    const rewriteExtension: Extension = {
      name: 'rewriter',
      install(a) {
        a.hook('beforeResponse', 'rewriter', async (ctx) => {
          if (ctx.turn.response) {
            ctx.turn.response.message = 'REWRITTEN';
          }
        });
      },
    };
    agent.use(rewriteExtension);

    const result = await agent.run({ message: 'Hi' });

    expect(result.message).toBe('REWRITTEN');
  });

  it('fires before afterTurn and can observe finishReason', async () => {
    const model = new MockModel([textResponse('done')]);
    const agent = new Agent({ model });

    const observed: string[] = [];
    const order: string[] = [];

    const observerExtension: Extension = {
      name: 'observer',
      install(a) {
        a.hook('beforeResponse', 'observer', async (ctx) => {
          order.push('beforeResponse');
          if (ctx.turn.response) {
            observed.push(ctx.turn.response.finishReason);
          }
        });
        a.hook('afterTurn', 'observer', async () => {
          order.push('afterTurn');
        });
      },
    };
    agent.use(observerExtension);

    await agent.run({ message: 'Hi' });

    expect(order).toEqual(['beforeResponse', 'afterTurn']);
    expect(observed).toEqual(['stop']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 18. afterTool hook mutation
// ─────────────────────────────────────────────────────────────────────

describe('18. afterTool hook mutation', () => {
  it('can modify the tool result after execution', async () => {
    const model = new MockModel([
      toolCallResponse([toolCall('tc1', 'fetch')]),
      textResponse('Done'),
    ]);
    const agent = new Agent({
      model,
      tools: [makeTool('fetch', async () => 'raw data')],
    });

    const transformExtension: Extension = {
      name: 'transform',
      install(a) {
        a.hook('afterTool', 'transform', async (ctx) => {
          if (ctx.toolResult) {
            ctx.toolResult.content = `[PROCESSED] ${ctx.toolResult.content}`;
          }
        });
      },
    };
    agent.use(transformExtension);

    await agent.run({ message: 'fetch data' });

    const toolMsg = model.receivedCalls[1].messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('[PROCESSED] raw data');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 19. Concurrent RunHandle steer/halt independence
// ─────────────────────────────────────────────────────────────────────

describe('19. Concurrent RunHandle steer/halt independence', () => {
  it('two agents running concurrently can be steered via their own RunHandles', async () => {
    const modelA = new MockModel([
      toolCallResponse([toolCall('tc1', 'work')]),
      (req) => {
        const steerMsg = req.messages.find((m) => m.role === 'user' && m.content === 'steer-A');
        if (!steerMsg) throw new Error('steer-A not found');
        return textResponse('A done');
      },
    ]);
    const modelB = new MockModel([
      toolCallResponse([toolCall('tc1', 'work')]),
      (req) => {
        const steerMsg = req.messages.find((m) => m.role === 'user' && m.content === 'steer-B');
        if (!steerMsg) throw new Error('steer-B not found');
        return textResponse('B done');
      },
    ]);

    const agentA = new Agent({ model: modelA, tools: [makeTool('work', async () => 'working')] });
    const agentB = new Agent({ model: modelB, tools: [makeTool('work', async () => 'working')] });

    const handleA = agentA.run({ message: 'do work' });
    const handleB = agentB.run({ message: 'do work' });

    queueMicrotask(() => {
      handleA.steer('steer-A');
      handleB.steer('steer-B');
    });

    const [resultA, resultB] = await Promise.all([handleA, handleB]);

    expect(resultA.message).toBe('A done');
    expect(resultB.message).toBe('B done');
  });

  it('halting one RunHandle does not halt the other', async () => {
    const modelA = new MockModel([
      toolCallResponse([toolCall('tc1', 'work')]),
      textResponse('should not reach A'),
    ]);
    const modelB = new MockModel([textResponse('B done')]);

    const agentA = new Agent({ model: modelA, tools: [makeTool('work', async () => 'working')] });
    const agentB = new Agent({ model: modelB });

    const handleA = agentA.run({ message: 'do work' });
    const handleB = agentB.run({ message: 'do work' });

    queueMicrotask(() => {
      handleA.halt('cancelled A');
    });

    const [resultA, resultB] = await Promise.all([handleA, handleB]);

    expect(resultA.finishReason).toBe('halted');
    expect(resultB.finishReason).toBe('stop');
    expect(resultB.message).toBe('B done');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 20. TurnContext-level steer/halt
// ─────────────────────────────────────────────────────────────────────

describe('20. TurnContext-level steer/halt', () => {
  it('hooks can steer via ctx.turn.steer()', async () => {
    const model = new MockModel([
      toolCallResponse([toolCall('tc1', 'work')]),
      (req) => {
        const steerMsg = req.messages.find(
          (m) => m.role === 'user' && m.content === 'turn-level steer',
        );
        if (!steerMsg) throw new Error('turn-level steer not found');
        return textResponse('steered');
      },
    ]);
    const agent = new Agent({
      model,
      tools: [makeTool('work', async () => 'working')],
    });

    const steerExtension: Extension = {
      name: 'steerer',
      install(a) {
        a.hook('afterTool', 'steerer', async (ctx) => {
          ctx.turn.steer('turn-level steer');
        });
      },
    };
    agent.use(steerExtension);

    const result = await agent.run({ message: 'do work' });

    expect(result.message).toBe('steered');
  });

  it('hooks can halt via ctx.turn.halt()', async () => {
    const model = new MockModel([
      toolCallResponse([toolCall('tc1', 'work')]),
      textResponse('should not reach'),
    ]);
    const agent = new Agent({
      model,
      tools: [makeTool('work', async () => 'working')],
    });

    const haltExtension: Extension = {
      name: 'halter',
      install(a) {
        a.hook('afterTool', 'halter', async (ctx) => {
          ctx.turn.halt('done enough');
        });
      },
    };
    agent.use(haltExtension);

    const result = await agent.run({ message: 'do work' });

    expect(result.finishReason).toBe('halted');
    expect(result.iterations).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 21. Error observation and recovery (onError hook)
// ─────────────────────────────────────────────────────────────────────

describe('21. Error observation and recovery (onError hook)', () => {
  it('onError hook can observe a model error', async () => {
    const model = new MockModel([textResponse('ok')]);
    model.generate = async () => {
      throw new Error('model exploded');
    };
    const agent = new Agent({ model, errorPolicy: 'throw' });

    const observed: unknown[] = [];
    const observerExtension: Extension = {
      name: 'error-observer',
      install(a) {
        a.hook('onError', 'error-observer', async (ctx) => {
          if (ctx.error) observed.push(ctx.error);
        });
      },
    };
    agent.use(observerExtension);

    await expect(agent.run({ message: 'Hi' })).rejects.toThrow('model exploded');
    expect(observed).toHaveLength(1);
    expect((observed[0] as Error).message).toBe('model exploded');
  });

  it('onError hook can recover from a model error with a fallback response', async () => {
    const model = new MockModel([textResponse('ok')]);
    model.generate = async () => {
      throw new Error('model unavailable');
    };
    const agent = new Agent({ model });

    const fallbackExtension: Extension = {
      name: 'fallback',
      install(a) {
        a.hook('onError', 'fallback', async (ctx) => {
          if (ctx.error instanceof Error && ctx.error.message.includes('model unavailable')) {
            return {
              skip: true,
              value: {
                role: 'assistant' as const,
                message: 'Sorry, the model is temporarily unavailable.',
                finishReason: 'stop' as const,
                iterations: 0,
                metadata: ctx.turn.metadata,
              },
            };
          }
        });
      },
    };
    agent.use(fallbackExtension);

    const result = await agent.run({ message: 'Hi' });

    expect(result.message).toBe('Sorry, the model is temporarily unavailable.');
    expect(result.finishReason).toBe('stop');
  });

  it('onError hook can observe a hook error from another extension', async () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model, errorPolicy: 'throw' });

    const observed: string[] = [];

    const crasherExtension: Extension = {
      name: 'crasher',
      install(a) {
        a.hook('beforeLLM', 'crasher', async () => {
          throw new Error('hook crashed');
        });
      },
    };
    const errorObserverExtension: Extension = {
      name: 'error-observer',
      install(a) {
        a.hook('onError', 'error-observer', async (ctx) => {
          if (ctx.error instanceof HookError) {
            observed.push(ctx.error.message);
          }
        });
      },
    };
    agent.use(crasherExtension);
    agent.use(errorObserverExtension);

    await expect(agent.run({ message: 'Hi' })).rejects.toThrow(HookError);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toContain('hook crashed');
  });

  it('afterTurn fires after onError recovery', async () => {
    const model = new MockModel([textResponse('ok')]);
    model.generate = async () => {
      throw new Error('boom');
    };
    const agent = new Agent({ model });

    const afterTurnFired = { value: false };
    const recoveryExtension: Extension = {
      name: 'recovery',
      install(a) {
        a.hook('onError', 'recovery', async (ctx) => ({
          skip: true,
          value: {
            role: 'assistant' as const,
            message: 'recovered',
            finishReason: 'stop' as const,
            iterations: 0,
            metadata: ctx.turn.metadata,
          },
        }));
        a.hook('afterTurn', 'recovery', async () => {
          afterTurnFired.value = true;
        });
      },
    };
    agent.use(recoveryExtension);

    const result = await agent.run({ message: 'Hi' });

    expect(result.message).toBe('recovered');
    expect(afterTurnFired.value).toBe(true);
  });

  it('multiple onError hooks run in order; first recovery wins', async () => {
    const model = new MockModel([textResponse('ok')]);
    model.generate = async () => {
      throw new Error('fail');
    };
    const agent = new Agent({ model });

    const order: string[] = [];

    const extA: Extension = {
      name: 'A',
      install(a) {
        a.hook('onError', 'A', async (ctx) => {
          order.push('A');
          return {
            skip: true,
            value: {
              role: 'assistant' as const,
              message: 'A recovered',
              finishReason: 'stop' as const,
              iterations: 0,
              metadata: ctx.turn.metadata,
            },
          };
        });
      },
    };
    const extB: Extension = {
      name: 'B',
      install(a) {
        a.hook('onError', 'B', async () => {
          order.push('B');
        });
      },
    };
    agent.use(extA).use(extB);

    const result = await agent.run({ message: 'Hi' });

    expect(result.message).toBe('A recovered');
    expect(order).toEqual(['A']);
  });

  // ── Default error policy (fallback) ──

  it('default errorPolicy returns a fallback response instead of throwing', async () => {
    const model = new MockModel([textResponse('ok')]);
    model.generate = async () => {
      throw new Error('model down');
    };
    const agent = new Agent({ model });

    const result = await agent.run({ message: 'Hi' });

    expect(result.finishReason).toBe('error');
    expect(result.message).toBe('Sorry, I encountered an error. Please try again.');
    expect(result.metadata.error).toBeInstanceOf(Error);
    expect((result.metadata.error as Error).message).toBe('model down');
  });

  it('errorPolicy: "throw" rethrows when no hook recovers', async () => {
    const model = new MockModel([textResponse('ok')]);
    model.generate = async () => {
      throw new Error('strict fail');
    };
    const agent = new Agent({ model, errorPolicy: 'throw' });

    await expect(agent.run({ message: 'Hi' })).rejects.toThrow('strict fail');
  });

  it('custom fallbackMessage is used by the fallback policy', async () => {
    const model = new MockModel([textResponse('ok')]);
    model.generate = async () => {
      throw new Error('boom');
    };
    const agent = new Agent({ model, fallbackMessage: 'Whoops!' });

    const result = await agent.run({ message: 'Hi' });

    expect(result.message).toBe('Whoops!');
    expect(result.finishReason).toBe('error');
  });

  it('custom errorPolicy function can recover with a tailored response', async () => {
    const model = new MockModel([textResponse('ok')]);
    model.generate = async () => {
      throw new Error('rate limited');
    };
    const agent = new Agent({
      model,
      errorPolicy: ({ error }) => ({
        role: 'assistant',
        message: `Custom recovery: ${(error as Error).message}`,
        finishReason: 'error',
        iterations: 0,
        metadata: {},
      }),
    });

    const result = await agent.run({ message: 'Hi' });

    expect(result.message).toBe('Custom recovery: rate limited');
    expect(result.finishReason).toBe('error');
  });

  it('custom errorPolicy function returning undefined rethrows', async () => {
    const model = new MockModel([textResponse('ok')]);
    model.generate = async () => {
      throw new Error('nope');
    };
    const agent = new Agent({
      model,
      errorPolicy: () => undefined,
    });

    await expect(agent.run({ message: 'Hi' })).rejects.toThrow('nope');
  });

  it('onError hook recovery takes precedence over errorPolicy fallback', async () => {
    const model = new MockModel([textResponse('ok')]);
    model.generate = async () => {
      throw new Error('fail');
    };
    const agent = new Agent({ model }); // default 'fallback' policy

    const recoveryExtension: Extension = {
      name: 'recovery',
      install(a) {
        a.hook('onError', 'recovery', async () => ({
          skip: true,
          value: {
            role: 'assistant' as const,
            message: 'Hook recovered this',
            finishReason: 'stop' as const,
            iterations: 0,
            metadata: {},
          },
        }));
      },
    };
    agent.use(recoveryExtension);

    const result = await agent.run({ message: 'Hi' });

    expect(result.message).toBe('Hook recovered this');
    expect(result.finishReason).toBe('stop');
  });

  it('afterTurn fires after default fallback policy', async () => {
    const model = new MockModel([textResponse('ok')]);
    model.generate = async () => {
      throw new Error('boom');
    };
    const agent = new Agent({ model });

    const afterTurnFired = { value: false };
    const observerExtension: Extension = {
      name: 'observer',
      install(a) {
        a.hook('afterTurn', 'observer', async () => {
          afterTurnFired.value = true;
        });
      },
    };
    agent.use(observerExtension);

    const result = await agent.run({ message: 'Hi' });

    expect(result.finishReason).toBe('error');
    expect(afterTurnFired.value).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 22. Halt edge cases — afterTurn, mid-hook, tool batch prevention
// ─────────────────────────────────────────────────────────────────────

describe('22. Halt edge cases', () => {
  it('afterTurn fires when turn is halted', async () => {
    const model = new MockModel([
      toolCallResponse([toolCall('tc1', 'work')]),
      textResponse('should not reach'),
    ]);
    const agent = new Agent({
      model,
      tools: [makeTool('work', async () => 'working')],
    });

    const afterTurnFired = { value: false };
    const observerExtension: Extension = {
      name: 'observer',
      install(a) {
        a.hook('afterLLM', 'observer', async (ctx) => {
          ctx.turn.halt('cancelled');
        });
        a.hook('afterTurn', 'observer', async () => {
          afterTurnFired.value = true;
        });
      },
    };
    agent.use(observerExtension);

    const result = await agent.run({ message: 'do work' });

    expect(result.finishReason).toBe('halted');
    expect(afterTurnFired.value).toBe(true);
  });

  it('afterTurn fires when turn hits maxIterations', async () => {
    const model = new MockModel([
      toolCallResponse([toolCall('tc1', 'loop')]),
      toolCallResponse([toolCall('tc2', 'loop')]),
    ]);
    const agent = new Agent({
      model,
      tools: [makeTool('loop', async () => 'looping')],
      maxIterations: 2,
    });

    const afterTurnFired = { value: false };
    const observerExtension: Extension = {
      name: 'observer',
      install(a) {
        a.hook('afterTurn', 'observer', async () => {
          afterTurnFired.value = true;
        });
      },
    };
    agent.use(observerExtension);

    const result = await agent.run({ message: 'loop' });

    expect(result.finishReason).toBe('max_iterations');
    expect(afterTurnFired.value).toBe(true);
  });

  it('halt during afterLLM with no tool calls returns "halted" not "stop"', async () => {
    const model = new MockModel([textResponse('final answer')]);
    const agent = new Agent({ model });

    const haltExtension: Extension = {
      name: 'halter',
      install(a) {
        a.hook('afterLLM', 'halter', async (ctx) => {
          ctx.turn.halt('done');
        });
      },
    };
    agent.use(haltExtension);

    const result = await agent.run({ message: 'Hi' });

    expect(result.finishReason).toBe('halted');
    expect(result.message).toBe('final answer');
  });

  it('halt during beforeLLM prevents the model call', async () => {
    const model = new MockModel([textResponse('should not reach')]);
    const agent = new Agent({ model });

    const haltExtension: Extension = {
      name: 'halter',
      install(a) {
        a.hook('beforeLLM', 'halter', async (ctx) => {
          ctx.turn.halt('cancelled before model');
        });
      },
    };
    agent.use(haltExtension);

    const result = await agent.run({ message: 'Hi' });

    expect(result.finishReason).toBe('halted');
    expect(model.callCount).toBe(0);
  });

  it('halt during tool execution prevents remaining tools in the batch', async () => {
    const callLog: string[] = [];
    const model = new MockModel([
      toolCallResponse([
        toolCall('tc1', 'slow'),
        toolCall('tc2', 'fast'),
        toolCall('tc3', 'fast'),
      ]),
      textResponse('done'),
    ]);
    const agent = new Agent({
      model,
      tools: [
        makeTool('slow', async () => {
          callLog.push('slow-start');
          await new Promise((r) => setTimeout(r, 50));
          callLog.push('slow-end');
          return 'slow result';
        }),
        makeTool('fast', async (args) => {
          callLog.push(`fast-${args._n ?? '?'}`);
          return 'fast result';
        }),
      ],
    });

    // Halt during afterTool of the first tool call.
    const haltExtension: Extension = {
      name: 'halter',
      install(a) {
        a.hook('afterTool', 'halter', async (ctx) => {
          if (ctx.toolCall?.name === 'slow') {
            ctx.turn.halt('done after slow');
          }
        });
      },
    };
    agent.use(haltExtension);

    const result = await agent.run({ message: 'run all' });

    expect(result.finishReason).toBe('halted');
    expect(callLog).toContain('slow-start');
    expect(callLog).toContain('slow-end');
    // Tools 2 and 3 should never have been called.
    expect(callLog).not.toContain('fast-2');
    expect(callLog).not.toContain('fast-3');
    expect(model.callCount).toBe(1);
  });

  it('halt during beforeTool prevents that tool and remaining tools', async () => {
    const callLog: string[] = [];
    const model = new MockModel([
      toolCallResponse([
        toolCall('tc1', 'a'),
        toolCall('tc2', 'b'),
      ]),
      textResponse('done'),
    ]);
    const agent = new Agent({
      model,
      tools: [
        makeTool('a', async () => { callLog.push('a'); return 'a result'; }),
        makeTool('b', async () => { callLog.push('b'); return 'b result'; }),
      ],
    });

    const haltExtension: Extension = {
      name: 'halter',
      install(a) {
        a.hook('beforeTool', 'halter', async (ctx) => {
          if (ctx.toolCall?.name === 'a') {
            ctx.turn.halt('cancelled before a');
          }
        });
      },
    };
    agent.use(haltExtension);

    const result = await agent.run({ message: 'run' });

    expect(result.finishReason).toBe('halted');
    expect(callLog).not.toContain('a');
    expect(callLog).not.toContain('b');
    expect(model.callCount).toBe(1);
  });

  it('beforeResponse fires on halted turn', async () => {
    const model = new MockModel([textResponse('response')]);
    const agent = new Agent({ model });

    const observed: string[] = [];
    const ext: Extension = {
      name: 'observer',
      install(a) {
        a.hook('afterLLM', 'observer', async (ctx) => {
          ctx.turn.halt('done');
        });
        a.hook('beforeResponse', 'observer', async (ctx) => {
          if (ctx.turn.response) {
            observed.push(ctx.turn.response.finishReason);
          }
        });
      },
    };
    agent.use(ext);

    const result = await agent.run({ message: 'Hi' });

    expect(result.finishReason).toBe('halted');
    expect(observed).toEqual(['halted']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 23. Error class coverage
// ─────────────────────────────────────────────────────────────────────

describe('23. Error class coverage', () => {
  it('LibraError sets name and message', () => {
    const err = new LibraError('something broke');
    expect(err.name).toBe('LibraError');
    expect(err.message).toBe('something broke');
    expect(err instanceof Error).toBe(true);
  });

  it('ModelError carries status and body', () => {
    const err = new ModelError('rate limited', 429, { detail: 'too many requests' });
    expect(err.name).toBe('ModelError');
    expect(err.status).toBe(429);
    expect(err.body).toEqual({ detail: 'too many requests' });
    expect(err instanceof LibraError).toBe(true);
  });

  it('ToolError carries toolName', () => {
    const err = new ToolError('failed', 'get_weather');
    expect(err.name).toBe('ToolError');
    expect(err.toolName).toBe('get_weather');
    expect(err instanceof LibraError).toBe(true);
  });

  it('HookError carries hookName, extensionName, and cause', () => {
    const cause = new Error('original');
    const err = new HookError('hook failed', 'beforeLLM', 'my-ext', cause);
    expect(err.name).toBe('HookError');
    expect(err.hookName).toBe('beforeLLM');
    expect(err.extensionName).toBe('my-ext');
    expect(err.cause).toBe(cause);
    expect(err instanceof LibraError).toBe(true);
  });

  it('HaltedError carries reason', () => {
    const err = new HaltedError('turn stopped', 'user cancelled');
    expect(err.name).toBe('HaltedError');
    expect(err.reason).toBe('user cancelled');
    expect(err instanceof LibraError).toBe(true);
  });

  it('MaxIterationsError carries iteration count', () => {
    const err = new MaxIterationsError('exceeded', 25);
    expect(err.name).toBe('MaxIterationsError');
    expect(err.iterations).toBe(25);
    expect(err instanceof LibraError).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 24. Agent edge cases for coverage
// ─────────────────────────────────────────────────────────────────────

describe('24. Agent edge cases for coverage', () => {
  it('throws when installing a duplicate extension', () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });
    const ext: Extension = {
      name: 'dup',
      install() {},
    };
    agent.use(ext);
    expect(() => agent.use(ext)).toThrow('already installed');
  });

  it('getTools returns all registered tool names', () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({
      model,
      tools: [makeTool('tool_a', () => 'a'), makeTool('tool_b', () => 'b')],
    });
    agent.tool(makeTool('tool_c', () => 'c'));
    expect(agent.getTools().sort()).toEqual(['tool_a', 'tool_b', 'tool_c']);
  });

  it('unload removes extension hooks and tools', async () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });
    const ext: Extension = {
      name: 'removable',
      install(a) {
        a.hook('beforeTurn', 'removable', async (ctx) => {
          ctx.turn.metadata.touched = true;
        });
        a.tool(makeTool('ext_tool', () => 'ext'));
      },
    };
    agent.use(ext);
    expect(agent.getTools()).toContain('ext_tool');

    // Run a turn — hook should fire.
    const r1 = await agent.run({ message: 'hi' });
    expect(r1.metadata?.touched).toBe(true);

    // Unload and run again — hook should NOT fire, tool should be gone.
    await agent.unload('removable');
    expect(agent.getTools()).not.toContain('ext_tool');
    const r2 = await agent.run({ message: 'hi' });
    expect(r2.metadata?.touched).toBeUndefined();
  });

  it('unload is a no-op for unknown extension', async () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });
    await expect(agent.unload('nonexistent')).resolves.toBe(agent);
  });

  it('unload allows re-installing the same extension', async () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });
    const ext: Extension = {
      name: 'recyclable',
      install(a) {
        a.tool(makeTool('rec_tool', () => 'rec'));
      },
    };
    agent.use(ext);
    await agent.unload('recyclable');
    expect(() => agent.use(ext)).not.toThrow();
    expect(agent.getTools()).toContain('rec_tool');
  });

  it('unload calls close() if the extension has one', async () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });
    let closed = false;
    const ext = {
      name: 'closeable',
      install() {},
      async close() { closed = true; },
    };
    agent.use(ext);
    await agent.unload('closeable');
    expect(closed).toBe(true);
  });

  it('isRunning is false when no turns are active', () => {
    const model = new MockModel([textResponse('ok')]);
    const agent = new Agent({ model });
    expect(agent.isRunning).toBe(false);
  });

  it('isRunning is true while a turn is active', async () => {
    const model = new MockModel([(req) => {
      // Delay so we can check isRunning mid-turn.
      return new Promise<ModelResponse>((resolve) => {
        setTimeout(() => resolve(textResponse('done')), 50);
      });
    }]);
    const agent = new Agent({ model });
    const handle = agent.run({ message: 'hi' });
    expect(agent.isRunning).toBe(true);
    await handle;
    expect(agent.isRunning).toBe(false);
  });

  it('returns error result when tool is not found', async () => {
    const model = new MockModel([
      toolCallResponse([toolCall('tc1', 'nonexistent_tool')]),
      textResponse('ok'),
    ]);
    const agent = new Agent({ model });
    const result = await agent.run({ message: 'call missing tool' });
    // The model should get the error result and produce a final response.
    expect(result.finishReason).toBe('stop');
    expect(model.receivedCalls[1].messages.some(
      (m) => m.role === 'tool' && m.content.includes('not found'),
    )).toBe(true);
  });

  it('returns error result when tool arguments are invalid JSON', async () => {
    const model = new MockModel([
      toolCallResponse([{ id: 'tc1', name: 'my_tool', arguments: '{invalid json' }]),
      textResponse('ok'),
    ]);
    const agent = new Agent({
      model,
      tools: [makeTool('my_tool', () => 'result')],
    });
    const result = await agent.run({ message: 'call tool with bad json' });
    expect(result.finishReason).toBe('stop');
    expect(model.receivedCalls[1].messages.some(
      (m) => m.role === 'tool' && m.content.includes('invalid JSON'),
    )).toBe(true);
  });

  it('returns error result when tool execute throws', async () => {
    const model = new MockModel([
      toolCallResponse([toolCall('tc1', 'boom_tool')]),
      textResponse('ok'),
    ]);
    const agent = new Agent({
      model,
      tools: [makeTool('boom_tool', () => { throw new Error('kaboom'); })],
    });
    const result = await agent.run({ message: 'call exploding tool' });
    expect(result.finishReason).toBe('stop');
    expect(model.receivedCalls[1].messages.some(
      (m) => m.role === 'tool' && m.content.includes('kaboom'),
    )).toBe(true);
  });

  it('returns error result when tool execute throws non-Error', async () => {
    const model = new MockModel([
      toolCallResponse([toolCall('tc1', 'string_throw')]),
      textResponse('ok'),
    ]);
    const agent = new Agent({
      model,
      tools: [makeTool('string_throw', () => { throw 'oops'; })],
    });
    const result = await agent.run({ message: 'call tool that throws string' });
    expect(result.finishReason).toBe('stop');
    expect(model.receivedCalls[1].messages.some(
      (m) => m.role === 'tool' && m.content.includes('Tool error: oops'),
    )).toBe(true);
  });

  it('halt prevents tool execution when already halted', async () => {
    const model = new MockModel([
      toolCallResponse([toolCall('tc1', 'slow_tool')]),
      textResponse('ok'),
    ]);
    const agent = new Agent({
      model,
      tools: [makeTool('slow_tool', () => 'should not run')],
    });
    // Halt during beforeTool so signal is aborted before tool runs.
    const haltExt: Extension = {
      name: 'halt-before-tool',
      install(a) {
        a.hook('beforeTool', 'halt-before-tool', async (ctx) => {
          ctx.turn.halt('cancelled before tool');
        });
      },
    };
    agent.use(haltExt);
    const result = await agent.run({ message: 'call tool then get halted' });
    expect(result.finishReason).toBe('halted');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 25. HookRegistry coverage
// ─────────────────────────────────────────────────────────────────────

describe('25. HookRegistry coverage', () => {
  it('has() returns false when no hooks registered', () => {
    const reg = new HookRegistry();
    expect(reg.has('beforeTurn')).toBe(false);
  });

  it('has() returns true when hooks are registered', () => {
    const reg = new HookRegistry();
    reg.register('beforeTurn', 'ext', async () => {});
    expect(reg.has('beforeTurn')).toBe(true);
  });

  it('entries() returns empty array for unregistered stage', () => {
    const reg = new HookRegistry();
    expect(reg.entries('afterTurn')).toEqual([]);
  });

  it('entries() sorts by priority descending, then registration order', () => {
    const reg = new HookRegistry();
    const h = async () => {};
    // Register in mixed priority order.
    reg.register('beforeTurn', 'low', h, -100);
    reg.register('beforeTurn', 'high', h, 100);
    reg.register('beforeTurn', 'mid', h, 0);
    reg.register('beforeTurn', 'high2', h, 100); // same priority as 'high'

    const entries = reg.entries('beforeTurn');
    expect(entries.map((e) => e.extensionName)).toEqual(['high', 'high2', 'mid', 'low']);
  });

  it('entries() with default priority (0) retains registration order', () => {
    const reg = new HookRegistry();
    const h = async () => {};
    reg.register('beforeTurn', 'A', h);
    reg.register('beforeTurn', 'B', h);
    reg.register('beforeTurn', 'C', h);

    const entries = reg.entries('beforeTurn');
    expect(entries.map((e) => e.extensionName)).toEqual(['A', 'B', 'C']);
  });

  it('unregister preserves priority ordering of remaining hooks', () => {
    const reg = new HookRegistry();
    const h = async () => {};
    reg.register('beforeTurn', 'low', h, -100);
    reg.register('beforeTurn', 'high', h, 100);
    reg.register('beforeTurn', 'mid', h, 0);

    reg.unregister('high');

    const entries = reg.entries('beforeTurn');
    expect(entries.map((e) => e.extensionName)).toEqual(['mid', 'low']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 26. createAgentTool — agent-as-tool with signal/metadata chaining
// ─────────────────────────────────────────────────────────────────────

describe('26. createAgentTool — agent-as-tool with signal/metadata chaining', () => {
  it('delegates to the inner agent and returns its response', async () => {
    const innerModel = new MockModel([textResponse('Research complete: cats are great')]);
    const innerAgent = new Agent({ model: innerModel });

    const outerModel = new MockModel([
      toolCallResponse([toolCall('tc1', 'research', { message: 'Research cats' })]),
      textResponse('Based on research: cats are great'),
    ]);
    const outerAgent = new Agent({
      model: outerModel,
      tools: [createAgentTool(innerAgent, {
        name: 'research',
        description: 'Delegate a research question',
      })],
    });

    const result = await outerAgent.run({ message: 'Research cats' });

    expect(result.message).toBe('Based on research: cats are great');
    expect(result.toolCalls?.map((tc) => tc.name)).toEqual(['research']);
    // Inner agent received the message from the tool args.
    expect(innerModel.receivedCalls[0].messages).toEqual([
      { role: 'user', content: 'Research cats' },
    ]);
  });

  it('chains metadata from the outer turn to the inner agent', async () => {
    let innerMetadata: Record<string, unknown> = {};
    const innerModel = new MockModel([textResponse('ok')]);
    const innerAgent = new Agent({ model: innerModel });
    innerAgent.hook('beforeTurn', 'meta-capture', async (ctx) => {
      innerMetadata = { ...ctx.turn.metadata };
    });

    const outerModel = new MockModel([
      toolCallResponse([toolCall('tc1', 'delegate')]),
      textResponse('done'),
    ]);
    const outerAgent = new Agent({
      model: outerModel,
      tools: [createAgentTool(innerAgent, {
        name: 'delegate',
        description: 'Delegate',
      })],
    });

    await outerAgent.run({
      message: 'do something',
      metadata: { sessionId: 'test-123', userId: 'alice' },
    });

    expect(innerMetadata).toMatchObject({ sessionId: 'test-123', userId: 'alice' });
  });

  it('halts the inner agent when the outer turn is halted', async () => {
    // Inner model delays so we can halt mid-turn.
    const innerModel = new MockModel([() => {
      return new Promise<ModelResponse>((resolve) => {
        setTimeout(() => resolve(textResponse('should not finish')), 200);
      });
    }]);
    const innerAgent = new Agent({ model: innerModel });

    const outerModel = new MockModel([
      toolCallResponse([toolCall('tc1', 'delegate')]),
      textResponse('done'),
    ]);
    const outerAgent = new Agent({
      model: outerModel,
      tools: [createAgentTool(innerAgent, {
        name: 'delegate',
        description: 'Delegate',
      })],
    });

    const handle = outerAgent.run({ message: 'delegate something' });
    // Halt the outer turn while the inner agent is running.
    setTimeout(() => handle.halt('outer cancelled'), 50);

    const result = await handle;

    expect(result.finishReason).toBe('halted');
  });

  it('returns error result when inner agent is halted by its own hooks', async () => {
    const innerModel = new MockModel([textResponse('should not reach')]);
    const innerAgent = new Agent({ model: innerModel });
    innerAgent.hook('beforeLLM', 'halt-inner', async (ctx) => {
      ctx.turn.halt('inner halted');
    });

    const outerModel = new MockModel([
      toolCallResponse([toolCall('tc1', 'delegate')]),
      textResponse('The subagent was halted, trying another approach'),
    ]);
    const outerAgent = new Agent({
      model: outerModel,
      tools: [createAgentTool(innerAgent, {
        name: 'delegate',
        description: 'Delegate',
      })],
    });

    const result = await outerAgent.run({ message: 'delegate something' });

    // Outer agent should see the error and produce a final response.
    expect(result.finishReason).toBe('stop');
    expect(result.message).toContain('halted');
    // The tool result should have been an error.
    expect(outerModel.receivedCalls[1].messages.some(
      (m) => m.role === 'tool' && m.content.includes('halted'),
    )).toBe(true);
  });

  it('respects custom parameters schema', async () => {
    const innerModel = new MockModel([textResponse('result')]);
    const innerAgent = new Agent({ model: innerModel });

    const outerModel = new MockModel([
      toolCallResponse([toolCall('tc1', 'analyze', { input: 'test data' })]),
      textResponse('done'),
    ]);
    const outerAgent = new Agent({
      model: outerModel,
      tools: [createAgentTool(innerAgent, {
        name: 'analyze',
        description: 'Analyze data',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Data to analyze' },
          },
          required: ['input'],
        },
      })],
    });

    await outerAgent.run({ message: 'analyze this' });

    // Inner agent receives the args — since `input` is not `message` or `query`,
    // the args are JSON-stringified.
    expect(innerModel.receivedCalls[0].messages).toEqual([
      { role: 'user', content: JSON.stringify({ input: 'test data' }) },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 27. External tools (pass-through tool calls to the caller)
// ─────────────────────────────────────────────────────────────────────

describe('27. External tools (pass-through tool calls)', () => {
  it('returns tool_calls finish reason and does not execute external tools', async () => {
    const model = new MockModel([
      toolCallResponse([toolCall('ext-1', 'client_tool', { x: 1 })]),
    ]);
    const agent = new Agent({
      model,
      tools: [{
        name: 'client_tool',
        parameters: { type: 'object', properties: { x: { type: 'number' } } },
        external: true,
        async execute() { return { toolCallId: '', content: 'should not run' }; },
      }],
    });

    const result = await agent.run({ message: 'use the client tool' });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.pendingToolCalls).toEqual([
      { id: 'ext-1', name: 'client_tool', arguments: '{"x":1}' },
    ]);
    // The external tool's execute should never have been called.
    expect(result.message).toBe('');
  });

  it('executes internal tools in the same batch and returns external ones', async () => {
    const model = new MockModel([
      toolCallResponse([
        toolCall('int-1', 'internal_tool'),
        toolCall('ext-1', 'external_tool'),
      ]),
    ]);
    const agent = new Agent({
      model,
      tools: [
        {
          name: 'internal_tool',
          parameters: { type: 'object', properties: {} },
          async execute() { return { toolCallId: '', content: 'internal result' }; },
        },
        {
          name: 'external_tool',
          parameters: { type: 'object', properties: {} },
          external: true,
          async execute() { return { toolCallId: '', content: 'should not run' }; },
        },
      ],
    });

    const result = await agent.run({ message: 'use both tools' });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.pendingToolCalls).toEqual([
      { id: 'ext-1', name: 'external_tool', arguments: '{}' },
    ]);
    // The internal tool was executed — its result is in the messages.
    expect(result.toolCalls).toContainEqual({ id: 'int-1', name: 'internal_tool', arguments: '{}' });
  });

  it('resumes the turn when tool results are sent back', async () => {
    const model = new MockModel([
      toolCallResponse([toolCall('ext-1', 'client_tool', { q: 'hello' })]),
      textResponse('Based on the result: hello world'),
    ]);
    const agent = new Agent({
      model,
      tools: [{
        name: 'client_tool',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        external: true,
        async execute() { return { toolCallId: '', content: '' }; },
      }],
    });

    // First turn — model calls the external tool.
    const result1 = await agent.run({ message: 'search for hello' });
    expect(result1.finishReason).toBe('tool_calls');
    expect(result1.pendingToolCalls).toHaveLength(1);

    // Second turn — client sends the tool result back.
    // The history includes the original user message, the assistant tool call,
    // and the tool result from the client.
    const result2 = await agent.run({
      message: 'search for hello',
      metadata: {
        openaiCompatibleProviderMessages: [
          { role: 'user', content: 'search for hello' },
          { role: 'assistant', content: '', toolCalls: result1.pendingToolCalls },
          { role: 'tool', content: 'hello world', toolCallId: 'ext-1', name: 'client_tool' },
        ],
      },
    });
    expect(result2.finishReason).toBe('stop');
    expect(result2.message).toBe('Based on the result: hello world');
  });
});
