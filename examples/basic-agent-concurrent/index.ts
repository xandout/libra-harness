import 'node:process';
import { readFileSync } from 'node:fs';
import { Agent, type Extension } from 'libra-harness';
import { resolveModel } from 'libra-harness/extras/models';
import { createLoggerExtension } from 'libra-harness/extras/logger';
import { createMemSessionExtension } from 'libra-harness/extras/mem-session';
import { createWeatherToolExtension } from 'libra-harness/extras/weather-tool';
import { createEmojiExtension } from 'libra-harness/extras/emoji';
import { timestampExtension } from 'libra-harness/extras/timestamp';

// Load .env if present (no dependency needed).
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
} catch {
  // No .env file — rely on environment variables.
}

const model = await resolveModel(process.env.MODEL ?? 'deepseek/deepseek-v4-flash');

// ── Shared extensions (imported directly from libra/extras) ──
const logger = createLoggerExtension();
const session = createMemSessionExtension();
const weatherTool = createWeatherToolExtension();
const emoji = createEmojiExtension();
const timestamp = timestampExtension;

const sharedExtensions: Extension[] = [logger, session, weatherTool, emoji, timestamp];

// ── Agent setup ────────────────────────────────────────────────────
// A single Agent instance handles all users. Each turn is independent
// — the agent core supports concurrent turns out of the box. Session
// isolation is handled by the session extension, which keys on
// metadata.sessionId.
const agent = new Agent({
  model,
  systemPrompt: 'You are a helpful assistant. Keep responses concise (under 100 words).',
  errorPolicy: 'fallback',
});

for (const ext of sharedExtensions) {
  agent.use(ext);
}

// ── Simulated users ────────────────────────────────────────────────

interface SimUser {
  user: string;
  session: string;
  messages: string[];
}

const users: SimUser[] = [
  {
    user: 'alice',
    session: 'alice-conv',
    messages: [
      "What's the weather in San Francisco?",
      'Now what about New York?',
      'Which city is warmer?',
    ],
  },
  {
    user: 'bob',
    session: 'bob-conv',
    messages: [
      'Tell me a joke about programming.',
      'Tell me another one.',
    ],
  },
  {
    user: 'carol',
    session: 'carol-conv',
    messages: [
      'What is 2+2?',
      'Now multiply that by 10.',
      'What did I ask you about first?',
    ],
  },
  {
    user: 'dave',
    session: 'dave-conv',
    messages: [
      'Write a haiku about the ocean.',
    ],
  },
];

// ── Demo 1: Concurrent turns from multiple users ───────────────────

async function demoConcurrentTurns() {
  console.log('=== Demo 1: Concurrent turns from multiple users ===\n');
  console.log('All 4 users send their first message simultaneously.\n');

  const start = Date.now();

  const handles = users.map((u) =>
    agent.run({
      message: u.messages[0],
      metadata: { user: u.user, sessionId: u.session },
    }),
  );

  const results = await Promise.all(handles);
  const elapsed = Date.now() - start;

  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    console.log(`\n  [${u.user}] Q: ${u.messages[0]}`);
    console.log(`  [${u.user}] A: ${results[i].message.slice(0, 120)}`);
  }

  console.log(`\n  Total time: ${elapsed}ms (4 users, concurrent)`);
}

// ── Demo 2: Rapid-fire messages from a single user ─────────────────

