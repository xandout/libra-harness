# libra/extras

Optional extensions and the extension loader that ships with libra.

The core agent (`libra`) is intentionally minimal — it owns the turn loop, hooks, tools, and model interaction. Everything else (logging, sessions, MCP, skills, streaming, structured output) lives here as opt-in extensions.

## Installation

These extensions are bundled with `libra` — no separate install. They're published as subpath exports so you only import what you need.

## Usage

### Direct import (simplest)

Each extension is a factory function exported from its own subpath:

```typescript
import { createLoggerExtension } from '@xandout/libra-harness/extras/logger';
import { createSessionExtension } from '@xandout/libra-harness/extras/session';

const logger = createLoggerExtension();
const session = createSessionExtension();

agent.use(logger);
agent.use(session);
```

> **Note:** Factory functions that do async work (e.g. `createMcpExtension`) can throw on init — bad config, network failure, server down. When calling factories directly, wrap them in try/catch so one broken extension doesn't crash your app. The extension loader (`loadExtensions`) handles this automatically — it catches per-extension errors and continues.
>
> ```typescript
> let mcp;
> try {
>   mcp = await createMcpExtension({ mcpConfigPaths: './mcpServers.json' });
> } catch (err) {
>   console.error('MCP init failed, running without it:', err);
> }
> if (mcp) agent.use(mcp);
> ```

### Extension loader (config, priority sorting, cleanup)

For larger setups, `loadExtensions` accepts a mix of factory functions, ready-made `Extension` objects, and directory paths. It calls each factory with a shared config object, sorts everything by priority, and returns `LoadedExtension[]` ready for `installExtensions`.

> **Priority** controls both the order the loader calls `installExtensions` *and* the order hooks execute within each lifecycle stage (higher = runs first, ties keep registration order). This applies to `agent.use()` directly — not just the loader — so explicit `use()` calls also respect `Extension.priority`.

```typescript
import { loadExtensions, installExtensions, closeExtensions } from '@xandout/libra-harness/extras';
import { createLoggerExtension } from '@xandout/libra-harness/extras/logger';
import { createMcpExtension } from '@xandout/libra-harness/extras/mcp';
import { createSkillExtension } from '@xandout/libra-harness/extras/skills';

const loaded = await loadExtensions(
  [
    // Factory functions — config is passed to each
    createLoggerExtension,
    createMcpExtension,
    createSkillExtension,
    // Directory path — discovers extensions by scanning for extension.json
    './extensions',
  ],
  {
    mcpConfigPaths: './mcpServers.json',
    skillsDirs: './skills',
  },
);

installExtensions(loaded, agent);

// ... run turns ...

await closeExtensions(loaded); // calls close() on extensions that have one (e.g. MCP)
```

### Directory-only (convention-based)

You can also load all built-in extensions from the shared directory without importing each factory:

```typescript
import { loadExtensions, sharedExtensionsDir } from '@xandout/libra-harness/extras';

const loaded = await loadExtensions(
  [sharedExtensionsDir, './extensions'],
  { mcpConfigPaths: './mcpServers.json', skillsDirs: './skills' },
);
```

## Available extensions

