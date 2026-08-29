# Virtual Models as a DLP/PII Layer

## The problem

When you send a conversation to an upstream LLM, you send everything — names, emails, phone numbers, addresses, account IDs, internal system names. The LLM provider sees it all. If the conversation includes history, every prior turn with PII is resent. There is no way to retroactively redact a message that was already sent.

Existing DLP approaches try to solve this at the network edge (proxy filtering) or at the application layer (pre-processing text before calling the API). Both have the same limitation: they see one request at a time. They don't maintain state across turns. They can't ensure that a placeholder used in turn 1 is the same placeholder used in turn 5, so the LLM loses referential consistency and produces worse output.

## The twist

A Libra virtual model sits between the consumer and the upstream LLM and controls **both sides of every turn**. It can:

1. Intercept the user's input **before** it goes to the LLM
2. Intercept the LLM's response **before** it goes back to the consumer
3. Maintain its own session state across turns

This means the virtual model can run a consistent, stateful PII swap: replace real identifiers with stable placeholders on the way in, and restore them on the way out. The upstream LLM never sees real PII — not in the current message, not in historical context, not in tool results. The consumer never sees placeholders — they get their real data back.

```
Consumer sends: "What's the status of John Smith's account (john@acme.com)?"
         │
         ▼
┌──────────────────────────────────────┐
│  Virtual model (Libra agent)         │
│                                      │
│  beforeLLM hook:                     │
│    "John Smith"    → "[PERSON_001]"  │
│    "john@acme.com" → "[EMAIL_001]"   │
│                                      │
│  Session state maps:                 │
│    [PERSON_001] → "John Smith"       │
│    [EMAIL_001]  → "john@acme.com"    │
│                                      │
│  Sends to LLM:                       │
│    "What's the status of             │
│     [PERSON_001]'s account           │
│     ([EMAIL_001])?"                  │
└──────────────────────────────────────┘
         │
         ▼
Upstream LLM sees placeholders only

         │
         ▼
LLM responds: "I checked [EMAIL_001].
              [PERSON_001]'s account is active."
         │
         ▼
┌──────────────────────────────────────┐
│  Virtual model (Libra agent)         │
│                                      │
│  beforeResponse hook:                │
│    "[PERSON_001]" → "John Smith"     │
│    "[EMAIL_001]"  → "john@acme.com"  │
│                                      │
│  Returns to consumer:                │
│    "I checked john@acme.com.         │
│     John Smith's account is active." │
└──────────────────────────────────────┘
         │
         ▼
Consumer receives real values restored
```

The upstream LLM sees a consistent conversation with stable placeholders. The consumer sees a normal conversation with real values. Neither side knows the swap happened.

---

## Why this works

### Consistent placeholders across turns

The virtual model maintains a session-scoped mapping table. Every time "John Smith" appears — in turn 1, turn 5, or turn 20 — it becomes `[PERSON_001]`. The LLM can reference `[PERSON_001]` across turns and maintain coherent reasoning. This is the critical difference from stateless DLP proxies, which might redact the same name differently in each request.

```
Turn 1: "Tell me about John Smith"     → "Tell me about [PERSON_001]"
Turn 2: "What's his email?"            → "What's [PERSON_001]'s email?"
Turn 3: "Send John a summary"          → "Send [PERSON_001] a summary"
```

The LLM sees a stable identity. It can reason about `[PERSON_001]` across the whole conversation. The consumer never sees the placeholder.

### Historical context is already redacted

Because the virtual model manages its own message history (via the `beforeContext` hook), the history it sends to the LLM is the redacted version. It doesn't re-redact on each turn — the stored history already contains placeholders. This means:

- Turn 5's request to the LLM includes turns 1-4 with placeholders, not real PII
- The mapping table grows as new identifiers appear, but prior turns don't need reprocessing
- The LLM's context window contains zero real PII at any point

### Tool results are covered too

When the agent executes an internal tool (e.g. a database lookup), the tool result may contain PII. The `afterTool` hook can redact tool results before they enter the conversation history. The LLM sees `[ACCOUNT_001] has balance $5,000`, not `Account 12345678 belonging to John Smith has balance $5,000`.

---

## Implementation pattern

### The PII swap extension

A PII swap extension is a set of hooks that work together across the turn lifecycle:

```
beforeContext    → Restore redacted history from session
beforeLLM        → Scan and redact PII from the latest message
afterLLM         → (no-op — LLM output uses placeholders)
afterTool        → Redact PII from tool results
beforeResponse   → Restore placeholders to real values in the response
afterTurn        → Persist the mapping table and redacted history
```

### Session state

Each conversation gets its own mapping table:

```typescript
interface PiiMapping {
  // placeholder → real value
  '[PERSON_001]':  'John Smith',
  '[EMAIL_001]':   'john@acme.com',
  '[ACCOUNT_001]': '12345678',
  '[PHONE_001]':   '+1-555-0100',
}
```

The mapping is scoped to the session. When the session ends, the mapping is discarded. Different consumers (or different conversations from the same consumer) get independent mappings.

### Detection

