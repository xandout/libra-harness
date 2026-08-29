import { readFileSync } from 'node:fs';
import { Agent } from 'libra';
import { resolveModel } from 'libra/extras/models';
import { createStreamingExtension } from 'libra/extras/streaming';

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

// ── Agent setup ────────────────────────────────────────────────────
// The streaming extension sets `onDelta` on the model request in
// `beforeLLM` when the caller passes `streamCallbacks` via metadata.
const streamingExt = createStreamingExtension();

const agent = new Agent({
  model,
  systemPrompt: 'You are a helpful assistant. Be concise.',
  maxIterations: 5,
});
agent.use(streamingExt);

// ── Demo 1: Stream text deltas to console ──────────────────────────

async function demoTextStreaming() {
  console.log('=== Demo 1: Text streaming ===\n');
  console.log('Watching text deltas arrive in real time...\n');

  let fullText = '';
  let deltaCount = 0;

  const result = await agent.run({
    message: 'Explain what a closure is in JavaScript in 3 sentences.',
    metadata: {
      streamCallbacks: {
        onText: (delta: string) => {
          process.stdout.write(delta);
          fullText += delta;
          deltaCount++;
        },
      },
    },
  });

  console.log('\n');
  console.log(`  (${deltaCount} text deltas received)`);
  console.log(`  Final response length: ${result.message.length} chars`);
  console.log(`  Match: ${fullText === result.message}`);
  console.log();
}

// ── Demo 2: Stream reasoning deltas (thinking) ─────────────────────

async function demoReasoningStreaming() {
  console.log('=== Demo 2: Reasoning/thinking deltas ===\n');
  console.log('DeepSeek v4 models have thinking mode enabled by default.');
  console.log('Reasoning tokens stream as reasoning_content → reasoning-delta.\n');
  console.log('Watching both reasoning (dim) and response (bold) channels...\n');

  let reasoningText = '';
  let responseText = '';

  const result = await agent.run({
    message: 'What is 17 * 23? Think step by step.',
    metadata: {
      streamCallbacks: {
        onReasoning: (delta: string) => {
          reasoningText += delta;
          process.stdout.write(`\x1b[2m${delta}\x1b[0m`); // dim
        },
        onText: (delta: string) => {
          responseText += delta;
          process.stdout.write(`\x1b[1m${delta}\x1b[0m`); // bold
        },
      },
    },
  });

  console.log('\n');
  console.log(`  Reasoning length: ${reasoningText.length} chars`);
  console.log(`  Response length: ${responseText.length} chars`);
  if (reasoningText.length === 0) {
    console.log('  (No reasoning deltas received. Thinking mode may be disabled');
    console.log('   or this model version does not emit separate reasoning.)');
  }
  console.log(`  Final response: ${result.message.slice(0, 100)}`);
  console.log();
}

// ── Demo 3: Stream tool input deltas ───────────────────────────────

async function demoToolInputStreaming() {
  console.log('=== Demo 3: Tool input streaming ===\n');
  console.log('Watching the LLM construct tool arguments token by token...\n');

  const agentWithTool = new Agent({
    model,
    systemPrompt:
      'You are a helpful assistant. When asked about weather, always use the get_weather tool.',
    tools: [
      {
        name: 'get_weather',
        description: 'Get the weather for a city',
        parameters: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'The city name' },
            units: { type: 'string', enum: ['celsius', 'fahrenheit'] },
          },
          required: ['city'],
        },
        async execute(args) {
          return {
            toolCallId: '',
            content: `Weather in ${args.city}: 72°F, sunny`,
          };
        },
      },
    ],
    maxIterations: 5,
  });
  agentWithTool.use(streamingExt);

  let toolInputDeltas = '';
  let toolName = '';

  const result = await agentWithTool.run({
    message: "What's the weather in San Francisco in celsius?",
    metadata: {
      streamCallbacks: {
        onText: (delta: string) => process.stdout.write(delta),
        onToolInput: (delta: string, name: string) => {
          toolInputDeltas += delta;
          if (name) toolName = name;
          process.stdout.write(`\x1b[36m${delta}\x1b[0m`); // cyan
        },
      },
    },
  });

  console.log('\n');
  console.log(`  Tool: ${toolName}`);
  console.log(`  Tool input deltas: ${toolInputDeltas}`);
  console.log(`  Final response: ${result.message.slice(0, 100)}`);
  console.log();
}

// ── Demo 4: No streaming (onDelta not set) ─────────────────────────

async function demoNoStreaming() {
  console.log('=== Demo 4: No streaming (callbacks not provided) ===\n');
  console.log('When no streamCallbacks are in metadata, onDelta is not set.');
  console.log('The model uses doGenerate — no streaming overhead.\n');

  const result = await agent.run({
    message: 'Say hello in one word.',
  });

  console.log(`  Response: ${result.message}`);
  console.log();
}

// ── Run all demos ──────────────────────────────────────────────────

async function main() {
  console.log('=== Streaming & Thinking Deltas Demo ===\n');
  console.log('Extensions set onDelta on modelRequest via beforeLLM hook.');
  console.log('The core passes it through — it never interprets deltas.\n');

  await demoTextStreaming();
  await demoReasoningStreaming();
  await demoToolInputStreaming();
  await demoNoStreaming();

  console.log('=== All demos complete ===');
}

main().catch(console.error);
