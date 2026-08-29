# libra

A small, composable, hookable agent harness. Library-first.

The core agent system is responsible for the actual LLM interaction. Everything else is an extension.

## Install

```bash
pnpm add libra
```

## Quick Start

```typescript
import { Agent, AISdkModel } from 'libra'
import { openai } from '@ai-sdk/openai'

const model = new AISdkModel(openai('gpt-4o'))

const agent = new Agent({
  model,
  systemPrompt: 'You are a helpful assistant.',
})

const result = await agent.run({ message: 'Hello!' })

console.log(result.message)
console.log(result.finishReason) // 'stop'
console.log(result.iterations)   // 1
```

## Tools

```typescript
const agent = new Agent({
  model,
  tools: [
    {
      name: 'search',
      description: 'Search the web',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      async execute(args) {
        return { toolCallId: '', content: `results for ${args.query}` }
      },
    },
  ],
})

const result = await agent.run({ message: 'search for cats' })
```

The harness automatically continues the turn after tool calls — tool results are fed back to the model until it produces a final response.

## Extensions

Extensions add behavior without requiring the core to understand it.

```typescript
import type { Extension } from 'libra'

const loggingExtension: Extension = {
  name: 'logging',
  install(agent) {
    agent.hook('beforeLLM', 'logging', async (ctx) => {
      console.log(`LLM call with ${ctx.turn.messages.length} messages`)
    })
  },
}

agent.use(loggingExtension)
```

### Built-in extensions (`libra/extras`)

Libra ships with a set of optional extensions under `libra/extras`. Each is importable via its own subpath — import only what you need:

```typescript
import { createLoggerExtension } from 'libra/extras/logger'
import { createSessionExtension } from 'libra/extras/session'

agent.use(createLoggerExtension())
agent.use(createSessionExtension())
```

| Extension | Import | Priority | Description |
|-----------|--------|----------|-------------|
| logger | `libra/extras/logger` | 100 | Logs each lifecycle stage |
| streaming | `libra/extras/streaming` | 100 | Streams text/reasoning/tool-input deltas |
| weather-tool | `libra/extras/weather-tool` | 50 | Registers a `get_weather` tool |
| structured-output | `libra/extras/structured-output` | 50 | Validates LLM output against a JSON schema |
| mcp | `libra/extras/mcp` | 50 | Connects to MCP servers, registers tools |
| skills | `libra/extras/skills` | 50 | Loads Agent Skills from directories |
| emoji | `libra/extras/emoji` | 0 | Decorates responses with an emoji prefix |
| timestamp | `libra/extras/timestamp` | 0 | Records start/finish timestamps in metadata |
| session | `libra/extras/session` | -100 | In-memory session history per session ID |

**Priority** controls hook execution order within each lifecycle stage (higher = runs first, ties keep registration order). This applies to `agent.use()` directly — not just the loader — so explicit `use()` calls also respect `Extension.priority`.

See [`src/extras/README.md`](src/extras/README.md) for full API docs.

### Extension loader

For larger setups, `loadExtensions` accepts a mix of factory functions, `Extension` objects, and directory paths. It passes a shared config object to each factory, sorts by priority, and handles cleanup:

```typescript
import { loadExtensions, installExtensions, closeExtensions } from 'libra/extras'
import { createLoggerExtension } from 'libra/extras/logger'
import { createMcpExtension } from 'libra/extras/mcp'

const loaded = await loadExtensions(
  [
    createLoggerExtension,        // factory — config passed automatically
    createMcpExtension,           // factory — opts out if no mcpConfigPaths
    './extensions',               // directory — discovers extensions by extension.json
  ],
  { mcpConfigPaths: './mcpServers.json' },
)

installExtensions(loaded, agent)

// ... run turns ...

await closeExtensions(loaded)     // calls close() on extensions that have one (e.g. MCP)
```

### Examples

The `examples/` directory includes reference implementations:

- **`full-agent/`** — all built-in extensions via the loader, plus a local search-replace extension demonstrating directory-loaded extensions. Multi-turn session memory, MCP tools, skill loader, weather tool, streaming, and Gemini single-turn.
- **`basic-agent-concurrent/`** — single agent handling many concurrent users with rapid messages, session isolation, and per-turn halt
- **`subagents/`** — orchestrator agent delegating to specialized research, code, and critic subagents via `createAgentTool`, with signal chaining and halt propagation
- **`subagents-concurrent/`** — orchestrator fanning out to multiple subagents in parallel via `Promise.all`, with shared signal and halt propagation across all concurrent subagents
- **`structured-output/`** — `beforeResponse` hook that validates LLM output against a JSON schema, strips code fences, catches type errors, and supports retry patterns
- **`streaming/`** — `beforeLLM` hook that sets `onDelta` on the model request, streaming text/reasoning/tool-input deltas to callbacks in real time
- **`openai-compatible-provider/`** — exposes multiple independent Libra agents as authenticated OpenAI-compatible models for use by external frameworks

## Hook Lifecycle

```
beforeTurn → beforeContext → [beforeLLM → afterLLM → (beforeTool → afterTool)*]* → beforeResponse → afterTurn
```

`onError` fires when any error is thrown during the turn. An `onError` hook can observe the error or recover by returning `{ skip: true, value: AgentResponse }`.

