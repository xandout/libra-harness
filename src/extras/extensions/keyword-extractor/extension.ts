import type { Extension } from '../../../extension.js';
import { messageContentToText } from '../../../types.js';
import type { QueryAnalyzer } from './nlp.js';
import { getQueryAnalyzer } from './nlp.js';

/**
 * Configuration for {@link createKeywordExtractorExtension}.
 */
export interface KeywordExtractorConfig {
  /**
   * The {@link QueryAnalyzer} to use. Defaults to the process-wide
   * shared winkNLP-backed analyzer. Pass a custom instance (e.g. a
   * test double) to control extraction behavior.
   */
  analyzer?: QueryAnalyzer;
  /**
   * Optional logger sink. Defaults to `console.log` with a
   * `[keywords]` prefix. Receives the extracted terms and the source
   * message for each user turn.
   */
  log?: (entry: KeywordExtractionEntry) => void;
}

/**
 * A single keyword-extraction record emitted on each user turn.
 */
export interface KeywordExtractionEntry {
  /** The user's message for this turn. */
  message: string;
  /** Extracted single-word search terms. */
  terms: string[];
  /** Extracted multi-word phrases (if any). */
  phrases: string[];
}

/**
 * Extension that extracts keywords from each user message and publishes
 * them into the turn's enrichment bag (`ctx.turn.metadata.sessionMeta`)
 * so downstream extensions — notably disk-session — can persist them
 * without knowing what a "keyword" is.
 *
 * Hooks `beforeTurn` so it sees the incoming user message before the
 * agent runs. It writes `sessionMeta.keywords = { terms, phrases }`,
 * merging with any existing bag contents (other extensions may write
 * their own keys). It also logs the extracted terms for observability.
 *
 * Must run before any extension that reads `sessionMeta` in `beforeTurn`
 * (e.g. disk-session). This is enforced via `priority: 50` (higher
 * than disk-session's -100), so `use()` call order doesn't matter.
 *
 * ```
 * User message → QueryAnalyzer → sessionMeta.keywords → session persists
 * ```
 *
 * The analyzer is initialized once and reused across all turns.
 */
export default function createKeywordExtractorExtension(
  config?: KeywordExtractorConfig,
): Extension {
  const analyzer = config?.analyzer ?? getQueryAnalyzer();
  const log =
    config?.log ??
    ((entry) => {
      const parts = [`[keywords] terms=[${entry.terms.join(', ')}]`];
      if (entry.phrases.length > 0) {
        parts.push(`phrases=[${entry.phrases.join(', ')}]`);
      }
      console.log(parts.join(' '));
    });

  return {
    name: 'keyword-extractor',
    // Higher than disk-session (-100) so our beforeTurn hook runs
    // first and sessionMeta.keywords is populated before disk-session
    // persists the user record. Priority makes this independent of
    // use() call order.
    priority: 50,
    install(agent) {
      agent.hook('beforeTurn', 'keyword-extractor', async (ctx) => {
        const message = messageContentToText(ctx.turn.request.message);
        const { terms, phrases } = analyzer.analyze(message);

        // Publish into the enrichment bag. Merge — don't overwrite —
        // so other extensions writing their own keys are preserved.
        const existing = (ctx.turn.metadata.sessionMeta ?? {}) as Record<
          string,
          unknown
        >;
        ctx.turn.metadata.sessionMeta = {
          ...existing,
          keywords: { terms, phrases: phrases ?? [] },
        };

        log({
          message,
          terms,
          phrases: phrases ?? [],
        });
      });
    },
  };
}
