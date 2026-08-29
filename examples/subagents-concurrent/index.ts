import { readFileSync } from 'node:fs';
import { Agent, createAgentTool, type Tool } from '@xandout/libra-harness';
import { resolveModel } from '@xandout/libra-harness/extras/models';
import { createLoggerExtension } from '@xandout/libra-harness/extras/logger';

// Load .env if present.
try {
  const env = readFileSync(new URL('./.env', import.meta.url), 'utf-8');
  for (const line of env.split('\n')) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      let val = match[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[match[1]] = val;
    }
  }
} catch {}

const model = await resolveModel(process.env.MODEL ?? 'deepseek/deepseek-v4-flash');

// ── Shared logging extension ──
const loggingExtension = createLoggerExtension();

// ── Specialized subagents ──────────────────────────────────────────

const researchAgent = new Agent({
  model,
  systemPrompt:
    'You are a research agent. Provide concise, factual answers under 150 words.',
  maxIterations: 5,
});
researchAgent.use(loggingExtension);

const codeAgent = new Agent({
  model,
  systemPrompt:
    'You are a code agent. Write clean code with brief explanations.',
  maxIterations: 5,
});
codeAgent.use(loggingExtension);

const criticAgent = new Agent({
  model,
  systemPrompt:
    'You are a critic agent. Review content and provide specific, actionable feedback under 150 words.',
  maxIterations: 3,
});
criticAgent.use(loggingExtension);

// ── Concurrent fan-out tool ────────────────────────────────────────
// This tool runs multiple subagents in parallel using Promise.all.
// The outer agent's AbortSignal is forwarded to each subagent, so
// halting the orchestrator halts all concurrent subagents at once.

function createConcurrentTool(
  agents: { agent: Agent; name: string; description: string }[],
  options: {
    name: string;
    description: string;
  },
): Tool {
  return {
    name: options.name,
    description: options.description,
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to send to all subagents simultaneously.',
        },
      },
      required: ['message'],
    },
    async execute(args, ctx) {
      const message = String(args.message ?? '');

      // Fan out — all subagents run concurrently.
      // Signal and metadata are shared, so halting the outer turn
      // halts every subagent in flight.
      const results = await Promise.all(
        agents.map(async ({ agent, name }) => {
          try {
            const result = await agent.run({
              message,
              signal: ctx.signal,
              metadata: { ...ctx.metadata, agentName: name },
            });
            return { name, content: result.message, halted: result.finishReason === 'halted' };
          } catch {
            return { name, content: '(error)', halted: true };
          }
        }),
      );

      // Format results so the orchestrator can synthesize them.
      const summary = results
        .map((r) => `### ${r.name}\n${r.halted ? '(halted)' : r.content}`)
        .join('\n\n---\n\n');

      return {
        toolCallId: '',
        content: summary,
      };
    },
  };
}

// ── Orchestrator ───────────────────────────────────────────────────

const orchestrator = new Agent({
  model,
  systemPrompt:
    'You are an orchestrator agent. You have two tools:\n' +
    '- fanout: Send a message to research, code, and critic subagents simultaneously. They run in parallel.\n' +
    '- research: Delegate to a single research agent.\n' +
    '- code: Delegate to a single code agent.\n\n' +
    'Use fanout when you want multiple perspectives on the same question at once. ' +
    'Synthesize the responses into a final answer.',
  tools: [
    createConcurrentTool(
      [
        { agent: researchAgent, name: 'research', description: 'Research agent' },
        { agent: codeAgent, name: 'code', description: 'Code agent' },
        { agent: criticAgent, name: 'critic', description: 'Critic agent' },
      ],
      {
        name: 'fanout',
        description:
          'Send a message to research, code, and critic subagents simultaneously. ' +
          'All three run in parallel and return their responses together.',
      },
    ),
    createAgentTool(researchAgent, {
      name: 'research',
      description: 'Delegate to a single research agent.',
    }),
    createAgentTool(codeAgent, {
      name: 'code',
      description: 'Delegate to a single code agent.',
    }),
  ],
  maxIterations: 10,
});
orchestrator.use(loggingExtension);

// ── Demo ───────────────────────────────────────────────────────────

async function main() {
  console.log('=== Concurrent Subagents Demo ===\n');
  console.log('The orchestrator fans out to multiple subagents in parallel.\n');

  // Demo 1: Concurrent fan-out — three subagents run simultaneously.
  console.log('--- Turn 1: Fan-out (3 subagents in parallel) ---\n');
  const start = Date.now();
  const result1 = await orchestrator.run({
    message:
      'I need to build a rate limiter. Use fanout to ask all three agents: ' +
      '"How would you design a rate limiter for a web API?"',
    metadata: { agentName: 'orchestrator' },
  });
  const elapsed = Date.now() - start;
  console.log('\nOrchestrator response:', result1.message);
  console.log('Tool calls:', result1.toolCalls?.map((tc) => tc.name) ?? []);
  console.log('Iterations:', result1.iterations);
  console.log(`Total time: ${elapsed}ms (3 subagents ran concurrently)\n`);

  // Demo 2: Halt propagation during concurrent execution.
  console.log('--- Turn 2: Halt during concurrent fan-out ---\n');
  const handle = orchestrator.run({
    message:
      'Use fanout to ask all three agents: "Write a detailed essay about distributed systems."',
    metadata: { agentName: 'orchestrator' },
  });

  // Halt after 2 seconds — all concurrent subagents should halt.
  setTimeout(() => {
    console.log('\n  [halting orchestrator — all concurrent subagents should halt]');
    handle.halt('user cancelled');
  }, 2000);

  const result2 = await handle;
  console.log('\nOrchestrator response:', result2.message || '(empty)');
  console.log('Finish reason:', result2.finishReason);
  console.log('Tool calls:', result2.toolCalls?.map((tc) => tc.name) ?? []);
}

main().catch(console.error);
