# AGENTS.md

## Project: Hookable Agent Harness

This repository contains a **composable agent harness/library**.

The core is implemented and feature-complete.

The primary goal is to provide a small, composable agent runtime that can be embedded into other applications as a library.

---

# Core Idea

The central architectural rule is:

> **The core agent system is responsible for the actual LLM interaction. Everything else is an extension.**

The agent is **not an event-driven application**.

The agent is **not inherently a server**.

The agent is **not inherently a daemon/process**.

The agent should be usable as an ordinary library:

```typescript
const agent = new Agent({
  model,
  systemPrompt,
})

const result = await agent.run({
  message: "Hello"
})
```

A host application may choose to expose that agent through HTTP, Slack, WebSockets, CLI, another agent, or some other interface, but none of those interfaces belong in the core.

---

# Architectural Goals

The system should be:

* Library-first
* Embeddable
* Synchronous in architectural ownership, even if implementation is asynchronous
* Hookable
* Extensible
* Composable
* Provider-independent where practical
* Testable without external infrastructure
* Small at its core
* Capable of supporting multiple independent agents
* Capable of eventually running either locally or as part of a distributed system

Distribution should be an optional deployment concern, not a requirement of the agent architecture.

---

# What the Core Agent Owns

The core should understand only concepts necessary to execute an agent turn.

The core owns:

* Agent configuration
* Model configuration
* System instructions
* Messages
* Turn execution
* LLM requests
* LLM responses
* Tool definitions
* Tool calls
* Tool results
* Tool-call continuation
* Hook execution
* Final turn results
* Core execution errors
* Streaming delta forwarding (via `ModelRequest.onDelta`)

The core may contain abstractions around model providers and tools.

Everything else should be considered an extension unless there is a compelling architectural reason otherwise.

---

# What the Core Must NOT Own

Do not put these concepts directly into the core:

* Sessions
* Session persistence
* Memory
* Long-term memory
* Databases
* Redis
* S3
* MCP
* Slack
* Discord
* HTTP servers
* WebSocket servers
* Message queues
* Event buses
* Authentication
* Authorization
* Organizations
* Users
* UI
* Logging systems
* Metrics systems
* Tracing systems
* Scheduling
* Background workers
* Agent networking
* Agent discovery

These may all be implemented as extensions, adapters, or host-application functionality.

If a proposed feature requires adding one of these concepts to the core, stop and reconsider whether it belongs in an extension.

---

# The Agent Is a Library

The agent must be usable without starting a server.

This must be possible:

```typescript
const agent = new Agent({
  model,
})

const result = await agent.run(request)
```

There must be no requirement for:

* A daemon
* A running agent service
* A socket
* A queue
* A database
* Redis
* HTTP
* WebSockets
* External persistence

A host application should be able to instantiate one or more agents in-process.

For example:

```typescript
const researchAgent = new Agent(...)
const codingAgent = new Agent(...)
const executiveAgent = new Agent(...)

const result = await researchAgent.run(...)
```

The same library should also be usable inside a long-running process if an application wants that.

---

# Turn Lifecycle

The harness executes an agent turn.

A turn may contain multiple LLM/tool iterations.

For example:

```text
User Request
    │
    ▼
Prepare Turn
    │
    ▼
Prepare Context
    │
    ▼
LLM
    │
    ├── final response ──────────────┐
    │                               │
    └── tool call                   │
          │                         │
          ▼                         │
      Execute Tool                  │
          │                         │
          ▼                         │
      Tool Result                   │
          │                         │
          └──────► LLM ─────────────┤
                                    │
                                    ▼
                              Final Response
```

The harness owns this continuation loop.

An LLM response containing a tool call does not necessarily end the turn.

Extensions must be able to participate in each relevant stage of the lifecycle.

---

# Hooks Are the Extension Mechanism

The primary extension mechanism is a lifecycle hook system.

Hooks are not merely event notifications.

They must support both:

1. Observation
2. Mutation

Conceptually:

```typescript
beforeTurn
beforeContext
beforeLLM
afterLLM
beforeTool
afterTool
beforeResponse
afterTurn
onError
```