async function demoRapidFire() {
  console.log('\n=== Demo 2: Rapid-fire messages from one user (intentional race) ===\n');
  console.log('Alice sends 3 messages back-to-back to the same session.');
  console.log('⚠️  The naive session extension will lose messages — last writer wins.\n');

  const start = Date.now();

  const handles = [
    agent.run({
      message: 'What is the capital of France?',
      metadata: { user: 'alice', sessionId: 'alice-rapid' },
    }),
    agent.run({
      message: 'What is the capital of Germany?',
      metadata: { user: 'alice', sessionId: 'alice-rapid' },
    }),
    agent.run({
      message: 'What is the capital of Japan?',
      metadata: { user: 'alice', sessionId: 'alice-rapid' },
    }),
  ];

  const results = await Promise.all(handles);
  const elapsed = Date.now() - start;

  const questions = [
    'What is the capital of France?',
    'What is the capital of Germany?',
    'What is the capital of Japan?',
  ];

  for (let i = 0; i < results.length; i++) {
    console.log(`  [alice] Q: ${questions[i]}`);
    console.log(`  [alice] A: ${results[i].message.slice(0, 80)}\n`);
  }

  const history = session.getMessages('alice-rapid');
  console.log(`  Total time: ${elapsed}ms (3 messages, concurrent)`);
  console.log(`  ⚠️  Session history after all 3 turns:`);
  console.log(`  ⚠️  ${history.length} messages saved (expected 6: 3 user + 3 assistant)`);
  console.log('  ⚠️  The last turn to finish overwrote the others. This is a');
  console.log('  ⚠️  session extension race condition, NOT a core agent bug.');
  console.log('  ⚠️  Fix: serialize turns per session or use append-only storage.\n');
}

// ── Demo 3: Multi-user concurrent with follow-ups ──────────────────

async function demoMultiUserFollowUps() {
  console.log('=== Demo 3: Multi-user concurrent with follow-ups ===\n');
  console.log('4 users send first messages concurrently, then follow up.\n');

  const start = Date.now();

  const round1 = await Promise.all(
    users.map((u) =>
      agent.run({
        message: u.messages[0],
        metadata: { user: u.user, sessionId: u.session },
      }),
    ),
  );

  console.log('  Round 1 complete (all 4 users):\n');
  for (let i = 0; i < users.length; i++) {
    console.log(`  [${users[i].user}] ${round1[i].message.slice(0, 80)}`);
  }

  const followUpUsers = users.filter((u) => u.messages.length > 1);
  console.log(`\n  Round 2: ${followUpUsers.length} users send follow-ups concurrently\n`);

  const round2 = await Promise.all(
    followUpUsers.map((u) =>
      agent.run({
        message: u.messages[1],
        metadata: { user: u.user, sessionId: u.session },
      }),
    ),
  );

  for (let i = 0; i < followUpUsers.length; i++) {
    console.log(`  [${followUpUsers[i].user}] ${round2[i].message.slice(0, 80)}`);
  }

  const elapsed = Date.now() - start;
  console.log(`\n  Total time: ${elapsed}ms (8 turns across 4 users, 2 rounds)`);
}

// ── Demo 4: Halt one user's turn while others continue ─────────────

async function demoHaltIsolation() {
  console.log('\n=== Demo 4: Halt isolation (one user cancelled, others continue) ===\n');

  const start = Date.now();

  const eveHandle = agent.run({
    message: 'Write a very detailed essay about the history of computing.',
    metadata: { user: 'eve', sessionId: 'eve-conv' },
  });

  const frankPromise = agent.run({
    message: 'What is 1+1?',
    metadata: { user: 'frank', sessionId: 'frank-conv' },
  });

  setTimeout(() => {
    console.log('  [halting eve\'s turn — frank continues]');
    eveHandle.halt('user cancelled');
  }, 2000);

  const [eveResult, frankResult] = await Promise.all([eveHandle, frankPromise]);
  const elapsed = Date.now() - start;

  console.log(`\n  [eve] finishReason: ${eveResult.finishReason}`);
  console.log(`  [eve] response: ${eveResult.message?.slice(0, 60) || '(empty)'}`);
  console.log(`  [frank] finishReason: ${frankResult.finishReason}`);
  console.log(`  [frank] response: ${frankResult.message.slice(0, 60)}`);
  console.log(`\n  Total time: ${elapsed}ms`);
}

// ── Run all demos ──────────────────────────────────────────────────

async function main() {
  console.log('=== Concurrent Multi-User Agent Demo ===\n');
  console.log('A single Agent instance handles multiple users concurrently.');
  console.log('Each turn is independent with its own RunHandle.');
  console.log('Session isolation is via metadata.sessionId.\n');

  await demoConcurrentTurns();
  await demoRapidFire();
  await demoMultiUserFollowUps();
  await demoHaltIsolation();

  console.log('\n=== All demos complete ===');
}

main().catch(console.error);
