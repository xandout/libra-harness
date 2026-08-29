# PII DLP Provider — Proof of Concept

This example proves that a Libra virtual model can act as a DLP/PII layer between a consumer and an upstream LLM. The virtual model intercepts both sides of every turn, swaps real PII for stable placeholders before the LLM sees it, and restores the real values before the response reaches the consumer.

**The LLM never sees PII. The consumer never sees placeholders.**

## How it works

```
Consumer: "What is the status of John Smith's account?"
    │
    ▼  beforeLLM hook redacts PII
    │
LLM sees: "What is the status of [PERSON_001]'s account?"
    │
    ▼  LLM calls lookup_customer tool with [PERSON_001]
    │
beforeTool hook restores: tool called with "John Smith"
    │
    ▼  Tool queries CSV, returns raw PII
    │
Tool result (raw): "Name: John Smith, Email: john.smith@acme.com, SSN: 123-45-6789..."
    │
    ▼  afterTool hook redacts PII
    │
Tool result (redacted): "Name: [PERSON_001], Email: [EMAIL_001], SSN: [SSN_001]..."
    │
    ▼  LLM sees redacted tool result, responds with placeholders
    │
LLM output: "I found [PERSON_001] (email: [EMAIL_001]) with balance $5250.00."
    │
    ▼  beforeResponse hook restores placeholders
    │
Consumer receives: "I found John Smith (email: john.smith@acme.com) with balance $5250.00."
```

## Running the example

```bash
cp .env.example .env
# Edit .env and set LIBRA_PROVIDER_API_KEYS to a random key
pnpm install
pnpm start
```

Then make a request:

```bash
curl http://127.0.0.1:8788/v1/chat/completions \
  -H "Authorization: Bearer your-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"pii-safe-agent","messages":[{"role":"user","content":"What is the status of John Smith'"'"'s account?"}]}'
```

The server logs every stage so you can see exactly what each side sees:

```
[MODEL-INPUT           ] {"role":"user","content":"What is the status of [PERSON_001]'s account?"}
[TOOL-RESULT-RAW       ] Customer found: Name: John Smith, Email: john.smith@acme.com, Phone: +1-555-0100, Account: ACC-12345678, Balance: $5250.00, SSN: 123-45-6789
[TOOL-RESULT-REDACTED  ] Customer found: Name: [PERSON_001], Email: [EMAIL_001], Phone: [PHONE_001], Account: [ACCOUNT_001], Balance: $5250.00, SSN: [SSN_001]
[MODEL-OUTPUT          ] I found the customer. [PERSON_001] (email: [EMAIL_001], account: [ACCOUNT_001]) has a balance of $5250.00.
[CONSUMER-RESPONSE     ] I found the customer. John Smith (email: john.smith@acme.com, account: ACC-12345678) has a balance of $5250.00.
```

The consumer response contains real values. The model input/output contains only placeholders. The raw tool result has PII; the redacted tool result does not.

## What the tests prove

Run `pnpm test` to verify:

1. **Consumer sends real PII, LLM sees only placeholders** — The model's received messages never contain real names, emails, phones, account IDs, or SSNs.

2. **Tool results are redacted before the LLM sees them** — The tool returns raw PII, but the `afterTool` hook redacts it. The model's second call sees only placeholders in the tool result.

3. **Consumer response has real values restored, no placeholders** — The `beforeResponse` hook restores all placeholders. The consumer never sees `[PERSON_001]` — they see `John Smith`.

4. **Log entries show the full redaction lifecycle** — Every stage (model-input, tool-result-raw, tool-result-redacted, model-output, consumer-response) is logged, proving the swap happened at each point.

5. **Placeholders are consistent across multiple turns** — When the same person is referenced in multiple messages within a conversation, the same placeholder is used every time. The LLM can reason about `[PERSON_001]` across turns.

## Files

| File | Purpose |
|---|---|
| `customers.csv` | Sample datasource with PII (names, emails, phones, account IDs, SSNs) |
| `csv-tool.ts` | Internal tool that queries the CSV and returns raw PII |
| `pii-swap.ts` | PII swap extension — redacts on the way in, restores on the way out |
| `logging-model.ts` | Mock model that logs what it sees and simulates tool calling |
| `index.ts` | Wires up the agent, PII extension, CSV tool, and OpenAI-compatible server |
| `server.test.ts` | 5 tests proving the redaction works end-to-end |

## The PII swap extension hooks

| Hook | What it does |
|---|---|
| `beforeLLM` | Redacts PII from all messages before the LLM sees them |
| `beforeTool` | Restores placeholders in tool call arguments so tools get real values |
| `afterTool` | Redacts PII from tool results before they enter the conversation |
| `beforeResponse` | Restores placeholders to real values in the final response |

## Using a real LLM

This example uses a mock model (`LoggingMockModel`) so it works without API keys. To use a real upstream LLM, replace the model in `index.ts`:

```typescript
import { resolveModel } from '@xandout/libra-harness/extras/models';

const model = await resolveModel('deepseek/deepseek-v4-flash');
// or: openai/gpt-4.1-mini, anthropic/claude-3.5-sonnet, etc.

const agent = new Agent({
  model,
  systemPrompt: 'You are a customer support assistant. Use the lookup_customer tool.',
  tools: [createCsvLookupTool()],
});

agent.use(createPiiSwapExtension({ detect, restore: restorePlaceholders, log }));
```

The PII swap works identically with a real LLM — the redaction happens in hooks, not in the model. The LLM provider receives only placeholderized text regardless of which upstream model you use.

## PII detection

This example uses regex patterns (emails, phones, SSNs, account IDs) plus a known-names list derived from the CSV. A production implementation would use:

- Named entity recognition (NER) for person names, addresses, organizations
- Custom patterns for domain-specific identifiers
- A local NLP model for contextual PII detection
- Configurable policies per agent

The detection function is pluggable — pass any `detect` function to `createPiiSwapExtension`.