The lifecycle also includes steering and halting — turns can be redirected mid-execution via `RunHandle.steer()` or cancelled via `RunHandle.halt()`. Hooks can access these via `ctx.turn.steer()` and `ctx.turn.halt()`.

---

# Mutable Turn Context

Hooks should receive structured turn state.

Conceptually:

```typescript
interface TurnContext {
  request: AgentRequest
  messages: Message[]
  tools: Tool[]
  response?: AgentResponse
  metadata: Record<string, unknown>
  signal: AbortSignal
  steer: (message: string) => void
  halt: (reason?: string) => void
}
```

The actual type system should be designed carefully.

The context should represent **execution state**, not the entire application.

Do not turn the context into a service locator.

Avoid designs such as:

```typescript
context.session
context.memory
context.database
context.slack
context.user
context.mcp
context.permissions
```

That recreates the coupling this architecture is specifically intended to avoid.

Extensions should own their own state.

The hook context exists so extensions can participate in a turn.

---

# Extensions

Extensions should be first-class.

Conceptually:

```typescript
interface AgentExtension {
  name: string
  install(agent: Agent): void
}
```

The precise API can differ based on implementation language and design.

The important property is:

> An extension adds behavior to the agent without requiring the core to understand that behavior.

An agent may be composed like:

```typescript
const agent = new Agent({
  model,
})

agent.use(sessionExtension)
agent.use(memoryExtension)
agent.use(mcpExtension)
agent.use(observabilityExtension)
```

The core should not need conditional logic such as:

```typescript
if (memoryEnabled) ...
if (mcpEnabled) ...
if (slackEnabled) ...
```

Prefer polymorphism and hooks.

---

# Session Management

Session management is an extension.

For example:

```text
beforeTurn
    │
    ▼
Session Extension loads state
    │
    ▼
Messages/context prepared
    │
    ▼
LLM interaction
    │
    ▼
afterTurn
    │
    ▼
Session Extension persists state
```

The core should not care whether the session is stored in:

* Memory
* JSONL
* SQLite
* PostgreSQL
* Redis
* S3
* Another system

A session extension may implement any of these.

---

# Memory

Memory is an extension.

A memory extension may use hooks to:

* Retrieve relevant memories
* Inject context
* Observe conversations
* Extract durable information
* Persist memories
* Apply memory policies

For example:

```text
beforeContext
    ↓
Retrieve relevant memory
    ↓
Modify context
    ↓
LLM interaction
    ↓
afterTurn
    ↓
Extract/persist memory
```

The core should have no built-in concept of long-term memory.

---

# MCP

MCP is an extension.

The core should only understand the generic concept of a tool.

An MCP extension may:

* Connect to MCP servers
* Discover MCP tools
* Register tools
* Route tool calls
* Return tool results
* Manage MCP lifecycle

From the core's perspective:

```text
MCP Tool
    ↓
Tool
```

There should be no special MCP path through the core.

A tool could come from:

* Native code
* MCP
* HTTP
* Another agent
* A database
* A local process
* Anything else

The harness should not need to know.

---

# Interfaces

Interfaces are outside the core.

For example:

```text
Slack
   ↓
Slack Adapter
   ↓
AgentRequest
   ↓
Agent Library
   ↓
AgentResponse
   ↓
Slack Adapter
   ↓
Slack
```

Likewise:

```text
HTTP
CLI
WebSocket
Discord
Another Agent
Scheduled Task
```

can all be hosts or adapters around the library.

Do not build an HTTP or WebSocket server into the core agent.

---

# Multiple Agents

The architecture must support multiple independent agents.

An agent should primarily be a composition of:

```text
Model
+
Instructions
+
Tools
+
Extensions
```

Different agents may have completely different behavior.

For example:

```text
Research Agent
  Model
  Research tools
  Shared memory
  MCP

Coding Agent
  Model
  Code tools
  Repository memory
  MCP

Private Assistant
  Model
  Private memory
  Personal tools
```

There should be no global singleton agent.

There should be no assumption that there is only one agent in a process.

---

# Agents Calling Agents