| Hook | When | Can Mutate |
|---|---|---|
| `beforeTurn` | Turn starts | messages, tools, metadata |
| `beforeContext` | Before LLM loop | messages |
| `beforeLLM` | Before each model call | modelRequest; can short-circuit with `{ skip: true, value: ModelResponse }` |
| `afterLLM` | After each model response | modelResponse |
| `beforeTool` | Before each tool call | can short-circuit with `{ skip: true, value: ToolResult }` |
| `afterTool` | After each tool result | toolResult |
| `beforeResponse` | Before final response | turn.response |
| `afterTurn` | Turn completes | turn (observe/persist) |
| `onError` | Any error thrown | can recover with `{ skip: true, value: AgentResponse }` |

## Steering & Halting

Each `agent.run()` returns a `RunHandle` that is thenable and exposes `steer()` and `halt()`:

```typescript
const handle = agent.run({ message: 'Research this topic' })

// Redirect mid-turn
handle.steer('Focus on the financial aspects')

// Cancel mid-turn
handle.halt('user cancelled')

// Or just await
const result = await handle
```

Hooks can also steer/halt via `ctx.turn.steer()` and `ctx.turn.halt()` — these target only the current turn, even with concurrent turns running.

## Error Handling

```typescript
const fallbackExtension: Extension = {
  name: 'fallback',
  install(agent) {
    agent.hook('onError', 'fallback', async (ctx) => {
      if (ctx.error instanceof ModelError) {
        return {
          skip: true,
          value: {
            role: 'assistant',
            message: 'The model is temporarily unavailable.',
            finishReason: 'stop',
            iterations: 0,
            metadata: ctx.turn.metadata,
          },
        }
      }
    })
  },
}
```

## Multiple Agents

```typescript
const researchAgent = new Agent({ model, systemPrompt: 'You are a research agent.' })
const codingAgent = new Agent({ model, systemPrompt: 'You are a coding agent.' })

// Agents are fully independent — different tools, extensions, models
await researchAgent.run({ message: 'Research this customer' })
await codingAgent.run({ message: 'Write a function' })
```

## Agent-as-Tool

Use `createAgentTool` to wrap an agent as a tool for an outer agent. Signal and metadata are automatically chained — if the outer turn is halted, the inner agent is also halted.

```typescript
import { Agent, createAgentTool } from 'libra'

const researchAgent = new Agent({ model, systemPrompt: 'You are a research agent.' })

const outerAgent = new Agent({
  model: outerModel,
  tools: [
    createAgentTool(researchAgent, {
      name: 'research',
      description: 'Delegate a research question to a research agent',
    }),
  ],
})

const result = await outerAgent.run({ message: 'Research this topic' })
```

You can also wrap an agent manually if you need custom logic:

```typescript
const tool = {
  name: 'research',
  description: 'Delegate a research question',
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
  async execute(args, ctx) {
    const res = await researchAgent.run({
      message: String(args.query),
      signal: ctx.signal,      // chain abort
      metadata: ctx.metadata,  // share metadata
    })
    return { toolCallId: '', content: res.message }
  },
}
```

## Model Providers

Libra uses the Vercel AI SDK for model access. The built-in `AISdkModel` wraps any AI SDK provider:

```typescript
import { AISdkModel } from 'libra'
import { openai } from '@ai-sdk/openai'
import { google } from '@ai-sdk/google'
import { anthropic } from '@ai-sdk/anthropic'
import { deepseek } from '@ai-sdk/deepseek'

// Any provider works
const model = new AISdkModel(openai('gpt-4o'))
const model = new AISdkModel(google('gemini-2.0-flash'))
const model = new AISdkModel(anthropic('claude-sonnet-4-20250514'))
```

You can also implement the `Model` interface directly for custom providers:

```typescript
import type { Model, ModelRequest, ModelResponse } from 'libra'

class MyModel implements Model {
  async generate(request: ModelRequest): Promise<ModelResponse> {
    // translate to your API, call it, translate back
  }
}
```

## Streaming & Thinking Deltas

Libra supports streaming model output via an optional `onDelta` callback on `ModelRequest`. When set, `AISdkModel` uses its streaming path and emits text, reasoning, and tool-input deltas in real time. The final assembled `ModelResponse` is still returned.

Extensions enable streaming by setting `onDelta` on `ctx.modelRequest` in a `beforeLLM` hook:

```typescript
import type { Extension, ModelDelta } from 'libra'

const streamingExtension: Extension = {
  name: 'streaming',
  install(agent) {
    agent.hook('beforeLLM', 'streaming', async (ctx) => {
      if (!ctx.modelRequest) return
      ctx.modelRequest.onDelta = (delta: ModelDelta) => {
        if (delta.type === 'text') {
          process.stdout.write(delta.content)
        } else if (delta.type === 'reasoning') {
          console.log('[thinking]', delta.content)
        }
      }
    })
  },
}

agent.use(streamingExtension)
```

When `onDelta` is not set, `AISdkModel` uses `doGenerate` (no streaming overhead). The core never interprets deltas — it simply passes the callback through.

## Architecture

- **Library-first** — no server, daemon, database, or queue required
- **Hookable** — 9 lifecycle hooks with observation and mutation
- **Extensible** — extensions register hooks/tools without core conditional logic
- **Composable** — multiple independent agents, agent-as-tool, all in-process
- **Provider-independent** — `Model` interface with `AISdkModel` for Vercel AI SDK
- **Steerable & haltable** — per-turn controls via `RunHandle` or `ctx.turn`
- **Streamable** — text, reasoning, and tool-input deltas via `onDelta` callback
- **Testable** — 80 tests with mock model, 95% line coverage

### What the core owns

Agent configuration, model interaction, messages, tools, turn execution, hooks, errors.

### What the core does NOT own

Sessions, memory, databases, MCP, HTTP servers, auth, logging, metrics, scheduling — all of these are extensions or host-application concerns.

## License

MIT