| Extension | Import path | Priority | Config keys | Description |
|-----------|-------------|----------|-------------|-------------|
| **logger** | `libra/extras/logger` | 100 | `logFunction`, `errorFunction`, `logPrefix` | Logs each lifecycle stage (beforeTurn, beforeLLM, afterLLM, beforeTool, afterTool, onError, afterTurn). Observes without mutating. |
| **streaming** | `libra/extras/streaming` | 100 | — | Sets `onDelta` on the model request in `beforeLLM` when `metadata.streamCallbacks` is present. Enables text, reasoning, and tool-input delta streaming. No-op when callbacks absent. |
| **weather-tool** | `libra/extras/weather-tool` | 50 | `fetchWeather` | Registers a `get_weather` tool. Default returns fake data; pass a `fetchWeather` function for real API integration. |
| **structured-output** | `libra/extras/structured-output` | 50 | `schema`, `metadataKey`, `stripCodeFences` | Validates LLM output against a JSON schema in `beforeResponse`. Strips code fences, catches type errors, stores parsed result in metadata. Opts out (returns undefined) if no schema in config. |
| **mcp** | `libra/extras/mcp` | 50 | `mcpConfigPaths`, `excludeTools` | Connects to MCP servers (stdio/HTTP/SSE), discovers tools, resources, and prompts, and registers them on the agent. Tools are namespaced as `serverName__toolName`. `excludeTools` filters tools by regex before registration. Has a `close()` method for cleanup. Requires `@modelcontextprotocol/client` (optional peer dep). |
| **skills** | `libra/extras/skills` | 50 | `skillsDirs`, `preloadSkills` | Loads Agent Skills from directories (SKILL.md frontmatter + optional scripts). Registers `list_skills`, `use_skill`, `read_skill_file`, `run_skill_script` tools. Progressive disclosure: metadata at startup, full content on demand. Skills with `autoLoad: true` in frontmatter are appended to the system prompt at install time. |
| **auto-steer** | `libra/extras/auto-steer` | 90 | `maxIterations`, `threshold`, `steerMessage` | Steers the agent to wrap up when approaching max iterations, preventing empty max_iterations responses. Counts `afterLLM` calls per turn and injects a steering message `threshold` iterations before the limit. |
| **emoji** | `libra/extras/emoji` | 0 | `emojiPrefix` | Decorates the final response with a leading emoji (default: `✨ `). |
| **timestamp** | `libra/extras/timestamp` | 0 | — | Records `metadata.startedAt` and `metadata.finishedAt` ISO timestamps. |
| **session** | `libra/extras/session` | -100 | — | In-memory session storage keyed by `metadata.sessionId`. Loads history in `beforeTurn`, saves in `afterTurn`. Exposes `getMessages()`, `clear()`, `clearAll()` on the extension object. |

## Extension interface

Every extension implements the `Extension` interface from the core:

```typescript
interface Extension {
  name: string;
  install(agent: Agent): void;
  priority?: number;   // controls hook execution order (higher = runs first)
  close?(): Promise<void>;  // optional cleanup
}
```

The built-in extensions are factory functions that return an `Extension` (or `undefined` to opt out when required config is missing):

```typescript
export default function createLoggerExtension(config?: LoggingExtensionConfig): Extension {
  return {
    name: 'logging',
    priority: 100,
    install(agent) {
      agent.hook('beforeLLM', 'logging', async (ctx) => { ... });
    },
  };
}
```

## Extension loader API

### `loadExtensions(inputs, config?)`

Loads extensions from a mix of sources. Returns `LoadedExtension[]` sorted by priority (descending), then name (ascending).

**Parameters:**
- `inputs`: `string | ExtensionFactory | Extension | (string | ExtensionFactory | Extension)[]`
  - `string` — directory path to scan for extension subdirectories
  - `ExtensionFactory` — factory function called with `config`
  - `Extension` — ready-to-install object
- `config`: `Record<string, unknown>` — passed to every factory; each extracts the keys it needs

**Returns:** `Promise<LoadedExtension[]>`

### `installExtensions(loaded, agent)`

Installs loaded extensions onto an agent in priority order.

### `closeExtensions(loaded)`

Calls `close()` on extensions that have one (e.g. MCP clients), in reverse priority order.

### `unloadExtensions(loaded, agent)`

Unloads extensions from an agent in reverse priority order. Calls `agent.unload(name)` for each.

### `sharedExtensionsDir`

Absolute path to the bundled extensions directory. Use for directory-only loading.

## Directory-loaded extensions

Extensions can also be discovered from directories. Each subdirectory should contain:

- `extension.json` — manifest with `name`, `description`, `priority`, `enabled`, `configKeys`
- `extension.ts` (or `.js`, `index.ts`, `index.js`) — entry point with a default export

The default export can be either:
- An `Extension` object — installed directly, config ignored
- A factory function `(config) => Extension | undefined` — called with config, may opt out

Example directory structure:

```
extensions/
  search-replace/
    extension.json    # { "name": "search-replace", "priority": 50, "configKeys": ["allowRegex"] }
    extension.ts      # export default function createSearchReplaceExtension(config) { ... }
```

## Peer dependencies

- `@modelcontextprotocol/client` — required only if using the `mcp` extension (optional peer dep)
- `ai` (Vercel AI SDK) — required only if using `AISdkModel` (optional peer dep of core)
