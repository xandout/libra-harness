# Virtual Models

## What is a virtual model?

A virtual model is a Libra agent exposed through an OpenAI-compatible HTTP interface. To any consuming framework, SDK, or downstream agent, it looks and behaves like a model — it has a model ID, accepts chat completions, returns responses, supports tool calling, and can be streamed. But behind the model ID is a full agent harness with its own context, workspace, tools, extensions, and policy controls.

The consuming framework never sees the agent. It sees a model.

```
Consumer framework
    │
    │  OpenAI-compatible API call
    │  POST /v1/chat/completions
    │  model: "research-agent"
    │  tools: [client-side tools]
    │
    ▼
┌─────────────────────────────────┐
│  OpenAI-compatible provider     │
│  (libra/extras/openai-provider) │
└─────────────────────────────────┘
    │
    │  Agent run
    │
    ▼
┌─────────────────────────────────┐
│  Libra Agent (virtual model)    │
│                                 │
│  • System prompt                │
│  • Message history              │
│  • Internal tools               │
│  • Extensions (memory, MCP...)  │
│  • Hooks (moderation, audit...) │
│  • Error policy                 │
│                                 │
│  Calls upstream LLM provider    │
└─────────────────────────────────┘
    │
    │  Model request
    │
    ▼
  Upstream LLM (DeepSeek, OpenAI, Anthropic, Google...)
```

The virtual model provider sits between the consumer and the upstream LLM. It controls what goes in, what comes out, and everything in between.

---

## Why virtual models?

A raw LLM is stateless, contextless, and toolless. Every consuming application has to rebuild context, manage history, wire up tools, and enforce policy on its own. Virtual models move that responsibility to the provider.

| Without virtual models | With virtual models |
|---|---|
| Consumer manages message history | Provider manages history per agent |
| Consumer wires up tools | Provider configures internal tools |
| Consumer enforces policy | Provider enforces policy via hooks |
| Consumer handles model routing | Provider routes (e.g. vision to vision model) |
| Consumer manages sessions | Provider manages sessions via extensions |
| Each consumer reimplements context | Context is baked into the agent |
| Tools travel with the consumer | Tools travel with the model |

The consumer just calls a model. The provider handles the rest.

---

## What a virtual model owns

Each virtual model is an independent agent with its own:

- **System prompt** — the baseline instructions the model operates under. The consumer cannot override this.
- **Message history** — preserved across requests. The consumer sends the conversation; the provider can augment, filter, or replace it.
- **Internal tools** — tools the agent executes itself (MCP servers, filesystem, custom tools). Invisible to the consumer.
- **External tools** — tools the consumer passes in the request. The agent returns their calls to the consumer for execution.
- **Extensions** — memory, sessions, observability, logging, skills. Each agent has its own extension set.
- **Hooks** — moderation, context injection, response filtering, auditing. The provider controls every lifecycle stage.
- **Error policy** — graceful fallback, strict fail-fast, or custom recovery.
- **Model routing** — the agent can route to different upstream models based on input (e.g. images to a vision model).

---

## Use cases

### Commercial

**Productized agents.** Expose specialized agents as models to paying customers. Each customer integrates via a standard OpenAI-compatible API — no SDK to install, no proprietary protocol. The customer passes their own tools; you control the agent's behavior, context, and policy.

```
Customer app → your virtual model API → your agent → upstream LLM
```

**Multi-tenant agent hosting.** Run different agents for different customers, each with its own system prompt, tool set, and data access. Customers see different model IDs (`acme/support-agent`, `globex/research-agent`) backed by different agent configurations.

**Value-added model reselling.** Sit between a raw LLM provider and your customers. Add memory, tools, moderation, audit logging, and custom context that the raw provider doesn't offer. Charge for the added layer.

**Agent marketplace.** Expose many specialized agents as models. Consumers pick the one that fits their task. Each agent has domain-specific tools, context, and instructions baked in.

### Platform

**Internal agent platform.** Give teams within an organization a set of pre-configured agents as models. Teams don't need to know how the agents work — they just call them. Platform engineers control behavior, security, and cost centrally.

**Tool gateway.** Centralize access to internal tools (databases, APIs, file systems) through agents. Downstream consumers call a model; the agent executes tools on their behalf with provider-controlled permissions.

**Model migration.** Switch upstream LLM providers without changing consumer code. The virtual model abstracts the upstream provider. Move from OpenAI to DeepSeek to Anthropic by changing the agent's model configuration — consumers see the same model ID.

**Cost control.** Route requests to cheaper models for simple tasks and more capable models for complex ones. The routing model extension handles this transparently.

### Educational

**Tutoring agents.** Each subject (math, history, programming) gets its own agent with domain-specific tools, reference materials, and pedagogical instructions. Students interact via a standard chat interface; the agent has the curriculum baked in.

**Sandboxed learning environments.** Students learn to build agent-based applications by calling virtual models. They don't need access to upstream LLM keys or complex infrastructure — they just call a model.