The architecture should make agent-to-agent composition possible without requiring network communication.

For example:

```typescript
const research = await researchAgent.run({
  message: "Research this customer"
})
```

An agent may also be exposed as a tool:

```text
Agent A
  │
  └── agent tool
          │
          ▼
      Agent B
```

This should be possible entirely in-process.

Networking, queues, RPC, or other distributed mechanisms can later be implemented as extensions/adapters if required.

Important principle:

> **Local composition first. Distribution is optional.**

---

# Extension Ordering

Hook ordering must be deterministic.

Extension ordering can materially affect behavior.

For example:

```text
session
→ memory
→ permissions
→ tools
→ observability
```

may produce a different result than another ordering.

Define clear semantics for:

* Extension registration order
* Hook ordering
* Nested hooks/middleware
* Errors
* Short-circuiting
* Mutation

Do not rely on accidental behavior.

If priorities are needed, implement them explicitly.

## Priority Semantics

Hook execution order within each lifecycle stage is determined by
**extension priority** (higher = runs first), with registration order
as the tiebreaker (stable sort). This applies to every registration
path — `agent.use()`, the extension loader, and direct `agent.hook()`
calls. Extensions that don't set `priority` default to 0 and retain
registration order relative to other default-priority extensions.

```typescript
// Priority makes ordering explicit and independent of use() call order.
const keywordLogger = { name: 'keyword-logger', priority: 50, install(a) { ... } };
const session = { name: 'session', priority: -100, install(a) { ... } };

// Both of these produce the same hook execution order:
agent.use(session).use(keywordLogger);
agent.use(keywordLogger).use(session);
```

Set `priority` on any extension whose hooks must run before or after
another extension's hooks in the same stage. Observability extensions
typically use high priorities (so they see raw state before mutators);
persistence extensions typically use low or negative priorities (so
they run after enrichment).

---

# Error Handling

Explicitly model failures from:

* Model calls
* Tool execution
* Hooks
* Extensions
* Agent requests

Do not silently swallow errors.

Determine which failures:

* Abort the turn
* Can be transformed into tool results
* Can be recovered from
* Can be observed while allowing execution to continue

An extension should be able to intentionally stop or modify execution where appropriate.

## Error Policy

When an error is thrown during a turn (model failure, hook crash, etc.),
the core fires `onError` hooks first. If a hook returns
`{ skip: true, value: AgentResponse }`, the turn recovers with that
response. If no hook recovers, the **error policy** decides what happens
next.

The error policy is configured via `AgentConfig.errorPolicy`:

```typescript
const agent = new Agent({
  model,
  errorPolicy: 'fallback', // default — graceful response
});
```

Three options:

| Policy | Behavior |
|--------|----------|
| `'fallback'` (default) | Returns a graceful response with `finishReason: 'error'`. The error is attached to `response.metadata.error` so observability extensions can inspect it via `afterTurn`. The message is customizable via `AgentConfig.fallbackMessage`. |
| `'throw'` | Rethrows the error. Use this for strict fail-fast behavior where you want to handle errors at the call site. |
| `function` | Custom recovery. Receives `{ error, turn }` and returns an `AgentResponse` to recover, or `undefined` to rethrow. Runs *after* all `onError` hooks. |

Precedence: `onError` hooks → error policy. Hooks always run first and
take precedence — if a hook recovers, the policy is not consulted.

```typescript
// Strict — errors propagate to the caller.
const strict = new Agent({ model, errorPolicy: 'throw' });

// Default — graceful fallback, custom message.
const graceful = new Agent({
  model,
  fallbackMessage: 'Something went wrong. Please rephrase your request.',
});

// Custom — route different errors to different responses.
const custom = new Agent({
  model,
  errorPolicy: ({ error, turn }) => {
    if (error instanceof ModelError && error.status === 429) {
      return {
        role: 'assistant',
        message: 'Rate limited. Please wait a moment and retry.',
        finishReason: 'error',
        iterations: 0,
        metadata: turn.metadata,
      };
    }
    return undefined; // rethrow everything else
  },
});
```

