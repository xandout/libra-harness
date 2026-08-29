# Memory Extension Spec

## Status

Design — not yet implemented.

## Summary

A memory extension that gives an agent persistent, session-scoped knowledge
across turns. The agent does not manage memory explicitly — memories are
retrieved automatically before each turn and extracted automatically after
each turn, entirely through hooks.

The extension defines three interfaces (`MemoryStore`, `MemoryExtractor`,
`MemoryRetriever`) and wires them into two hook stages. No core changes are
required. The storage backend, retrieval strategy, and extraction strategy
are all pluggable.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Write path | Automatic extraction (`afterTurn`) | Agent never thinks about memory; nothing is missed because the agent forgot to save |
| Read path | Automatic injection (`beforeContext`) | Agent always has relevant context; no "forgot to search" failure mode |
| Storage | Interface only | Hosts choose their own backend (vector DB, SQLite, Postgres, etc.) |
| Scoping | Session-scoped | Memories are tied to the same `sessionId` that session extensions use — no cross-conversation leakage |

## Hook Participation

Only two hooks. The extension is deliberately minimal in its hook footprint.

```
beforeTurn         — not used (session extensions own this)
beforeContext      — RETRIEVE: search store, inject as system message
beforeLLM          — not used
afterLLM           — not used
beforeTool         — not used
afterTool          — not used
beforeResponse     — not used
afterTurn          — EXTRACT: run extractor, persist results
onError            — not used (memory failures are internal — see Error Handling)
```

### Read path: `beforeContext`

```
beforeContext hook fires
    │
    ├── 1. Read sessionId from turn.request.metadata
    ├── 2. Build a query from the user's message (turn.request.message)
    ├── 3. Call retriever.search({ scope: sessionId, text: message })
    ├── 4. Format results as a system message
    └── 5. unshift into turn.messages
```

After this hook, the message array looks like:

```
[memory system msg] [session history...] [user message]
```

This ordering is correct because session extensions prepend history in
`beforeTurn` (which runs before `beforeContext`). The memory system message
lands at index 0, ahead of history.

**Why `beforeContext` and not `beforeTurn`?**

`beforeTurn` is for loading session state (conversation history). Memory
injection is context enrichment, not session loading. The AGENTS.md
lifecycle diagram already places memory retrieval at `beforeContext`:

```
beforeContext
    ↓
Retrieve relevant memory
    ↓
Modify context
```

Using `beforeContext` also avoids ordering conflicts with session extensions
that use `beforeTurn` — the two extensions never compete for the same stage.

### Write path: `afterTurn`

```
afterTurn hook fires
    │
    ├── 1. Read sessionId from turn.request.metadata
    ├── 2. Gather the full conversation (turn.messages + turn.response)
    ├── 3. Fetch existing memories for this scope (for dedup/update context)
    ├── 4. Call extractor.extract({ scope, messages, response, existingMemories })
    ├── 5. Apply returned operations (create / update / delete) to the store
    └── 6. Log any per-operation failures, continue
```

The extractor receives existing memories so it can:
- **Deduplicate** — don't create a memory that already exists
- **Update** — refine or correct a memory that this conversation contradicts
- **Delete** — remove a memory that is no longer accurate or relevant

Without existing-memory context, the store fills with redundant entries.

## Interfaces

### Memory

A discrete piece of knowledge extracted from a conversation.

```typescript
interface Memory {
  /** Unique identifier assigned by the store on creation. */
  id: string;
  /** Natural language text, 1-3 sentences, self-contained. */
  content: string;
  /** Session ID this memory belongs to. */
  scope: string;
  /** ISO timestamp — when the memory was first created. */
  createdAt: string;
  /** ISO timestamp — when the memory was last updated. */
  updatedAt: string;
  /** Optional metadata: tags, source, confidence, category, etc. */
  metadata?: Record<string, unknown>;
}
```

Memories are natural language, not structured records. Examples:

- "The user prefers dark mode in all UIs"
- "The user's name is Kristi; she is renovating a bathroom in the Smith job (#83)"
- "The user asked about dual-flush toilets and was sent a Project Source brand link"

### MemoryStore

Abstract storage backend. The extension depends on this interface; the host
provides a concrete implementation.