PII detection can range from simple to sophisticated:

- **Regex patterns** — emails, phone numbers, SSNs, credit card numbers, account IDs
- **Named entity recognition** — person names, addresses, organizations (via a local NLP model or a dedicated detection tool)
- **Custom identifiers** — internal system names, employee IDs, project codenames (domain-specific patterns)
- **Configurable policies** — different agents can have different PII rules (a customer support agent redacts customer data; an internal analytics agent redacts employee data)

### Placeholder format

Placeholders should be:
- **Unambiguous** — not likely to appear in natural text
- **Stable** — same identifier always maps to the same placeholder within a session
- **Type-labeled** — `[PERSON_001]`, `[EMAIL_001]`, `[ACCOUNT_001]` so the LLM understands the kind of thing it's referencing
- **Reversible** — the mapping table can restore the original value

---

## What the LLM sees vs. what the consumer sees

### Consumer → Virtual model → LLM

| Consumer sends | LLM receives |
|---|---|
| "What's John Smith's balance?" | "What's [PERSON_001]'s balance?" |
| "Email sarah@company.com" | "Email [EMAIL_002]" |
| "Call +1-555-0100" | "Call [PHONE_001]" |
| "Check account 12345678" | "Check account [ACCOUNT_001]" |

### LLM → Virtual model → Consumer

| LLM responds | Consumer receives |
|---|---|
| "[PERSON_001] has balance $5,000" | "John Smith has balance $5,000" |
| "I've sent the summary to [EMAIL_002]" | "I've sent the summary to sarah@company.com" |
| "I called [PHONE_001] — no answer" | "I called +1-555-0100 — no answer" |

### Historical context (what the LLM sees on turn 5)

```
system:    You are a customer support assistant.
user:      What's John Smith's balance?          ← redacted to [PERSON_001]
assistant: [PERSON_001] has balance $5,000.
user:      Email the statement to john@acme.com  ← redacted to [EMAIL_001]
assistant: I've sent the statement to [EMAIL_001].
user:      Now check account 12345678            ← redacted to [ACCOUNT_001]
```

The LLM sees a coherent conversation with stable references. It can reason about `[PERSON_001]` and `[EMAIL_001]` across turns. No real PII has ever left your infrastructure.

---

## Tool result redaction

Internal tools (database lookups, API calls, file reads) often return PII. The `afterTool` hook redacts tool results before they enter the conversation:

```
Tool returns:
  "Account 12345678 (John Smith, john@acme.com) has balance $5,000."

afterTool redacts to:
  "Account [ACCOUNT_001] ([PERSON_001], [EMAIL_001]) has balance $5,000."

This redacted version goes into the message history.
The LLM sees the redacted version.
The consumer never sees the tool result directly — they see the LLM's response,
which is restored on the way out.
```

---

## External tools (consumer-side)

When the consumer passes external tools, the tool calls and results flow through the virtual model. The same redaction applies:

- **Tool call arguments** — redacted before the LLM sees them (the consumer sends real values; the LLM sees placeholders)
- **Tool results** — the consumer sends back real values; the `beforeContext` hook redacts them before they enter the LLM's context

This means even consumer-side tools don't leak PII to the upstream LLM.

---

## Multi-agent isolation

Each virtual model (agent) maintains its own PII mapping. If you expose multiple agents:

```
support-agent    → mapping: { [PERSON_001]: "John Smith", ... }
analytics-agent  → mapping: { [PERSON_001]: "Jane Doe", ... }
```

The same placeholder `[PERSON_001]` maps to different real values in different agents. There is no cross-agent leakage. A compromise of one agent's mapping table does not reveal another agent's PII.

---

## What this protects against

### Upstream LLM provider sees no PII

The upstream provider (DeepSeek, OpenAI, Anthropic, Google) receives only placeholderized text. Even if the provider logs training data, retains conversations, or is compromised, the exposed data contains no real names, emails, phone numbers, account IDs, or other PII.

### Historical context is clean

Because the virtual model manages its own session state, every turn in the history is already redacted. There is no "original" PII version stored in the conversation that could be accidentally sent.

### Tool results are clean

Internal tools may access real PII (database lookups, CRM queries), but the results are redacted before the LLM sees them. The LLM cannot leak through tool result quoting.

### Consumer compromise is limited

If the consumer's API key is stolen, the attacker can call the virtual model but cannot access the mapping table (it lives server-side). They see restored real values in responses, but they cannot extract the mapping or access other sessions' PII.

### Prompt injection cannot extract PII

Even if an attacker tricks the LLM into repeating its context, the context only contains placeholders. "Repeat everything you know about this user" returns `[PERSON_001] has email [EMAIL_001]` — not real values. The real values are only restored in the `beforeResponse` hook, which applies to the final response, not to the LLM's internal context.

---

## What this does not protect against

