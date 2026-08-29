import type { Extension } from '../../../extension.js';

export interface StructuredOutputConfig {
  /** JSON schema to validate against. Required. */
  schema: Record<string, unknown>;
  /** Field name in metadata to store the parsed JSON. Default: "structured". */
  metadataKey?: string;
  /** Whether to strip markdown code fences from the response. Default: true. */
  stripCodeFences?: boolean;
}

export default function createStructuredOutputExtension(
  config: StructuredOutputConfig,
): Extension | undefined {
  if (!config?.schema) {
    console.log('[structured-output] no schema in config — skipping');
    return undefined;
  }
  const { schema } = config;
  const metadataKey = config.metadataKey ?? 'structured';
  const stripCodeFences = config.stripCodeFences ?? true;

  return {
    name: 'structured-output',
    priority: 50,
    install(agent) {
      agent.hook('beforeResponse', 'structured-output', async (ctx) => {
        if (!ctx.turn.response) return;

        let raw = ctx.turn.response.message;

        // Strip markdown code fences if present (LLMs often wrap JSON in ```json ... ```).
        if (stripCodeFences) {
          const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
          if (fenceMatch) {
            raw = fenceMatch[1].trim();
          }
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // Not valid JSON — replace the response with an error that includes the schema.
          ctx.turn.response = {
            ...ctx.turn.response,
            message: JSON.stringify({
              error: 'Response is not valid JSON',
              expectedSchema: schema,
              rawResponse: ctx.turn.response.message.slice(0, 500),
            }),
          };
          return;
        }

        // Validate against the schema's required fields.
        const required = (schema.required as string[]) ?? [];
        const missing = required.filter((field) => {
          const value = (parsed as Record<string, unknown>)[field];
          return value === undefined || value === null;
        });

        if (missing.length > 0) {
          ctx.turn.response = {
            ...ctx.turn.response,
            message: JSON.stringify({
              error: `Missing required fields: ${missing.join(', ')}`,
              expectedSchema: schema,
              received: Object.keys(parsed as object),
            }),
          };
          return;
        }

        // Type-check each field against the schema.
        const properties = (schema.properties as Record<string, { type: string }>) ?? {};
        const typeErrors: string[] = [];

        for (const [field, spec] of Object.entries(properties)) {
          const value = (parsed as Record<string, unknown>)[field];
          if (value === undefined) continue;

          const expectedType = spec.type;
          let actualType: string;

          if (Array.isArray(value)) {
            actualType = 'array';
          } else if (typeof value === 'number' && Number.isInteger(value)) {
            actualType = 'number';
          } else {
            actualType = typeof value;
          }

          if (actualType !== expectedType) {
            typeErrors.push(
              `Field "${field}" expected ${expectedType}, got ${actualType}`,
            );
          }
        }

        if (typeErrors.length > 0) {
          ctx.turn.response = {
            ...ctx.turn.response,
            message: JSON.stringify({
              error: 'Type validation failed',
              errors: typeErrors,
              expectedSchema: schema,
            }),
          };
          return;
        }

        // Valid — store the parsed object in metadata and clean up the response.
        ctx.turn.metadata[metadataKey] = parsed;
        // Keep the response as the raw JSON string so callers can parse it.
        // Or optionally replace with a formatted version.
        ctx.turn.response = {
          ...ctx.turn.response,
          message: JSON.stringify(parsed, null, 2),
        };
      });
    },
  };
}
