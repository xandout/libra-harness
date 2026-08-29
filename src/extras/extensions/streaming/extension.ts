import type { Extension } from '../../../extension.js';
import type { ModelDelta } from '../../../model.js';

/**
 * Streaming extension — sets `onDelta` on the model request in
 * `beforeLLM` so the AISdkModel uses its streaming path.
 *
 * The caller passes callbacks via `metadata.streamCallbacks`:
 * - `onText(delta)` — text token deltas
 * - `onReasoning(delta)` — reasoning/thinking token deltas
 * - `onToolInput(delta, toolName)` — tool argument token deltas
 *
 * When no `streamCallbacks` are in metadata, the extension is a no-op
 * and the model uses `doGenerate` (no streaming overhead).
 */
export default function createStreamingExtension(): Extension {
  return {
    name: 'streaming',
    priority: 100,
    install(agent) {
      agent.hook('beforeLLM', 'streaming', async (ctx) => {
        if (!ctx.modelRequest) return;

        const callbacks = ctx.turn.metadata.streamCallbacks as {
          onText?: (delta: string) => void;
          onReasoning?: (delta: string) => void;
          onToolInput?: (delta: string, toolName: string) => void;
        } | undefined;

        if (!callbacks) return;

        ctx.modelRequest.onDelta = (delta: ModelDelta) => {
          switch (delta.type) {
            case 'text':
              callbacks.onText?.(delta.content);
              break;
            case 'reasoning':
              callbacks.onReasoning?.(delta.content);
              break;
            case 'tool-input':
              callbacks.onToolInput?.(delta.content, delta.toolName ?? '');
              break;
          }
        };
      });
    },
  };
}
