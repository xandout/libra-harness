import type { Extension } from 'libra';

/**
 * A detected PII entity — a real value and its type.
 * The placeholder is assigned by the redact function based on session state.
 */
interface PiiEntity {
  value: string;
  type: string;
}

/**
 * Per-session PII mapping: placeholder → real value.
 * Also maintains a reverse index: real value → placeholder.
 */
type PiiMapping = Map<string, string>;

/**
 * Log entry capturing what each side saw at each stage.
 */
export interface PiiLogEntry {
  stage: 'consumer-request' | 'model-input' | 'tool-result-raw' | 'tool-result-redacted' | 'model-output' | 'consumer-response';
  text: string;
  timestamp: number;
}

/**
 * Configuration for the PII swap extension.
 */
export interface PiiSwapConfig {
  /**
   * Detect PII entities in text. Return one entry per detected value.
   * The placeholder should be stable for the same value within a session.
   */
  detect: (text: string) => PiiEntity[];
  /**
   * Restore placeholders to real values in text.
   */
  restore: (text: string, mapping: PiiMapping) => string;
  /**
   * Extract a session key from turn metadata. Defaults to 'default'.
   */
  sessionKey?: (metadata: Record<string, unknown>) => string;
  /**
   * Optional log sink. If provided, every stage is logged here.
   */
  log?: (entry: PiiLogEntry) => void;
}

/**
 * Create a PII swap extension.
 *
 * This extension redacts PII from messages before the LLM sees them,
 * redacts PII from tool results, and restores placeholders to real
 * values in the final response. The LLM only ever sees placeholders;
 * the consumer only ever sees real values.
 *
 * Each session maintains its own mapping table so placeholders are
 * consistent across turns within a conversation.
 */
export function createPiiSwapExtension(config: PiiSwapConfig): Extension {
  const mappings = new Map<string, PiiMapping>();

  function getMapping(sessionKey: string): PiiMapping {
    let m = mappings.get(sessionKey);
    if (!m) {
      m = new Map();
      mappings.set(sessionKey, m);
    }
    return m;
  }

  // Per-session reverse index: real value → placeholder.
  const reverseMappings = new Map<string, Map<string, string>>();
  // Per-session type counters for assigning new placeholders.
  const typeCounters = new Map<string, Map<string, number>>();

  function getReverseMapping(sessionKey: string): Map<string, string> {
    let m = reverseMappings.get(sessionKey);
    if (!m) { m = new Map(); reverseMappings.set(sessionKey, m); }
    return m;
  }

  function getTypeCounters(sessionKey: string): Map<string, number> {
    let m = typeCounters.get(sessionKey);
    if (!m) { m = new Map(); typeCounters.set(sessionKey, m); }
    return m;
  }

  function redact(text: string, mapping: PiiMapping, sessionKey: string): string {
    const entities = config.detect(text);
    const reverse = getReverseMapping(sessionKey);
    const counters = getTypeCounters(sessionKey);
    let result = text;
    for (const { value, type } of entities) {
      // Check if we already have a placeholder for this value.
      let placeholder = reverse.get(value);
      if (!placeholder) {
        // Assign a new placeholder.
        const idx = (counters.get(type) ?? 0) + 1;
        counters.set(type, idx);
        placeholder = `[${type}_${String(idx).padStart(3, '0')}]`;
        mapping.set(placeholder, value);
        reverse.set(value, placeholder);
      }
      // Replace all occurrences of the real value with the placeholder.
      result = result.split(value).join(placeholder);
    }
    return result;
  }

  function log(stage: PiiLogEntry['stage'], text: string) {
    config.log?.({ stage, text, timestamp: Date.now() });
  }

  return {
    name: 'pii-swap',
    priority: 100, // run before other extensions see the message
    install(agent) {
      // Redact PII from all messages the LLM will see.
      agent.hook('beforeLLM', 'pii-swap', async (ctx) => {
        const sessionKey = config.sessionKey?.(ctx.turn.metadata) ?? 'default';
        const mapping = getMapping(sessionKey);
        const modelRequest = ctx.modelRequest;
        if (!modelRequest) return;
        for (const message of modelRequest.messages) {
          if (typeof message.content === 'string') {
            message.content = redact(message.content, mapping, sessionKey);
          }
        }
        // Log what the model is about to see.
        const lastMessage = modelRequest.messages.at(-1);
        log('model-input', JSON.stringify(lastMessage));
      });

      // Restore placeholders in tool call arguments before the tool executes.
      // The LLM sees placeholders, so it calls tools with placeholders.
      // The tool needs real values to query the datasource.
      agent.hook('beforeTool', 'pii-swap', async (ctx) => {
        const sessionKey = config.sessionKey?.(ctx.turn.metadata) ?? 'default';
        const mapping = getMapping(sessionKey);
        const tc = ctx.toolCall;
        if (tc?.arguments) {
          tc.arguments = config.restore(tc.arguments, mapping);
        }
      });

      // Redact PII from tool results before they enter the conversation.
      agent.hook('afterTool', 'pii-swap', async (ctx) => {
        const sessionKey = config.sessionKey?.(ctx.turn.metadata) ?? 'default';
        const mapping = getMapping(sessionKey);
        const result = ctx.toolResult;
        if (!result) return;
        log('tool-result-raw', result.content);
        if (typeof result.content === 'string') {
          result.content = redact(result.content, mapping, sessionKey);
        }
        log('tool-result-redacted', result.content);
      });

      // Restore placeholders to real values in the final response.
      agent.hook('beforeResponse', 'pii-swap', async (ctx) => {
        const sessionKey = config.sessionKey?.(ctx.turn.metadata) ?? 'default';
        const mapping = getMapping(sessionKey);
        if (ctx.turn.response) {
          log('model-output', ctx.turn.response.message);
          ctx.turn.response.message = config.restore(ctx.turn.response.message, mapping);
          log('consumer-response', ctx.turn.response.message);
        }
      });
    },
  };
}

