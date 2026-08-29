import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '@xandout/libra-harness';
import { createOpenAICompatibleServer } from '@xandout/libra-harness/extras/openai-provider';
import { createPiiSwapExtension, createPiiDetector, restorePlaceholders, type PiiLogEntry } from './pii-swap.ts';
import { createCsvLookupTool, getKnownNames } from './csv-tool.ts';
import { LoggingMockModel } from './logging-model.ts';

const servers: ReturnType<typeof createOpenAICompatibleServer>[] = [];

async function startPiiProvider() {
  const knownNames = getKnownNames();
  const detect = createPiiDetector(knownNames);
  const logEntries: PiiLogEntry[] = [];

  const model = new LoggingMockModel((label, text) => {
    // Model-side logging is handled by the extension's log callback.
  });

  const agent = new Agent({
    model,
    systemPrompt: 'You are a customer support assistant. Use the lookup_customer tool to find customer information.',
    tools: [createCsvLookupTool()],
  });

  agent.use(createPiiSwapExtension({
    detect,
    restore: restorePlaceholders,
    log: (entry) => logEntries.push(entry),
  }));

  const server = createOpenAICompatibleServer({
    agents: { 'pii-safe-agent': agent },
    apiKeys: ['test-key'],
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return { baseUrl: `http://127.0.0.1:${address.port}`, model, logEntries };
}

function request(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve, reject) => {
    s.close((err) => err ? reject(err) : resolve());
  })));
});

