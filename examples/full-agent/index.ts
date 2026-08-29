import 'node:process';
import { readFileSync } from 'node:fs';
import { Agent, messageContentToText } from '@xandout/libra-harness';
import { resolveModel } from '@xandout/libra-harness/extras/models';
import { loadExtensions, installExtensions, closeExtensions } from '@xandout/libra-harness/extras';
import { createLoggerExtension } from '@xandout/libra-harness/extras/logger';
import { createMemSessionExtension } from '@xandout/libra-harness/extras/mem-session';
import { createWeatherToolExtension } from '@xandout/libra-harness/extras/weather-tool';
import { createEmojiExtension } from '@xandout/libra-harness/extras/emoji';
import { timestampExtension } from '@xandout/libra-harness/extras/timestamp';
import { createStreamingExtension } from '@xandout/libra-harness/extras/streaming';
import { createStructuredOutputExtension } from '@xandout/libra-harness/extras/structured-output';
import { createSkillExtension } from '@xandout/libra-harness/extras/skills';
import { createMcpExtension } from '@xandout/libra-harness/extras/mcp';

// Load .env if present (no dependency needed).
try {
  const env = readFileSync(new URL('./.env', import.meta.url), 'utf-8');
  for (const line of env.split('\n')) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      let val = match[2];
      // Strip surrounding quotes.
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[match[1]] = val;
    }
  }
} catch {
  // No .env file — rely on environment variables.
}

// Use native Vercel AI SDK providers resolved from provider/model IDs.
const primaryModel = await resolveModel(process.env.MODEL ?? 'deepseek/deepseek-v4-flash');
const secondaryModel = await resolveModel(process.env.SECONDARY_MODEL ?? 'google/gemini-3.6-flash');

// ── Extension loader ──
// A single call loads built-in extensions (passed as factories) and
// local extensions (discovered from ./extensions/). The loader calls
// each factory with the config object — factories extract the keys
// they need and may return undefined to opt out. Directory-loaded
// extensions are discovered via their extension.json manifest.
//
// Everything is merged and sorted by priority (high → low, then
// alphabetical). The priority comes from the Extension object itself
// (set by each factory) or from extension.json (for directory-loaded).
//
// Load order:
//   logging (100) → streaming (100) → mcp (50) → search-replace (50)
//   → skills (50) → weather-tool (50) → emoji (0) → timestamp (0)
//   → session (-100)
const loadedExtensions = await loadExtensions(
  [
    // Built-in extensions (factories — config is passed to each)
    createLoggerExtension,
    createStreamingExtension,
    createStructuredOutputExtension,
    createMcpExtension,
    createSkillExtension,
    createWeatherToolExtension,
    createEmojiExtension,
    timestampExtension,
    createMemSessionExtension,
    // Local extensions (discovered from directory)
    new URL('./extensions', import.meta.url).pathname,
  ],
  {
    skillsDirs: new URL('./skills', import.meta.url).pathname,
    mcpConfigPaths: new URL('./mcpServers.json', import.meta.url).pathname,
    allowRegex: false,
  },
);

// ── Agent setup ──
const primaryAgent = new Agent({
  model: primaryModel,
  systemPrompt: 'You are a helpful assistant. Use tools when appropriate.',
});

installExtensions(loadedExtensions, primaryAgent);

console.log('[agent] registered tools:', primaryAgent.getTools());

const secondaryAgent = new Agent({
  model: secondaryModel,
  systemPrompt: 'You are a helpful assistant. Use tools when appropriate.',
});

installExtensions(loadedExtensions, secondaryAgent);

// ── Multi-turn conversation with session memory ──

console.log('=== Turn 1 ===');
const r1 = await primaryAgent.run({
  message: "What's the weather in San Francisco?",
  metadata: { sessionId: 'conversation-1' },
});
console.log('Response:', r1.message);

console.log('\n=== Turn 2 (agent should remember turn 1) ===');
const r2 = await primaryAgent.run({
  message: 'Now what about New York?',
  metadata: { sessionId: 'conversation-1' },
});
console.log('Response:', r2.message);

console.log('\n=== Turn 3 (follow-up referencing prior context) ===');
const r3 = await primaryAgent.run({
  message: 'Which of those two cities is warmer?',
  metadata: { sessionId: 'conversation-1' },
});
console.log('Response:', r3.message);

console.log('\n--- Session history ---');
const sessionExt = loadedExtensions.find((e) => e.name === 'session');
if (sessionExt) {
  const session = sessionExt.extension as { getMessages(id?: string): { role: string; content: Parameters<typeof messageContentToText>[0] }[] };
  for (const msg of session.getMessages('conversation-1')) {
    console.log(`  [${msg.role}] ${messageContentToText(msg.content).slice(0, 80)}`);
  }
}

// ── MCP tool usage (separate session so it doesn't clutter the weather convo) ──

console.log('\n=== MCP tool turn (asking the LLM to use MCP tools) ===');
const mcpResult = await primaryAgent.run({
  message: 'List the files in /tmp directory using your filesystem tools.',
  metadata: { sessionId: 'mcp-session' },
});
console.log('Response:', mcpResult.message);
console.log('toolCalls:', mcpResult.toolCalls?.map((tc) => tc.name) ?? []);

// ── Skill loader demo ──

console.log('\n=== Skill turn (asking the LLM to load and use a skill) ===');
const skillResult = await primaryAgent.run({
  message: 'Review this code: function add(a, b) { return a + b; }. First check what skills are available, then use the appropriate one.',
  metadata: { sessionId: 'skill-session' },
});
console.log('Response:', skillResult.message);
console.log('toolCalls:', skillResult.toolCalls?.map((tc) => tc.name) ?? []);

// ── Local extension demo (search-replace tool via the loader) ──

console.log('\n=== Search-replace turn (local extension via loader) ===');
const srResult = await primaryAgent.run({
  message:
    'Use the search_replace tool to replace all occurrences of "foo" with "bar" ' +
    'in this text: "foo bar foo baz foo qux".',
  metadata: { sessionId: 'sr-session' },
});
console.log('Response:', srResult.message);
console.log('toolCalls:', srResult.toolCalls?.map((tc) => tc.name) ?? []);

// ── Single-turn with Gemini (no session) ──

console.log('\n=== Gemini (no session, single turn) ===');
const geminiResult = await secondaryAgent.run({
  message: "What's the weather in San Francisco?",
});

console.log('Response:', geminiResult.message);
console.log('finishReason:', geminiResult.finishReason);
console.log('iterations:', geminiResult.iterations);
console.log('toolCalls:', geminiResult.toolCalls?.map((tc) => tc.name) ?? []);

// ── Cleanup — close any extensions that have a close() method (e.g. MCP) ──
await closeExtensions(loadedExtensions);