// ─── PII Detection Helpers ──────────────────────────────────────

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /\+1-\d{3}-\d{4}/g;
const SSN_RE = /\d{3}-\d{2}-\d{4}/g;
const ACCOUNT_RE = /ACC-\d{8}/g;

/**
 * Create a PII detector that uses regex patterns plus a known-names list.
 * The known-names list is derived from the CSV datasource so we can
 * detect person names that regex alone can't catch.
 */
export function createPiiDetector(knownNames: string[]): (text: string) => PiiEntity[] {
  // Sort names by length descending so longer names are matched first
  // (e.g. "John Smith" before "John").
  const sortedNames = [...knownNames].sort((a, b) => b.length - a.length);

  return (text: string): PiiEntity[] => {
    const entities: PiiEntity[] = [];
    const seen = new Set<string>();

    // Known names from the CSV
    for (const name of sortedNames) {
      if (text.includes(name) && !seen.has(name)) {
        entities.push({ value: name, type: 'PERSON' });
        seen.add(name);
      }
    }

    // Emails
    for (const match of text.matchAll(EMAIL_RE)) {
      const value = match[0];
      if (!seen.has(value)) {
        entities.push({ value, type: 'EMAIL' });
        seen.add(value);
      }
    }

    // Phone numbers
    for (const match of text.matchAll(PHONE_RE)) {
      const value = match[0];
      if (!seen.has(value)) {
        entities.push({ value, type: 'PHONE' });
        seen.add(value);
      }
    }

    // SSNs
    for (const match of text.matchAll(SSN_RE)) {
      const value = match[0];
      if (!seen.has(value)) {
        entities.push({ value, type: 'SSN' });
        seen.add(value);
      }
    }

    // Account IDs
    for (const match of text.matchAll(ACCOUNT_RE)) {
      const value = match[0];
      if (!seen.has(value)) {
        entities.push({ value, type: 'ACCOUNT' });
        seen.add(value);
      }
    }

    return entities;
  };
}

/**
 * Restore placeholders to real values using the session mapping.
 */
export function restorePlaceholders(text: string, mapping: PiiMapping): string {
  let result = text;
  for (const [placeholder, realValue] of mapping) {
    result = result.split(placeholder).join(realValue);
  }
  return result;
}
