import { readFileSync } from 'node:fs';
import { Agent, type AgentResponse } from '@xandout/libra-harness';
import { resolveModel } from '@xandout/libra-harness/extras/models';
import { createStructuredOutputExtension } from '@xandout/libra-harness/extras/structured-output';
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

// ── JSON Schema for structured output ──────────────────────────────

interface PersonProfile {
  name: string;
  age: number;
  occupation: string;
  skills: string[];
  summary: string;
}

const profileSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number' },
    occupation: { type: 'string' },
    skills: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['name', 'age', 'occupation', 'skills', 'summary'],
};

// ── Agent setup ────────────────────────────────────────────────────
// The structured-output extension validates LLM output against a JSON
// schema via the beforeResponse hook. The logger extension observes
// turn lifecycle.
const agent = new Agent({
  model,
  systemPrompt:
    'You are a data extraction assistant. When asked to extract information, ' +
    'respond with ONLY valid JSON — no markdown, no explanation, no code fences. ' +
    'The JSON must match the requested schema exactly.',
  maxIterations: 3,
});

agent.use(createStructuredOutputExtension({
  schema: profileSchema,
  metadataKey: 'profile',
  stripCodeFences: true,
}));
agent.use(createLoggerExtension());

// ── Demo ───────────────────────────────────────────────────────────

async function main() {
  console.log('=== Structured Output Demo ===\n');
  console.log('The beforeResponse hook validates LLM output against a JSON schema.\n');

  // Demo 1: Successful extraction.
  console.log('--- Turn 1: Extract a person profile ---\n');
  const result1 = await agent.run({
    message:
      'Extract a profile from this text and respond as JSON with fields: ' +
      'name, age, occupation, skills (array), summary.\n\n' +
      'Sarah Chen is a 32-year-old senior software engineer at a fintech startup. ' +
      'She specializes in TypeScript, React, and distributed systems. ' +
      'Previously she worked at a big tech company for 5 years before joining the startup. ' +
      'She is known for her pragmatic approach to architecture and mentoring junior engineers.',
  });

  console.log('  Raw response:');
  console.log(result1.message);
  console.log();

  const profile1 = result1.metadata.profile as PersonProfile | undefined;
  if (profile1) {
    console.log('  ✅ Parsed profile:');
    console.log(`     Name: ${profile1.name}`);
    console.log(`     Age: ${profile1.age}`);
    console.log(`     Occupation: ${profile1.occupation}`);
    console.log(`     Skills: ${profile1.skills.join(', ')}`);
    console.log(`     Summary: ${profile1.summary}`);
  } else {
    console.log('  ❌ Validation failed — see raw response above');
  }

  // Demo 2: The LLM wraps output in code fences — extension strips them.
  console.log('\n--- Turn 2: LLM wraps JSON in code fences ---\n');
  console.log('  (The extension strips ```json fences before parsing)\n');

  const result2 = await agent.run({
    message:
      'Extract a profile from this text and respond as JSON with fields: ' +
      'name, age, occupation, skills (array), summary.\n\n' +
      'Marcus Webb, 45, is a data scientist at a healthcare company. ' +
      'He knows Python, R, SQL, and TensorFlow. ' +
      'He transitioned from academia where he published papers on statistical methods.',
  });

  const profile2 = result2.metadata.profile as PersonProfile | undefined;
  if (profile2) {
    console.log('  ✅ Parsed profile (code fences stripped):');
    console.log(`     Name: ${profile2.name}`);
    console.log(`     Age: ${profile2.age}`);
    console.log(`     Skills: ${profile2.skills.join(', ')}`);
  } else {
    console.log('  ❌ Validation failed:');
    console.log(`  ${result2.message.slice(0, 200)}`);
  }

  // Demo 3: Show the schema validation catching a bad response.
  console.log('\n--- Turn 3: LLM responds with prose instead of JSON ---\n');
  console.log('  (The extension should catch this and return an error)\n');

  const result3 = await agent.run({
    message:
      'Extract a profile from this text.\n\n' +
      'Jane Doe is a 28-year-old product manager.',
    systemPrompt:
      'You are a helpful assistant. Always respond in plain English prose, never JSON.',
  });

  const profile3 = result3.metadata.profile as PersonProfile | undefined;
  if (profile3) {
    console.log('  ✅ Parsed profile:');
    console.log(`     Name: ${profile3.name}`);
  } else {
    console.log('  ❌ Validation failed as expected:');
    try {
      const errorObj = JSON.parse(result3.message);
      console.log(`     Error: ${errorObj.error}`);
    } catch {
      console.log(`  ${result3.message.slice(0, 200)}`);
    }
  }

  // Demo 4: Retry pattern — if validation fails, retry with the error.
  console.log('\n--- Turn 4: Retry on validation failure ---\n');
  console.log('  (If first attempt fails, we retry with the error message)\n');

  let attempt = 0;
  let result: AgentResponse;
  let profile: PersonProfile | undefined;

  do {
    attempt++;
    const isFirstAttempt = attempt === 1;
    const message = isFirstAttempt
      ? 'Extract a profile from this text and respond as JSON with fields: ' +
        'name, age, occupation, skills (array), summary.\n\n' +
        'Tom Garcia, 38, is a DevOps engineer. He knows Docker, Kubernetes, AWS, and Terraform. ' +
        'He automates everything and loves CI/CD pipelines.'
      : `Your previous response failed validation:\n${result.message}\n\n` +
        'Please respond with ONLY valid JSON matching the schema. ' +
        'No markdown, no explanation.';

    result = await agent.run({ message });
    profile = result.metadata.profile as PersonProfile | undefined;
  } while (!profile && attempt < 3);

  if (profile) {
    console.log(`  ✅ Parsed profile on attempt ${attempt}:`);
    console.log(`     Name: ${profile.name}`);
    console.log(`     Occupation: ${profile.occupation}`);
    console.log(`     Skills: ${profile.skills.join(', ')}`);
  } else {
    console.log(`  ❌ Failed after ${attempt} attempts`);
  }
}

main().catch(console.error);