```typescript
interface MemoryStore {
  /** Create a new memory. Returns the stored memory with id/timestamps. */
  save(input: MemoryInput): Promise<Memory>;

  /** Get a single memory by ID. Returns null if not found. */
  get(id: string): Promise<Memory | null>;

  /** Search memories within a scope. Returns results ranked by relevance. */
  search(query: MemoryQuery): Promise<Memory[]>;

  /** Update a memory's content and/or metadata. */
  update(id: string, patch: MemoryPatch): Promise<Memory>;

  /** Delete a memory by ID. */
  delete(id: string): Promise<void>;

  /** List all memories for a scope (for extractor dedup context). */
  listByScope(scope: string): Promise<Memory[]>;

  /** Optional: prune memories according to a store-defined policy. */
  prune?(scope: string): Promise<number>;
}
```

```typescript
interface MemoryInput {
  content: string;
  scope: string;
  metadata?: Record<string, unknown>;
}

interface MemoryPatch {
  content?: string;
  metadata?: Record<string, unknown>;
}

interface MemoryQuery {
  /** Session ID to search within. */
  scope: string;
  /** Natural language search text (typically the user's message). */
  text: string;
  /** Maximum results to return. */
  maxResults?: number;
  /** Optional metadata filters (implementation-specific). */
  filter?: Record<string, unknown>;
}
```

The search ranking algorithm is implementation-specific. A vector DB would
use cosine similarity; a simple KV store might do keyword matching. The
interface contract is: given a scope and text, return the most relevant
memories, best first.

### MemoryExtractor

Decides what to remember from a completed turn.

```typescript
interface MemoryExtractor {
  extract(input: ExtractorInput): Promise<ExtractedMemory[]>;
}
```

```typescript
interface ExtractorInput {
  /** Session ID. */
  scope: string;
  /** The full conversation messages from this turn. */
  messages: Message[];
  /** The agent's final response. */
  response: AgentResponse;
  /** Existing memories for this scope (for dedup/update/delete decisions). */
  existingMemories: Memory[];
}

interface ExtractedMemory {
  /** The memory text (for create) or new text (for update). */
  content: string;
  /** What to do with this extraction. */
  action: 'create' | 'update' | 'delete';
  /** Required for update/delete — the existing memory ID to modify. */
  targetId?: string;
  /** Optional metadata to attach or merge. */
  metadata?: Record<string, unknown>;
}
```

The extractor returns a list of operations. The extension applies them
sequentially to the store. If the extractor returns an empty list, nothing
is persisted — the conversation had nothing worth remembering.

### MemoryRetriever

Formats and filters search results before injection. This is separated from
the store so retrieval logic (formatting, truncation, relevance thresholds)
can vary independently of storage.

```typescript
interface MemoryRetriever {
  retrieve(input: RetrievalInput): Promise<Memory[]>;
}
```

```typescript
interface RetrievalInput {
  /** Session ID. */
  scope: string;
  /** The user's message (search query). */
  text: string;
  /** The store to search against. */
  store: MemoryStore;
}
```

A default implementation could simply call `store.search` and return the
results. A more sophisticated retriever could:
- Combine keyword + semantic search
- Apply a relevance threshold (drop low-scoring memories)
- Rerank results
- Truncate total injected text to a token budget

## Extension Configuration

```typescript
interface MemoryExtensionConfig {
  /** Storage backend (required). */
  store: MemoryStore;
  /** Extraction strategy (required). */
  extractor: MemoryExtractor;
  /** Retrieval strategy (optional — defaults to pass-through to store.search). */
  retriever?: MemoryRetriever;
  /** Max memories to inject per turn (default: 10). */
  maxRecall?: number;
  /** Metadata key for session ID (default: 'sessionId'). */
  scopeKey?: string;
  /** Extension load priority (default: -95). */
  priority?: number;
}
```

## Extension Implementation (Reference)