describe('PII DLP provider', () => {
  it('consumer sends real PII, LLM sees only placeholders', async () => {
    const { baseUrl, model, logEntries } = await startPiiProvider();

    const response = await request(baseUrl, {
      model: 'pii-safe-agent',
      messages: [{ role: 'user', content: 'What is the status of John Smith\'s account?' }],
    });

    expect(response.status).toBe(200);
    const json: any = await response.json();

    // ── The consumer response should contain real PII, not placeholders ──
    const consumerText = json.choices[0].message.content as string;
    expect(consumerText).toContain('John Smith');
    expect(consumerText).not.toContain('[PERSON_');

    // ── The model should never have seen real PII ──
    // Check all messages the model received across all calls.
    for (const req of model.receivedRequests) {
      for (const message of req.messages) {
        if (typeof message.content === 'string') {
          expect(message.content).not.toContain('John Smith');
          expect(message.content).not.toContain('john.smith@acme.com');
          expect(message.content).not.toContain('+1-555-0100');
          expect(message.content).not.toContain('ACC-12345678');
          expect(message.content).not.toContain('123-45-6789');
        }
      }
    }

    // ── The model should have seen placeholders ──
    const firstRequestMessages = model.receivedRequests[0].messages;
    const userMessage = firstRequestMessages.find((m) => m.role === 'user');
    expect(userMessage?.content).toContain('[PERSON_');
  });

  it('tool results are redacted before the LLM sees them', async () => {
    const { baseUrl, model, logEntries } = await startPiiProvider();

    await request(baseUrl, {
      model: 'pii-safe-agent',
      messages: [{ role: 'user', content: 'Look up Sarah Johnson' }],
    });

    // The model makes two calls: first to get the tool call, second to process the result.
    expect(model.receivedRequests).toHaveLength(2);

    // The second call should include the tool result message.
    const secondCallMessages = model.receivedRequests[1].messages;
    const toolMessage = secondCallMessages.find((m) => m.role === 'tool');

    expect(toolMessage).toBeDefined();
    const toolContent = toolMessage!.content as string;

    // The tool result should contain placeholders, not real PII.
    expect(toolContent).toContain('[PERSON_');
    expect(toolContent).toContain('[EMAIL_');
    expect(toolContent).toContain('[PHONE_');
    expect(toolContent).toContain('[ACCOUNT_');
    expect(toolContent).toContain('[SSN_');

    // The tool result should NOT contain real PII.
    expect(toolContent).not.toContain('Sarah Johnson');
    expect(toolContent).not.toContain('sarah.j@globex.io');
    expect(toolContent).not.toContain('+1-555-0200');
    expect(toolContent).not.toContain('ACC-87654321');
    expect(toolContent).not.toContain('987-65-4321');
  });

  it('consumer response has real values restored, no placeholders', async () => {
    const { baseUrl } = await startPiiProvider();

    const response = await request(baseUrl, {
      model: 'pii-safe-agent',
      messages: [{ role: 'user', content: 'Look up Robert Chen' }],
    });

    const json: any = await response.json();
    const content = json.choices[0].message.content as string;

    // Real values should be present.
    expect(content).toContain('Robert Chen');
    expect(content).toContain('bob.chen@initech.com');
    expect(content).toContain('ACC-11223344');

    // No placeholders should leak to the consumer.
    expect(content).not.toContain('[PERSON_');
    expect(content).not.toContain('[EMAIL_');
    expect(content).not.toContain('[ACCOUNT_');
    expect(content).not.toContain('[PHONE_');
    expect(content).not.toContain('[SSN_');
  });

  it('log entries show the full redaction lifecycle', async () => {
    const { baseUrl, logEntries } = await startPiiProvider();

    await request(baseUrl, {
      model: 'pii-safe-agent',
      messages: [{ role: 'user', content: 'Look up Emily Davis' }],
    });

    // We should have model-input, tool-result-raw, tool-result-redacted,
    // model-output, and consumer-response log entries.
    const stages = logEntries.map((e) => e.stage);
    expect(stages).toContain('model-input');
    expect(stages).toContain('tool-result-raw');
    expect(stages).toContain('tool-result-redacted');
    expect(stages).toContain('model-output');
    expect(stages).toContain('consumer-response');

    // The raw tool result should contain real PII.
    const rawToolResult = logEntries.find((e) => e.stage === 'tool-result-raw');
    expect(rawToolResult?.text).toContain('Emily Davis');
    expect(rawToolResult?.text).toContain('emily.d@umbrella.org');
    expect(rawToolResult?.text).toContain('321-54-9876');

    // The redacted tool result should contain only placeholders.
    const redactedToolResult = logEntries.find((e) => e.stage === 'tool-result-redacted');
    expect(redactedToolResult?.text).not.toContain('Emily Davis');
    expect(redactedToolResult?.text).not.toContain('emily.d@umbrella.org');
    expect(redactedToolResult?.text).toContain('[PERSON_');
    expect(redactedToolResult?.text).toContain('[EMAIL_');
    expect(redactedToolResult?.text).toContain('[SSN_');

    // The model output should contain placeholders.
    const modelOutput = logEntries.find((e) => e.stage === 'model-output');
    expect(modelOutput?.text).toContain('[PERSON_');
    expect(modelOutput?.text).not.toContain('Emily Davis');

    // The consumer response should have real values restored.
    const consumerResponse = logEntries.find((e) => e.stage === 'consumer-response');
    expect(consumerResponse?.text).toContain('Emily Davis');
    expect(consumerResponse?.text).not.toContain('[PERSON_');
  });

  it('placeholders are consistent across multiple turns', async () => {
    const { baseUrl, model } = await startPiiProvider();

    // Send a multi-message request where the same person is referenced
    // in multiple messages. The PII swap should use the same placeholder
    // for "John Smith" in all messages.
    await request(baseUrl, {
      model: 'pii-safe-agent',
      messages: [
        { role: 'user', content: 'Look up John Smith' },
        { role: 'assistant', content: 'I found John Smith with balance $5250.' },
        { role: 'user', content: 'What is John Smith\'s email?' },
      ],
    });

    // The model should see the same placeholder for John Smith in all messages.
    const allContent = model.receivedRequests
      .flatMap((r) => r.messages)
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join(' ');

    // Should contain the placeholder, not the real name.
    expect(allContent).not.toContain('John Smith');
    expect(allContent).toContain('[PERSON_');

    // All occurrences of [PERSON_xxx] should be the same placeholder.
    const personMatches = allContent.match(/\[PERSON_\d+\]/g);
    expect(personMatches).not.toBeNull();
    const uniquePersons = new Set(personMatches);
    expect(uniquePersons.size).toBe(1); // same placeholder throughout
  });
});
