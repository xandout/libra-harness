import { readFileSync } from 'node:fs';
import { Agent, createAgentTool } from 'libra';
import { resolveModel } from 'libra/extras/models';
import { createLoggerExtension } from 'libra/extras/logger';

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

// ── Subagent 1: Research Agent ─────────────────────────────────────
// Specialized for gathering information. Has its own tools.

const researchAgent = new Agent({
  model,
  systemPrompt:
    'You are a research agent. Given a question, provide a concise, factual answer. ' +
    'Keep responses under 200 words. If you are unsure, say so.',
  maxIterations: 5,
});
researchAgent.use(loggingExtension);

// ── Subagent 2: Code Agent ─────────────────────────────────────────
// Specialized for writing code. Different system prompt, different tools.

const codeAgent = new Agent({
  model,
  systemPrompt:
    'You are a code agent. Given a coding task, write clean, well-structured code. ' +
    'Always include brief comments explaining your approach.',
  maxIterations: 5,
});
codeAgent.use(loggingExtension);

// ── Subagent 3: Critic Agent ───────────────────────────────────────
// Reviews the output of other agents.

const criticAgent = new Agent({
  model,
  systemPrompt:
    'You are a critic agent. Review the given content and provide specific, actionable feedback. ' +
    'Identify strengths, weaknesses, and suggest improvements. Be constructive.',
  maxIterations: 3,
});
criticAgent.use(loggingExtension);

// ── Orchestrator Agent ─────────────────────────────────────────────
// The outer agent that delegates to subagents via createAgentTool.
// Signal and metadata are automatically chained — if the orchestrator
// is halted, all subagents are halted too.

const orchestrator = new Agent({
  model,
  systemPrompt:
    'You are an orchestrator agent. You have access to specialized subagents:\n' +
    '- research: Answer factual questions and gather information\n' +
    '- code: Write code for programming tasks\n' +
    '- critique: Review and provide feedback on content\n\n' +
    'Break down the user request, delegate to the appropriate subagent(s), ' +
    'and synthesize their responses into a final answer. ' +
    'You can call multiple subagents in sequence.',
  tools: [
    createAgentTool(researchAgent, {
      name: 'research',
      description: 'Delegate a research question to a specialized research agent. Use for factual queries.',
    }),
    createAgentTool(codeAgent, {
      name: 'code',
      description: 'Delegate a coding task to a specialized code agent. Use for programming requests.',
    }),
    createAgentTool(criticAgent, {
      name: 'critique',
      description: 'Delegate content review to a critic agent. Use to get feedback on text or code.',
    }),
  ],
  maxIterations: 10,
});
orchestrator.use(loggingExtension);

// ── Demo ───────────────────────────────────────────────────────────

async function main() {
  console.log('=== Subagent Demo: Orchestrator delegating to specialized agents ===\n');

  // Demo 1: Simple delegation — orchestrator calls research subagent.
  console.log('--- Turn 1: Research delegation ---\n');
  const result1 = await orchestrator.run({
    message: 'What are the key differences between TypeScript and JavaScript?',
    metadata: { agentName: 'orchestrator' },
  });
  console.log('\nOrchestrator response:', result1.message);
  console.log('Tool calls:', result1.toolCalls?.map((tc) => tc.name) ?? []);
  console.log('Iterations:', result1.iterations);

  // Demo 2: Multi-step delegation — orchestrator calls code, then critique.
  console.log('\n--- Turn 2: Code + Critique pipeline ---\n');
  const result2 = await orchestrator.run({
    message: 'Write a Python function to reverse a linked list, then critique the code quality.',
    metadata: { agentName: 'orchestrator' },
  });
  console.log('\nOrchestrator response:', result2.message);
  console.log('Tool calls:', result2.toolCalls?.map((tc) => tc.name) ?? []);
  console.log('Iterations:', result2.iterations);

  // Demo 3: Signal chaining — halt the orchestrator mid-turn.
  console.log('\n--- Turn 3: Halt propagation (signal chaining) ---\n');
  const handle = orchestrator.run({
    message: 'Research the history of computing, write a summary, and critique it.',
    metadata: { agentName: 'orchestrator' },
  });

  // Halt after 3 seconds to demonstrate signal chaining.
  setTimeout(() => {
    console.log('\n[halting orchestrator — subagents should also halt]');
    handle.halt('user cancelled');
  }, 3000);

  const result3 = await handle;
  console.log('\nOrchestrator response:', result3.message || '(empty)');
  console.log('Finish reason:', result3.finishReason);
  console.log('Tool calls:', result3.toolCalls?.map((tc) => tc.name) ?? []);
}

main().catch(console.error);