Tool errors are handled separately — they are always converted to tool
results (with `isError: true`) so the model can react. The error policy
only applies to errors that escape the turn loop (model failures, hook
crashes, etc.).

---

# Observability

Observability is an extension.

The core may expose lifecycle information through hooks, but should not require a logging, metrics, or tracing backend.

An observability extension should be able to observe:

* Turn start
* Turn completion
* LLM request
* LLM response
* Tool call
* Tool result
* Hook execution
* Errors
* Timing

---

# Testing Philosophy

Tests should prove the architecture.

Do not merely test that individual methods return expected values.

Demonstrate that functionality can genuinely be implemented outside the core.

At minimum, tests should cover:

1. Bare agent with no extensions.
2. Extension that modifies context.
3. Extension that modifies messages.
4. Extension that adds a tool.
5. Extension that observes an LLM response.
6. Multiple extensions with deterministic ordering.
7. Tool-call continuation through multiple LLM iterations.
8. Session implemented as an extension.
9. Memory implemented as an extension.
10. MCP-style tools implemented as an extension.
11. Extension errors.
12. Hook mutation.
13. Multiple independent agents in one process.
14. Agent calling another agent locally.

All 14 scenarios are implemented in `test/architecture.test.ts` (88 tests, 95% line coverage). The test suite also covers:

15. Steering (mid-turn redirection).
16. Halting (mid-turn cancellation).
17. `beforeResponse` hook.
18. `afterTool` hook mutation.
19. Concurrent `RunHandle` steer/halt independence.
20. `TurnContext`-level steer/halt.
21. Error observation and recovery (`onError` hook).
22. Halt edge cases (halt at each lifecycle stage).
23. Error class coverage.
24. Agent edge cases (duplicate extensions, tool-not-found, invalid JSON args, tool errors).
25. `HookRegistry` coverage.
26. Default error policy (`'fallback'`), `'throw'` policy, custom policy function, `fallbackMessage`, `onError` hook precedence over policy, `afterTurn` after fallback.

Tests should make architectural coupling obvious.

If removing an extension requires modifying the core, the architecture is probably wrong.

---

## Repository Design

The repository is implemented with:

* **Language/runtime:** TypeScript (ES2022, ESM)
* **Package manager:** pnpm (workspace)
* **Build:** `tsc` (no bundler)
* **Test framework:** Vitest 4.x with `@vitest/coverage-v8`
* **Model abstraction:** `Model` interface with `AISdkModel` (Vercel AI SDK wrapper)
* **Tool abstraction:** `Tool` interface with JSON Schema parameters
* **Agent API:** `Agent` class with `run()`, `use()`, `hook()`, `tool()`, `errorPolicy`
* **Hook API:** `HookRegistry` with 9 lifecycle stages + `onError`
* **Extension API:** `Extension` interface with `name` + `install(agent)` + optional `priority` (controls hook execution order) + `close()`
* **Run controls:** `RunHandle` with `steer()`, `halt()`, `done`, thenable

### Source layout

```
src/
  agent.ts        — Agent class, turn execution loop, tool-call continuation
  ai-sdk-model.ts — AISdkModel (wraps Vercel AI SDK providers, supports streaming via doStream)
  model.ts        — Model interface, ModelRequest, ModelResponse
  tool.ts         — Tool interface, ToolContext, toToolDefinition
  hooks.ts        — HookRegistry, HookContext, HookResult
  context.ts      — AgentRequest, AgentResponse, TurnContext
  extension.ts    — Extension interface (name, install, priority, close)
  handle.ts       — RunHandle interface
  errors.ts       — LibraError, ModelError, ToolError, HookError, HaltedError, MaxIterationsError
  types.ts        — Role, Message, ToolCall, ToolResult, ToolDefinition
  index.ts        — barrel exports
  extras/
    extension-loader.ts  — loadExtensions, installExtensions, closeExtensions, sharedExtensionsDir
    extensions/          — built-in extensions (logger, streaming, weather-tool, etc.)
    README.md            — extras documentation
```

### Examples