```typescript
import type { Extension } from '../../extension.js';
import type { Message } from '../../types.js';

export default function createMemoryExtension(
  config: MemoryExtensionConfig,
): Extension {
  const {
    store,
    extractor,
    retriever,
    maxRecall = 10,
    scopeKey = 'sessionId',
    priority = -95,
  } = config;

  // Default retriever: pass-through to store.search.
  const resolve = retriever ?? {
    retrieve: async ({ scope, text }) =>
      store.search({ scope, text, maxResults: maxRecall }),
  };

  return {
    name: 'memory',
    priority,
    install(agent) {
      // ── beforeContext: retrieve and inject ────────────────────
      agent.hook('beforeContext', 'memory', async (ctx) => {
        const scope = (ctx.turn.request.metadata?.[scopeKey] as string) ?? 'default';
        const text = ctx.turn.request.message;

        let memories: Memory[];
        try {
          memories = await resolve.retrieve({ scope, text, store });
        } catch (err) {
          console.error('[memory] retrieval failed:', err);
          return; // proceed without memories
        }

        if (memories.length === 0) return;

        const memoryText = memories
          .map((m, i) => `${i + 1}. ${m.content}`)
          .join('\n');

        ctx.turn.messages.unshift({
          role: 'system',
          content: `Relevant memories from prior conversations:\n${memoryText}`,
        });
      });

      // ── afterTurn: extract and persist ─────────────────────────
      agent.hook('afterTurn', 'memory', async (ctx) => {
        const scope = (ctx.turn.request.metadata?.[scopeKey] as string) ?? 'default';

        let existing: Memory[];
        try {
          existing = await store.listByScope(scope);
        } catch (err) {
          console.error('[memory] failed to load existing memories:', err);
          return; // skip extraction — can't dedup
        }

        let extractions: ExtractedMemory[];
        try {
          extractions = await extractor.extract({
            scope,
            messages: ctx.turn.messages,
            response: ctx.turn.response!,
            existingMemories: existing,
          });
        } catch (err) {
          console.error('[memory] extraction failed:', err);
          return;
        }

        for (const ext of extractions) {
          try {
            if (ext.action === 'create') {
              await store.save({
                content: ext.content,
                scope,
                metadata: ext.metadata,
              });
            } else if (ext.action === 'update' && ext.targetId) {
              await store.update(ext.targetId, {
                content: ext.content,
                metadata: ext.metadata,
              });
            } else if (ext.action === 'delete' && ext.targetId) {
              await store.delete(ext.targetId);
            }
          } catch (err) {
            console.error(`[memory] failed to ${ext.action} memory:`, err);
          }
        }
      });
    },
  };
}
```

## Reference Extractor (LLM-based)

The recommended extractor is a lightweight LLM call with a focused system
prompt. It does not need to be a full `Agent` — a direct model call with
structured output is sufficient.

```typescript
import type { MemoryExtractor } from './types.js';

export function createLlmExtractor(model: Model): MemoryExtractor {
  return {
    async extract(input) {
      const conversationText = input.messages
        .filter((m) => m.role !== 'system')
        .map((m) => `[${m.role}] ${m.content}`)
        .join('\n');

      const existingText = input.existingMemories
        .map((m) => `ID: ${m.id} | ${m.content}`)
        .join('\n');

      const prompt = `You are a memory extraction system.
Analyze the following conversation and decide what memories to create, update, or delete.

Existing memories for this session:
${existingText || '(none)'}

Conversation:
${conversationText}

Return a JSON array of operations. Each operation has:
- "action": "create" | "update" | "delete"
- "content": the memory text (for create/update)
- "targetId": existing memory ID (required for update/delete)
- "metadata": optional object

Guidelines:
- Memories should be concise, self-contained facts (1-3 sentences).
- Deduplicate: if a new memory overlaps with an existing one, update it.
- Delete memories that are contradicted by the conversation.
- If nothing is worth remembering, return an empty array [].

Return only the JSON array, no other text.`;

      const response = await model.generate({
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: 'You are a memory extraction system. Return only JSON.',
      });

      try {
        return JSON.parse(response.message.content);
      } catch {
        return []; // malformed output — skip this turn
      }
    },
  };
}
```

## Ordering with Other Extensions

### Session extensions (mem-session, slack-session)

Session extensions use `beforeTurn` to load history. Memory uses
`beforeContext` to inject memories. Different stages — no conflict.

Message array after both hooks:

