import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';
import type { PartOfSpeech } from 'wink-nlp';

/**
 * The result of analyzing a user message for search terms.
 */
export interface SearchTerms {
  /**
   * Ordered, de-duplicated single-word search terms extracted from the
   * input. Conversational filler, punctuation, and stop words are
   * removed. Capitalization is preserved for proper nouns / technical
   * terms (e.g. `TypeScript`, `AWS`, `MCP`); other terms are lowercased.
   */
  terms: string[];
  /**
   * Multi-word phrases (n-grams of length 2–3) built from consecutive
   * retained terms that were adjacent in the original text. Longer
   * phrases appear first. May be empty or undefined when no multi-word
   * phrases were found.
   */
  phrases?: string[];
}

/**
 * Analyzes conversational text and returns search terms.
 *
 * Implementations must be deterministic and safe to reuse across many
 * turns of a long-running agent process (the NLP model should be
 * initialized once, not per call).
 */
export interface QueryAnalyzer {
  analyze(input: string): SearchTerms;
}

/**
 * Part-of-speech tags worth retaining as search terms.
 *
 * Prioritizes nouns, proper nouns, and meaningful verbs/adjectives.
 * Stop words, punctuation, pronouns, determiners, conjunctions, etc.
 * are dropped (either via the stop-word flag or by not being in this
 * set).
 */
const RETAINED_POS: ReadonlySet<PartOfSpeech> = new Set([
  'NOUN',
  'PROPN',
  'VERB',
  'ADJ',
]);

/**
 * A retained token plus its original document index, used for phrase
 * (n-gram) extraction.
 */
interface RetainedToken {
  /** The term to surface (case-preserved for proper nouns, else lowercased). */
  term: string;
  /** Index of the token in the original document. */
  index: number;
}

/**
 * winkNLP-backed implementation of {@link QueryAnalyzer}.
 *
 * The winkNLP model is initialized exactly once (lazily on first use,
 * then reused). This is safe for a long-running agent process —
 * `analyze()` never re-instantiates the NLP engine.
 *
 * Extraction steps:
 *  1. Tokenize the input.
 *  2. Drop punctuation and non-word tokens.
 *  3. Drop English stop words.
 *  4. Keep tokens whose POS is a noun, proper noun, verb, or adjective.
 *  5. Preserve the original surface form for proper nouns (so
 *     `TypeScript`, `AWS`, `MCP`, `Kubernetes` keep their casing);
 *     lowercase everything else via winkNLP's `normal` form.
 *  6. De-duplicate while preserving first-occurrence order.
 *  7. Build 2–3 word phrases from consecutive retained tokens that were
 *     adjacent in the original text.
 */
export class WinkQueryAnalyzer implements QueryAnalyzer {
  private nlp: ReturnType<typeof winkNLP> | undefined;

  /** Lazily create the winkNLP engine exactly once. */
  private engine(): ReturnType<typeof winkNLP> {
    if (!this.nlp) {
      // `as any` because winkNLP's types declare the model shape as
      // `unknown` internally; the runtime model object is compatible.
      this.nlp = winkNLP(model as unknown as Parameters<typeof winkNLP>[0]);
    }
    return this.nlp;
  }

  analyze(input: string): SearchTerms {
    const trimmed = input?.trim() ?? '';
    if (trimmed === '') return { terms: [], phrases: [] };

    const nlp = this.engine();
    const doc = nlp.readDoc(trimmed);

    const values = doc.tokens().out() as string[];
    const types = doc.tokens().out(nlp.its.type) as string[];
    const pos = doc.tokens().out(nlp.its.pos) as PartOfSpeech[];
    const stop = doc.tokens().out(nlp.its.stopWordFlag) as boolean[];
    const normal = doc.tokens().out(nlp.its.normal) as string[];

    const retained: RetainedToken[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < values.length; i++) {
      // Drop punctuation and non-word tokens.
      if (types[i] !== 'word') continue;
      // Drop stop words.
      if (stop[i]) continue;
      // Keep only meaningful POS.
      if (!RETAINED_POS.has(pos[i])) continue;

      // Preserve casing for proper nouns (TypeScript, AWS, MCP,
      // Kubernetes, Terraform, API, …). Lowercase everything else via
      // the `normal` form, which also normalizes simple grammatical
      // variants (case, contractions).
      const term = pos[i] === 'PROPN' ? values[i] : normal[i];
      if (term === '') continue;

      // De-duplicate while preserving first-occurrence order.
      if (seen.has(term)) continue;
      seen.add(term);
      retained.push({ term, index: i });
    }

    const terms = retained.map((t) => t.term);
    const phrases = extractPhrases(retained);

    return { terms, phrases };
  }
}

/**
 * Build 2–3 word phrases from consecutive retained tokens that were
 * adjacent in the original document (token indices differ by exactly 1).
 *
 * Longer phrases (trigrams) are emitted before shorter ones (bigrams),
 * and all phrases are de-duplicated while preserving first-occurrence
 * order within each size.
 */
function extractPhrases(retained: RetainedToken[]): string[] {
  // Group retained tokens into runs of document-adjacent tokens.
  const runs: RetainedToken[][] = [];
  let current: RetainedToken[] = [];
  for (const tok of retained) {
    const prev = current[current.length - 1];
    if (prev && tok.index === prev.index + 1) {
      current.push(tok);
    } else {
      if (current.length >= 2) runs.push(current);
      current = [tok];
    }
  }
  if (current.length >= 2) runs.push(current);

  const phrases: string[] = [];
  const seen = new Set<string>();

  // Trigrams first, then bigrams.
  for (const size of [3, 2]) {
    for (const run of runs) {
      for (let i = 0; i + size <= run.length; i++) {
        const phrase = run.slice(i, i + size).map((t) => t.term).join(' ');
        if (!seen.has(phrase)) {
          seen.add(phrase);
          phrases.push(phrase);
        }
      }
    }
  }

  return phrases;
}

/**
 * Shared singleton analyzer instance.
 *
 * The winkNLP model is heavy to load; reuse one instance across the
 * whole process. Call {@link createWinkQueryAnalyzer} to get a new
 * independent instance if needed (rare).
 */
let shared: WinkQueryAnalyzer | undefined;

/**
 * Returns a process-wide shared {@link WinkQueryAnalyzer} instance.
 * The NLP model is initialized lazily on first use and reused for all
 * subsequent calls.
 */
export function getQueryAnalyzer(): QueryAnalyzer {
  if (!shared) shared = new WinkQueryAnalyzer();
  return shared;
}

/**
 * Creates a fresh, independent {@link WinkQueryAnalyzer} instance.
 *
 * Prefer {@link getQueryAnalyzer} unless you specifically need an
 * isolated instance (e.g. in tests that want to control initialization).
 */
export function createWinkQueryAnalyzer(): QueryAnalyzer {
  return new WinkQueryAnalyzer();
}
