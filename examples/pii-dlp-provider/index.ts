import { readFileSync } from 'node:fs';
import { Agent } from '@xandout/libra-harness';
import { createOpenAICompatibleServer } from '@xandout/libra-harness/extras/openai-provider';
import { createPiiSwapExtension, createPiiDetector, restorePlaceholders, type PiiLogEntry } from './pii-swap.ts';
import { createCsvLookupTool, getKnownNames } from './csv-tool.ts';

// Load .env
try {
  const env = readFileSync(new URL('./.env', import.meta.url), 'utf-8');
  for (const line of env.split('\n')) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[match[1]] = value;
    }
  }
} catch {}

// ─── PII Swap Setup ─────────────────────────────────────────────

const knownNames = getKnownNames();
const detect = createPiiDetector(knownNames);

// Log every stage to console and to an in-memory log.
const logEntries: PiiLogEntry[] = [];
function log(entry: PiiLogEntry): void {
  logEntries.push(entry);
  const label = entry.stage.toUpperCase().padEnd(22);
  console.log(`  [${label}] ${entry.text}`);
}

// ─── Agent Setup ────────────────────────────────────────────────

const apiKeys = (process.env.LIBRA_PROVIDER_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
if (apiKeys.length === 0) {
  console.error('Set LIBRA_PROVIDER_API_KEYS to one or more comma-separated API keys.');
  process.exit(1);
}

// Use the logging mock model so the example works without upstream API keys.
// In production, replace this with a real model (resolveModel, AISdkModel, etc.).
import { LoggingMockModel } from './logging-model.ts';
const model = new LoggingMockModel((label, text) => console.log(`  [${label}] ${text}`));

const agent = new Agent({
  model,
  systemPrompt: 'You are a customer support assistant. Use the lookup_customer tool to find customer information.',
  tools: [createCsvLookupTool()],
});

// Install the PII swap extension.
agent.use(createPiiSwapExtension({
  detect,
  restore: restorePlaceholders,
  log,
}));

// ─── Server ─────────────────────────────────────────────────────

const host = process.env.HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.PORT ?? '8788', 10);

const server = createOpenAICompatibleServer({
  agents: { 'pii-safe-agent': agent },
  apiKeys,
});

server.listen(port, host, () => {
  console.log(`\nPII-safe agent listening at http://${host}:${port}/v1`);
  console.log(`Model: pii-safe-agent`);
  console.log(`\nTry:`);
  console.log(`  curl http://${host}:${port}/v1/chat/completions \\`);
  console.log(`    -H "Authorization: Bearer ${apiKeys[0]}" \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{"model":"pii-safe-agent","messages":[{"role":"user","content":"What is the status of John Smith'"'"'s account?"}]}'`);
  console.log();
});

const shutdown = () => server.close(() => process.exit(0));
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