`examples/full-agent/` contains a working example with:
- All built-in extensions loaded via `loadExtensions` (logger, streaming, structured-output, mcp, skills, weather-tool, emoji, timestamp, session)
- A local search-replace extension demonstrating directory-loaded extensions
- Multi-turn session memory, MCP tool usage, skill loader demo
- Both DeepSeek and Gemini models

Other examples:
- `examples/basic-agent-concurrent/` — single agent handling concurrent users with session isolation and per-turn halt
- `examples/subagents/` — orchestrator delegating to specialized subagents via `createAgentTool`
- `examples/subagents-concurrent/` — orchestrator fanning out to subagents in parallel
- `examples/structured-output/` — JSON schema validation with retry patterns
- `examples/streaming/` — text/reasoning/tool-input delta streaming

### Extras

`src/extras/` contains the extension loader and built-in extensions:
- `extension-loader.ts` — `loadExtensions`, `installExtensions`, `closeExtensions`, `sharedExtensionsDir`
- `extensions/logger/` — lifecycle logging (priority 100)
- `extensions/streaming/` — delta streaming via `onDelta` (priority 100)
- `extensions/weather-tool/` — `get_weather` tool (priority 50)
- `extensions/structured-output/` — JSON schema validation (priority 50)
- `extensions/mcp/` — MCP server connections and tool discovery (priority 50)
- `extensions/skills/` — Agent Skills loader with progressive disclosure (priority 50)
- `extensions/emoji/` — response emoji prefix (priority 0)
- `extensions/timestamp/` — start/finish timestamps (priority 0)
- `extensions/session/` — in-memory session history (priority -100)
- `extensions/scripts/` — durable on-disk script registry; agent-authored JS runs in a sandboxed QuickJS WASM runtime; input inline or via allowed disk paths (priority 50)

Each extension is importable via `libra/extras/<name>` and documented in `src/extras/README.md`.

---

# Design Priorities

When making architectural decisions, prioritize in this order:

1. Clear separation between core and extensions
2. Embeddability as a library
3. Simple turn execution model
4. Powerful hooks
5. Composable extensions
6. Multiple-agent support
7. Testability
8. Provider flexibility
9. Future distributed execution

Do not sacrifice the first principles to optimize for hypothetical distributed deployment.

---

# Anti-Patterns

Avoid:

### Event Bus as Core Architecture

Do not make the agent an event bus.

Hooks are lifecycle middleware/interceptors, not an application-wide event system.

### God Context

Do not create a giant context object containing every subsystem.

### Service Locator

Do not make extensions discover arbitrary global services through the context.

### Core Knowledge of Extensions

Avoid:

```typescript
if (mcp) ...
if (memory) ...
if (session) ...
```

### Mandatory Persistence

An agent must be able to execute without persistence.

### Mandatory Server

An agent must be able to execute as an imported library.

### Global State

Avoid global agent/session state.

### Premature Distribution

Do not introduce queues, brokers, RPC, or network protocols simply because agents may eventually be distributed.

---

# Desired End State

The ideal architecture should make this possible:

```typescript
const agent = new Agent({
  model,
  systemPrompt,
  tools,
})

agent.use(memory)
agent.use(session)
agent.use(mcp)
agent.use(observability)

const result = await agent.run({
  message: "What should we do next?"
})
```

The same agent library should work inside:

```text
┌────────────────────────────────────┐
│ Application                        │
│                                    │
│  Slack adapter                     │
│  HTTP API                          │
│  CLI                               │
│  Web application                   │
│  Another agent                     │
│  Background worker                 │
│                                    │
│          ↓                         │
│                                    │
│     Agent Library                  │
│          ↓                         │
│     LLM Provider                   │
│                                    │
└────────────────────────────────────┘
```

without modifying the agent core.

The fundamental boundary is:

> **The harness executes turns. Extensions give the agent capabilities. The host application decides how the agent is invoked.**

Build toward that boundary consistently.

# IMPORTANT

Agents must be steerable and haltable. This is implemented via `RunHandle` (returned by `agent.run()`) and `ctx.turn.steer()` / `ctx.turn.halt()` (available in hooks). Each turn gets its own independent handle — concurrent turns can be steered or halted without affecting each other.