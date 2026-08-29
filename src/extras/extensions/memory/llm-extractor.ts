import type { Model } from '../../../model.js';
import { messageContentToText } from '../../../types.js';
import type { MemoryExtractor, ExtractedMemory, ExtractorInput } from './types.js';

/**
 * Configuration for the LLM-based memory extractor.
 */
export interface LlmExtractorConfig {
  /**
   * System prompt for the extraction call. Override to customize what
   * the extractor considers memorable.
   */
  systemPrompt?: string;
  /**
   * Max tokens for the extraction response. Default: 2000.
   * Keep this modest — extraction output is a JSON array, not prose.
   */
  maxTokens?: number;
  /**
   * Temperature for the extraction call. Default: 0 (deterministic).
   */
  temperature?: number;
}

/**
 * Create an LLM-based memory extractor.
 *
 * This is the recommended extractor. It makes a single LLM call per turn
 * (in `afterTurn`) with a focused prompt that asks the model to decide
 * what to create, update, or delete from the conversation.
 *
 * It does not need to be a full `Agent` — a direct model call with
 * structured output is sufficient and far cheaper.
 *
 * The extractor is resilient to malformed output: if the model returns
 * invalid JSON, the extraction is treated as empty (nothing persisted).
 *
 * @example
 * ```typescript
 * const extractor = createLlmExtractor(model);
 * const memoryExt = createMemoryExtension({ store, extractor });
 * ```
 */
export function createLlmExtractor(
  model: Model,
  config?: LlmExtractorConfig,
): MemoryExtractor {
  const systemPrompt =
    config?.systemPrompt ??
    'You are a memory extraction system. Analyze conversations and decide what memories to create, update, or delete. Return only a JSON array.';
  const maxTokens = config?.maxTokens ?? 2000;
  const temperature = config?.temperature ?? 0;

  return {
    async extract(input: ExtractorInput): Promise<ExtractedMemory[]> {
      const conversationText = input.messages
        .filter((m) => m.role !== 'system')
        .map((m) => {
          if (m.role === 'assistant' && m.toolCalls?.length) {
            return `[assistant] ${messageContentToText(m.content)} (requested tools: ${m.toolCalls.map((t) => t.name).join(', ')})`;
          }
          return `[${m.role}] ${messageContentToText(m.content)}`;
        })
        .join('\n');

      const existingText =
        input.existingMemories.length > 0
          ? input.existingMemories
              .map((m) => `ID: ${m.id} | ${m.content}`)
              .join('\n')
          : '(none)';

      const prompt = `Analyze the following conversation and decide what memories to create, update, or delete.

Existing memories for this session:
${existingText}

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

      let response;
      try {
        response = await model.generate({
          messages: [{ role: 'user', content: prompt }],
          systemPrompt,
          maxTokens,
          temperature,
        });
      } catch {
        // Model call failed — skip extraction.
        return [];
      }

      try {
        const parsed = JSON.parse(messageContentToText(response.message.content));
        if (!Array.isArray(parsed)) return [];
        return parsed as ExtractedMemory[];
      } catch {
        // Malformed JSON — skip extraction.
        return [];
      }
    },
  };
}