- **The mapping table itself** — if the server running the virtual model is compromised, the mapping table is accessible. This is a server-side security concern, not something the PII swap can solve. Encrypt the mapping table at rest and restrict access.
- **Side channels** — if the LLM can infer real values from context (e.g. "the CEO of Apple" is obviously Tim Cook), placeholders don't help. This is a fundamental limitation of any redaction approach.
- **Volume attacks** — if an attacker can make many requests, they might infer mappings by correlating responses. Rate limiting and session isolation mitigate this.
- **Non-text modalities** — images and audio may contain PII (faces, voices, documents). Text-based redaction doesn't cover these. A multimodal DLP layer would need to redact images and audio separately.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Consumer                                               │
│                                                         │
│  Sees: real values in responses                         │
│  Sends: real values in requests                         │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  OpenAI-compatible provider                             │
│                                                         │
│  Authenticates request, routes to agent                 │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Virtual model (Libra agent + PII swap extension)       │
│                                                         │
│  ┌─────────────┐    ┌──────────────┐                    │
│  │ Session     │    │ PII mapping  │                    │
│  │ (redacted   │    │ table        │                    │
│  │  history)   │    │              │                    │
│  └─────────────┘    └──────────────┘                    │
│                                                         │
│  beforeContext  → load redacted history from session    │
│  beforeLLM      → scan + redact PII from latest message │
│  afterTool      → redact PII from tool results          │
│  beforeResponse → restore placeholders to real values   │
│  afterTurn      → persist session + mapping             │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Upstream LLM                                           │
│                                                         │
│  Receives: placeholderized text only                    │
│  Returns: placeholderized text                          │
│  Stores: placeholderized text (if retained)             │
└─────────────────────────────────────────────────────────┘
```

---

## Commercial implications

### Compliance

GDPR, CCPA, HIPAA, and similar regulations require controlling how PII is processed and shared with third parties. A PII swap layer ensures that the upstream LLM provider never processes real PII — they process placeholders. This can simplify data processing agreements and reduce regulatory exposure.

### Enterprise sales

Enterprises that block third-party LLM APIs due to data leakage concerns can use virtual models with PII swapping as a compliance control. The virtual model becomes a sellable security layer, not just a convenience.

### Data residency

Because the mapping table and session state live on your infrastructure, the real PII never leaves your jurisdiction. Only placeholders cross the boundary to the upstream LLM. This supports data residency requirements where PII cannot leave a specific region.

### Audit trail

The PII swap extension can log every redaction and restoration event. You have a complete record of what PII was in which message, what placeholder replaced it, and when it was restored. This is valuable for compliance audits and incident investigation.

---

## Extension sketch

```typescript
import type { Extension } from 'libra';

interface PiiSwapConfig {
  // Detect PII in text, return list of (value, type, placeholder) tuples
  detect: (text: string) => Array<{ value: string; type: string; placeholder: string }>;
  // Restore placeholders to real values
  restore: (text: string, mapping: Map<string, string>) => string;
  // Session key extractor — how to identify the conversation
  sessionKey?: (metadata: Record<string, unknown>) => string;
}

function createPiiSwapExtension(config: PiiSwapConfig): Extension {
  // Per-session mapping tables
  const mappings = new Map<string, Map<string, string>>();

  function getMapping(sessionKey: string): Map<string, string> {
    let m = mappings.get(sessionKey);
    if (!m) { m = new Map(); mappings.set(sessionKey, m); }
    return m;
  }

  function redact(text: string, mapping: Map<string, string>): string {
    let result = text;
    for (const { value, placeholder } of config.detect(text)) {
      if (!mapping.has(placeholder)) mapping.set(placeholder, value);
      result = result.replaceAll(value, placeholder);
    }
    return result;
  }

  return {
    name: 'pii-swap',
    priority: 100, // run before other extensions see the message
    install(agent) {
      agent.hook('beforeLLM', 'pii-swap', async (ctx) => {
        const sessionKey = config.sessionKey?.(ctx.turn.metadata) ?? 'default';
        const mapping = getMapping(sessionKey);
        // Redact PII from all messages the LLM will see
        for (const message of ctx.turn.messages) {
          if (typeof message.content === 'string') {
            message.content = redact(message.content, mapping);
          }
        }
      });

      agent.hook('afterTool', 'pii-swap', async (ctx) => {
        const sessionKey = config.sessionKey?.(ctx.turn.metadata) ?? 'default';
        const mapping = getMapping(sessionKey);
        if (typeof ctx.toolResult.content === 'string') {
          ctx.toolResult.content = redact(ctx.toolResult.content, mapping);
        }
      });

      agent.hook('beforeResponse', 'pii-swap', async (ctx) => {
        const sessionKey = config.sessionKey?.(ctx.turn.metadata) ?? 'default';
        const mapping = getMapping(sessionKey);
        if (ctx.turn.response) {
          ctx.turn.response.message = config.restore(ctx.turn.response.message, mapping);
        }
      });
    },
  };
}
```

This is a sketch — a production implementation would need:
- Robust PII detection (NER model, regex library, custom patterns)
- Placeholder collision avoidance
- Multimodal redaction (images, audio)
- Mapping table persistence and encryption
- Session cleanup and TTL
- Logging and audit trail

But the architecture is straightforward: the hooks are already there, the session state is already there, and the virtual model already controls both sides of the turn.
