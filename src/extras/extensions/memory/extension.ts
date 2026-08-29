import type { Extension } from '../../../extension.js';
import { messageContentToText } from '../../../types.js';
import type {
  MemoryExtensionConfig,
  MemoryRetriever,
  Memory,
  ExtractedMemory,
} from './types.js';

/**
 * Memory extension — persistent, session-scoped knowledge across turns.
 *
 * The agent does not manage memory explicitly. Memories are:
 * - **Retrieved** automatically in `beforeContext` and injected as a
 *   system message before the LLM loop.
 * - **Extracted** automatically in `afterTurn` and persisted to the store.
 *
 * Both paths are non-fatal: retrieval or extraction failures are logged
 * and the turn proceeds normally. Memory is convenience infrastructure,
 * not a correctness requirement.
 *
 * ## Hook footprint
 *
 * Only two hooks:
 * - `beforeContext` — retrieve and inject memories
 * - `afterTurn` — extract and persist memories
 *
 * This avoids conflicts with session extensions (which use `beforeTurn`)
 * and observability extensions (which use `afterLLM`/`afterTurn`).
 *
 * ## Ordering
 *
 * Priority defaults to -95 (between session at -100 and mutators at 0).
 * In `beforeContext`, the memory system message is unshifted to index 0,
 * ahead of session history loaded in `beforeTurn`:
 *
 * ```
 * [memory system msg] [session history...] [user message]
 * ```
 *
 * In `afterTurn`, memory reads the final `turn.messages` and
 * `turn.response` — both are set by the core before `afterTurn` fires.
 *
 * @example
 * ```typescript
 * const store = new MyVectorStore();
 * const extractor = createLlmExtractor(model);
 * const memoryExt = createMemoryExtension({ store, extractor });
 *
 * const agent = new Agent({ model });
 * agent.use(memoryExt);
 *
 * await agent.run({
 *   message: "My name is Kristi",
 *   metadata: { sessionId: 'slack_C123' },
 * });
 * // Next turn in the same session: the agent remembers "Kristi".
 * ```
 */
export default function createMemoryExtension(
  config: MemoryExtensionConfig,
): Extension {
  const {
    store,
    extractor,
    maxRecall = 10,
    scopeKey = 'sessionId',
    priority = -95,
  } = config;

  // Default retriever: pass-through to store.search.
  const retriever: MemoryRetriever =
    config.retriever ?? {
      async retrieve({ scope, text }) {
        return store.search({ scope, text, maxResults: maxRecall });
      },
    };

  return {
    name: 'memory',
    priority,
    install(agent) {
      // ── beforeContext: retrieve and inject ────────────────────
      agent.hook('beforeContext', 'memory', async (ctx) => {
        const scope =
          (ctx.turn.request.metadata?.[scopeKey] as string) ?? 'default';
        const text = messageContentToText(ctx.turn.request.message);

        let memories: Memory[];
        try {
          memories = await retriever.retrieve({ scope, text, store });
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
        const scope =
          (ctx.turn.request.metadata?.[scopeKey] as string) ?? 'default';

        // Load existing memories so the extractor can dedup/update/delete.
        let existing: Memory[];
        try {
          existing = await store.listByScope(scope);
        } catch (err) {
          console.error('[memory] failed to load existing memories:', err);
          return; // skip extraction — can't dedup without existing context
        }

 let extractions: ExtractedMemory[];
        try {
          const result = await extractor.extract({
            scope,
            messages: ctx.turn.messages,
            response: ctx.turn.response!,
            existingMemories: existing,
          });
          // Guard against malformed extractor output — a non-array
          // would throw during iteration, escaping the try/catch.
          extractions = Array.isArray(result) ? result : [];
        } catch (err) {
          console.error('[memory] extraction failed:', err);
          return;
        }

        // Apply each operation. Individual failures are logged and
        // skipped — partial persistence is acceptable.
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