```
[memory system msg]    ← beforeContext (memory)
[session history...]   ← beforeTurn (session)
[user message]         ← original
```

Both extensions use `afterTurn`. Session saves the conversation; memory
extracts from it. Order doesn't matter — both read from `turn.messages`
which is final by `afterTurn`.

### Observability extensions

Observability extensions typically use `afterTurn` or `afterLLM`. Memory's
`afterTurn` hook is independent — it doesn't modify the response or
messages, only reads them and writes to the store.

### Emoji/timestamp extensions

These mutate the response in `beforeResponse` or `afterTurn`. Memory doesn't
touch the response, so there's no conflict.

## Error Handling

Memory is non-critical infrastructure. A memory failure should never crash
an agent turn or degrade the response.

| Failure point | Behavior |
|---------------|----------|
| `beforeContext` retrieval fails | Log error, proceed without memories. The turn runs normally, just without memory context. |
| `afterTurn` extraction fails | Log error, skip persistence. The turn response is already delivered to the user. |
| Individual store operation fails (create/update/delete) | Log error, continue to next operation. Partial persistence is acceptable. |
| Extractor returns malformed output | Treat as empty extraction, skip persistence. |

All errors are caught internally within the hook handlers. No errors
propagate to the core's `onError` hook or error policy. This is a deliberate
choice — memory is a convenience, not a correctness requirement.

## Scoping

Memories are scoped by session ID. The extension reads the scope from:

```typescript
const scope = ctx.turn.request.metadata?.[scopeKey] ?? 'default';
```

This is the same `sessionId` key that `mem-session` and `slack-session`
use. A memory created in session A is never retrieved in session B.

The `scopeKey` config option allows hosts to use a different metadata key
if their session extension uses a non-standard name.

## Forgetting / Decay

The `MemoryStore.prune` method is optional. If implemented, the host can
call it on a schedule (e.g., nightly) to clean up stale memories. Pruning
policies are store-specific:

- **TTL**: Delete memories older than N days
- **Access-based**: Delete memories not retrieved in N days
- **Capacity**: Keep only the N most relevant/recent memories per scope
- **Extractor-driven**: The extractor can issue `delete` operations for
  obsolete memories during normal `afterTurn` processing

The extension itself does not enforce any decay policy. It only applies
`delete` operations that the extractor explicitly returns.

## What This Spec Does NOT Include

- **Agent-driven memory tools** (`memory_save`, `memory_search`). The agent
  has no awareness of the memory system. This is by design — automatic
  extraction + injection keeps the agent focused on the task. If
  agent-driven memory is needed later, it can be added as a separate
  extension that registers tools, without modifying this one.

- **Cross-session memory.** Memories don't leak between sessions. A future
  "global memory" extension could share knowledge across sessions by using
  a different scope key or a separate store.

- **Memory versioning or audit log.** The store tracks `updatedAt` but does
  not keep history of prior content. A store implementation could add this.

- **Embedding generation.** The store interface accepts text and returns
  ranked results. How embeddings are generated, stored, and compared is an
  implementation detail.

- **A default store implementation.** The spec defines the interface only.
  Hosts provide their own backend.

## Test Plan

Tests should follow the pattern in `test/architecture.test.ts` — prove the
architecture, not just the implementation.

1. **Bare memory extension with mock store**: Verify memories are injected
   in `beforeContext` and extracted in `afterTurn`.
2. **Extractor receives existing memories**: Verify dedup context is passed.
3. **Extractor returns create/update/delete**: Verify all three operations
   are applied to the store.
4. **Retrieval failure is non-fatal**: Store throws on search → turn
   proceeds without memories, no error propagates.
5. **Extraction failure is non-fatal**: Extractor throws → turn response
   is unaffected.
6. **Session-scoped isolation**: Memories from session A are not retrieved
   in session B.
7. **Ordering with session extension**: Memory system message is at index 0,
   session history follows.
8. **Empty extraction**: Extractor returns `[]` → no store writes occur.
9. **Malformed extractor output**: Extractor returns invalid JSON → no
   store writes occur, no error propagates.
10. **Multiple agents with independent memory**: Two agents with separate
    stores don't interfere.
