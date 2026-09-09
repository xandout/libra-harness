# libra

A small, composable, hookable agent harness. Library-first.

The core agent system is responsible for the actual LLM interaction. Everything else is an extension.

## Install

```bash
pnpm add @xandout/libra-harness
```

## Quick Start

```typescript
import { Agent } from '@xandout/libra-harness'
import { resolveModel } from '@xandout/libra-harness/models'

// Resolve a model from environment variables (DEEPSEEK_API_KEY, OPENAI_API_KEY, etc.)
const model = await resolveModel('deepseek/deepseek-v4-flash')

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

### External tools

Set `external: true` on a tool to return its call to the caller instead of executing it internally. This enables the standard OpenAI tool-calling round-trip: the agent returns `finishReason: 'tool_calls'` with `pendingToolCalls`, the caller executes the tool and sends the result back as a `tool` message in a follow-up request.

```typescript
const agent = new Agent({
  model,
  tools: [
    {
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      external: true,
      async execute() { return { toolCallId: '', content: '' } }, // never called
    },
  ],
})

const result = await agent.run({ message: 'Weather in SF?' })
// result.finishReason === 'tool_calls'
// result.pendingToolCalls === [{ id: '...', name: 'get_weather', arguments: '{"city":"SF"}' }]

// Caller executes the tool, then resumes:
const result2 = await agent.run({
  message: 'Weather in SF?',
  metadata: {
    myMessages: [
      { role: 'user', content: 'Weather in SF?' },
      { role: 'assistant', content: '', toolCalls: result.pendingToolCalls },
      { role: 'tool', content: 'Sunny, 72F', toolCallId: '...', name: 'get_weather' },
    ],
  },
})
// result2.finishReason === 'stop'
```

## Multimodal Messages

Libra supports text, images, documents, audio, and video in message content:

```typescript
const result = await agent.run({
  message: [
    { type: 'text', text: 'Describe this image' },
    { type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'https://example.com/photo.png' } },
  ],
})
```

File content can be a URL, base64 data, or text:

```typescript
// URL
{ type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'https://...' } }

// Base64
{ type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: '/9j/4AAQ...' } }
```

## Extensions

Extensions add behavior without requiring the core to understand it.

```typescript
import type { Extension } from '@xandout/libra-harness'

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

### Built-in extensions

Libra ships the extensions used by `libra-code` as explicit subpath exports:

```typescript
import { createDiskSessionExtension } from '@xandout/libra-harness/extensions/disk-session'
import { createCodeToolsExtension } from '@xandout/libra-harness/extensions/code-tools'
import { createStreamingExtension } from '@xandout/libra-harness/extensions/streaming'
import { createSkillExtension } from '@xandout/libra-harness/extensions/skills'
```

| Extension | Description |
|-----------|-------------|
| disk-session | Disk-backed session history per session ID |
| code-tools | Coding, filesystem, shell, and task tools |
| streaming | Text, reasoning, and tool-input delta callbacks |
| skills | Agent Skill discovery and loading |

**Priority** controls hook execution order within each lifecycle stage (higher = runs first, ties keep registration order).

## Model Providers

### Native resolver

The easiest way to get a model is `resolveModel` from `@xandout/libra-harness/models`. It reads API keys from environment variables and loads the appropriate AI SDK provider package dynamically:

```typescript
import { resolveModel } from '@xandout/libra-harness/models'

// Reads DEEPSEEK_API_KEY from env, loads @ai-sdk/deepseek
const model = await resolveModel('deepseek/deepseek-v4-flash')

// Reads OPENAI_API_KEY from env, loads @ai-sdk/openai
const model = await resolveModel('openai/gpt-4.1-mini')

// Reads ANTHROPIC_API_KEY from env, loads @ai-sdk/anthropic
const model = await resolveModel('anthropic/claude-sonnet-4-20250514')

// Reads GOOGLE_GENERATIVE_AI_API_KEY from env, loads @ai-sdk/google
const model = await resolveModel('google/gemini-2.0-flash')
```

Model IDs use the format `provider/model`. Supported providers:

| Provider | Environment variable | Package |
|----------|---------------------|---------|
| `openai` | `OPENAI_API_KEY` | `@ai-sdk/openai` |
| `anthropic` | `ANTHROPIC_API_KEY` | `@ai-sdk/anthropic` |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` | `@ai-sdk/google` |
| `deepseek` | `DEEPSEEK_API_KEY` | `@ai-sdk/deepseek` |

### Direct AISdkModel

You can also wrap any AI SDK `LanguageModelV4` directly:

```typescript
import { AISdkModel } from '@xandout/libra-harness'
import { openai } from '@ai-sdk/openai'

const model = new AISdkModel(openai('gpt-4.1-mini'))
```

### Routing model

Route requests to different models based on input content — e.g. send images to a vision model:

```typescript
import { createRoutingModel, hasImageInput } from '@xandout/libra-harness/models'

const model = createRoutingModel({
  default: await resolveModel('deepseek/deepseek-v4-flash'),
  routes: [
    { when: hasImageInput, model: await resolveModel('deepseek/deepseek-v4-flash-vision-exp') },
  ],
})
```

### Custom Model interface

Implement the `Model` interface directly for custom providers:

```typescript
import type { Model, ModelRequest, ModelResponse } from '@xandout/libra-harness'

class MyModel implements Model {
  async generate(request: ModelRequest): Promise<ModelResponse> {
    // translate to your API, call it, translate back
  }
}
```

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

The `errorPolicy` config controls what happens when no `onError` hook recovers:

| Policy | Behavior |
|--------|----------|
| `'fallback'` (default) | Returns a graceful response with `finishReason: 'error'` |
| `'throw'` | Rethrows the error |
| `function` | Custom recovery — return an `AgentResponse` or `undefined` to rethrow |

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
import { Agent, createAgentTool } from '@xandout/libra-harness'

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

## Streaming & Thinking Deltas

Libra supports streaming model output via an optional `onDelta` callback on `ModelRequest`. When set, `AISdkModel` uses its streaming path and emits text, reasoning, and tool-input deltas in real time. The final assembled `ModelResponse` is still returned.

Extensions enable streaming by setting `onDelta` on `ctx.modelRequest` in a `beforeLLM` hook:

```typescript
import type { Extension, ModelDelta } from '@xandout/libra-harness'

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
- **Provider-independent** — `Model` interface with AI SDK v4 integration and native resolver
- **Multimodal** — text, images, documents, audio, and video in message content
- **Steerable & haltable** — per-turn controls via `RunHandle` or `ctx.turn`
- **Streamable** — text, reasoning, and tool-input deltas via `onDelta` callback
- **Testable** — comprehensive tests with mock models

### What the core owns

Agent configuration, model interaction, messages, tools, turn execution, hooks, errors, streaming delta forwarding.

### What the core does NOT own

Sessions, memory, databases, MCP, HTTP servers, auth, logging, metrics, scheduling — all of these are extensions or host-application concerns.

## License

MIT