**Curriculum-controlled agents.** Instructors configure agents with specific constraints (only use approved sources, refuse to give direct answers, guide step-by-step). Students get a consistent, controlled learning experience.

**Assignment grading agents.** Expose agents that evaluate student submissions with specific rubrics and tools. The grading logic is invisible to the student interface.

---

## Layered security

Virtual models enable a defense-in-depth approach where security controls are applied at multiple independent layers. No single layer is trusted with full access.

### Layer 1: Authentication and authorization (provider edge)

The OpenAI-compatible provider validates API keys before any request reaches an agent. Different agents can require different keys, giving you per-agent access control.

```
Consumer → API key validation → agent routing
```

### Layer 2: Input moderation (beforeTurn / beforeLLM hooks)

Before the model is called, hooks can inspect and reject user input. This is your first line of defense against prompt injection, banned content, and policy violations.

```typescript
agent.hook('beforeLLM', 'input-moderation', async (ctx) => {
  const text = extractText(ctx.turn.messages.at(-1));
  if (detectPromptInjection(text)) {
    return { skip: true, value: refusalResponse('Request blocked.') };
  }
});
```

### Layer 3: Context and instruction control (agent configuration)

The agent's system prompt is set by the provider, not the consumer. Even if the consumer sends a `system` message, the agent's configured instructions take precedence. This prevents consumers from overriding safety instructions.

### Layer 4: Tool scoping (tool configuration)

Internal tools are configured by the provider. The agent only has access to the tools you give it. A research agent has research tools; a coding agent has coding tools. No agent has tools outside its domain.

External tools (consumer-defined) are returned to the consumer for execution — the agent never runs them. This means the consumer's tools cannot access the provider's internal systems.

### Layer 5: Output filtering (afterLLM / beforeResponse hooks)

After the model responds, hooks can inspect and modify the output before it reaches the consumer. This catches leaked secrets, policy-violating content, and hallucinated tool calls.

```typescript
agent.hook('beforeResponse', 'output-filter', async (ctx) => {
  if (ctx.turn.response) {
    ctx.turn.response.message = redactSecrets(ctx.turn.response.message);
  }
});
```

### Layer 6: Upstream provider isolation

The agent chooses which upstream LLM to call. Consumers never see the upstream API key, model name, or provider. If an upstream provider is compromised or behaves unexpectedly, the blast radius is limited to that provider connection — not the consumer's application.

### Layer 7: Session and data isolation

Each agent can have its own session storage, memory, and MCP connections. Agent A cannot read Agent B's sessions. A compromise of one agent's data does not expose other agents' data.

---

## Blast radius reduction

The core principle: **compromise of one layer should not expose everything.**

### Consumer compromise

If a consumer's API key is stolen, the attacker can only call the agents that key is authorized for. They cannot:
- Access the upstream LLM keys (those are server-side)
- Override the agent's system prompt
- Execute arbitrary code on the provider's infrastructure
- Access other agents' sessions or memory
- See the agent's internal tools or extensions

### Agent compromise

If an agent is manipulated (e.g. via prompt injection), the damage is bounded:
- The agent only has access to its configured tools — not the filesystem, not other agents, not the host system
- Output filtering catches leaked data before it reaches the consumer
- Session isolation prevents lateral movement between agents
- The upstream provider key is not exposed to the agent's output

### Upstream provider compromise

If the upstream LLM provider is compromised, the attacker cannot:
- Reach the consumer (the provider sits in between)
- Access other agents' sessions or tools
- Inject tools (tools are provider-configured, not model-configured)

### Tool compromise

If a tool behaves maliciously or returns dangerous output:
- `afterTool` hooks can inspect and sanitize tool results before the model sees them
- Tool errors are converted to tool results (not propagated as exceptions)
- External tools run on the consumer's side — the provider's infrastructure is not exposed

---

## Architecture summary

```
┌──────────────────────────────────────────────────────┐
│  Consumer (framework, SDK, downstream agent)         │
│                                                      │
│  • Owns external tools                               │
│  • Sends OpenAI-compatible requests                  │
│  • Receives responses + tool_calls                   │
└──────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│  Provider edge                                       │
│                                                      │
│  • API key authentication                            │
│  • Per-agent authorization                           │
│  • Request routing                                   │
└──────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│  Virtual model (Libra agent)                         │
│                                                      │
│  • System prompt (provider-controlled)               │
│  • Message history (provider-managed)                │
│  • Internal tools (provider-configured)              │
│  • Extensions (memory, session, MCP, observability)  │
│  • Hooks (moderation, filtering, audit)              │
│  • Model routing (vision, cost, capability)          │
│  • Error policy (fallback, throw, custom)            │
└──────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│  Upstream LLM provider                               │
│                                                      │
│  • DeepSeek, OpenAI, Anthropic, Google...            │
│  • Provider key never exposed to consumer            │
└──────────────────────────────────────────────────────┘
```

Each layer is independently secured. Each agent is independently scoped. The consumer sees a model; the provider controls everything else.
