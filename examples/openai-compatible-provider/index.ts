import { readFileSync } from 'node:fs';
import { Agent } from '@xandout/libra-harness';
import { createRoutingModel, hasImageInput, resolveModel } from '@xandout/libra-harness/extras/models';
import { createOpenAICompatibleServer } from '@xandout/libra-harness/extras/openai-provider';

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

const apiKeys = (process.env.LIBRA_PROVIDER_API_KEYS ?? '').split(',').map((key) => key.trim()).filter(Boolean);
if (apiKeys.length === 0) {
  console.error('Set LIBRA_PROVIDER_API_KEYS to one or more comma-separated API keys.');
  process.exit(1);
}
const defaultModel = await resolveModel(process.env.MODEL ?? 'deepseek/deepseek-v4-flash');
const visionModel = process.env.VISION_MODEL ? await resolveModel(process.env.VISION_MODEL) : undefined;
const model = visionModel
  ? createRoutingModel({ default: defaultModel, routes: [{ when: hasImageInput, model: visionModel }] })
  : defaultModel;

const agents = {
  'libra-provider/agent-1': new Agent({
    model,
    systemPrompt: 'You are Agent 1, a concise research assistant.',
  }),
  'libra-provider/agent-2': new Agent({
    model,
    systemPrompt: 'You are Agent 2, a practical writing assistant.',
  }),
};

const host = process.env.HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.PORT ?? '8787', 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be an integer between 1 and 65535.');
  process.exit(1);
}

const server = createOpenAICompatibleServer({ agents, apiKeys });
server.listen(port, host, () => {
  console.log(`Libra OpenAI-compatible provider listening at http://${host}:${port}/v1`);
  console.log(`Models: ${Object.keys(agents).join(', ')}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
