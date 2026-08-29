/**
 * large-document-mapper — a standalone demo script (not a libra extension).
 *
 * Given a large document, it uses wink-nlp to accomplish two goals:
 *
 *   1. Build a **document overview** containing:
 *      - Named entities with type + character offsets (model-dependent;
 *        the lite model has limited NER).
 *      - Top 20 keywords by frequency (retained POS: nouns and proper
 *        nouns only; stop words dropped; casing preserved for proper
 *        nouns).
 *
 *   2. Build a **keyword → offset index** — a map from each retained
 *      keyword to the character offsets where it occurs in the original
 *      text. Offsets are reconstructed from wink-nlp's `precedingSpaces`
 *      + token `value` length, which gives exact character spans into
 *      the source document.
 *
 * Usage:
 *   node index.ts            # runs against a built-in sample document
 *   node index.ts <file>     # reads the document from a file path
 *
 * No libra dependency — this is a pure wink-nlp demo.
 */

import { readFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';
import type { Document, PartOfSpeech, WinkMethods } from 'wink-nlp';

// ── Types ───────────────────────────────────────────────────────────

/** A single keyword entry in the offset index. */
interface OffsetEntry {
  /** The keyword (lowercased for terms, original casing for proper nouns). */
  term: string;
  /** Character start offsets in the original document. */
  offsets: number[];
  /** Number of occurrences. */
  count: number;
}

/** A named entity occurrence. */
interface EntityEntry {
  /** Surface form of the entity. */
  text: string;
  /** Entity type (DATE, ORG, PERSON, …) — model dependent. */
  type: string;
  /** Character start offsets. */
  offsets: number[];
}

/** The document overview. */
interface DocumentOverview {
  /** Named entities found by the model, grouped by surface form + type. */
  entities: EntityEntry[];
  /** Top keywords by frequency (retained POS, de-duplicated). */
  topKeywords: Array<{ term: string; count: number }>;
}

/** The full mapping result. */
interface DocumentMap {
  overview: DocumentOverview;
  /** Keyword → character offsets. */
  keywordIndex: OffsetEntry[];
}

// ── NLP engine (initialized once) ──────────────────────────────────

const nlp: WinkMethods = winkNLP(model as unknown as Parameters<typeof winkNLP>[0]);

/**
 * POS tags worth retaining as keywords.
 *
 * Only nouns and proper nouns — verbs and adjectives (said, went, know,
 * little, …) are too common in prose to be useful index entries. The
 * keyword-extractor extension retains VERB/ADJ because it analyzes
 * *queries* where they carry intent; a document keyword index wants
 * things and names, not actions and modifiers.
 */
const RETAINED_POS: ReadonlySet<PartOfSpeech> = new Set(['NOUN', 'PROPN']);

// ── Offset reconstruction ──────────────────────────────────────────

/**
 * A token plus its reconstructed character span in the source text.
 *
 * wink-nlp does not expose character offsets directly, but each token
 * carries `precedingSpaces` (the whitespace before it) and a `value`
 * (the surface text). Accumulating those reconstructs exact spans.
 */
interface TokenSpan {
  /** Index of the token in the document. */
  index: number;
  /** Surface form. */
  value: string;
  /** Normalized form (lowercased, contraction-expanded). */
  normal: string;
  /** POS tag. */
  pos: PartOfSpeech;
  /** Character start offset in the source text. */
  start: number;
  /** Character end offset (exclusive). */
  end: number;
}

/**
 * Reconstruct per-token character spans from wink-nlp output.
 *
 * The math: token 0 starts at `precedingSpaces[0].length` (leading
 * whitespace). Each subsequent token starts at the previous token's end
 * plus its `precedingSpaces` length.
 */
function tokenSpans(doc: Document): TokenSpan[] {
  const values = doc.tokens().out() as string[];
  const spaces = doc.tokens().out(nlp.its.precedingSpaces) as string[];
  const normal = doc.tokens().out(nlp.its.normal) as string[];
  const pos = doc.tokens().out(nlp.its.pos) as PartOfSpeech[];

  const spans: TokenSpan[] = [];
  let cursor = 0;
  for (let i = 0; i < values.length; i++) {
    cursor += spaces[i].length;
    const start = cursor;
    const end = start + values[i].length;
    spans.push({ index: i, value: values[i], normal: normal[i], pos: pos[i], start, end });
    cursor = end;
  }
  return spans;
}

// ── Keyword extraction (mirrors the keyword-extractor extension) ───

/** A retained token span — kept for keyword indexing. */
interface RetainedSpan extends TokenSpan {
  /** The term to surface (case-preserved for proper nouns, else normal form). */
  term: string;
}

/** Drop punctuation, stop words, and non-retained POS; pick the surface term. */
function retainKeywords(spans: TokenSpan[]): RetainedSpan[] {
  // `type` and `stopWordFlag` are per-token features fetched once per
  // analyze() call and wired up via the `_typeFn` / `_stopFn` closures.
  return spans
    .map((s) => ({ span: s, type: typeOf(s.index), stop: stopOf(s.index) }))
    .filter((x) => x.type === 'word' && !x.stop && RETAINED_POS.has(x.span.pos))
    .map((x) => {
      const term = x.span.pos === 'PROPN' ? x.span.value : x.span.normal;
      return { ...x.span, term };
    });
}

// The `type` and `stopWordFlag` accessors need the raw document. We close
// over them per-call via a small helper to avoid threading the doc through
// every function. Set by `analyze()`.
let _typeFn: ((i: number) => string) | undefined;
let _stopFn: ((i: number) => boolean) | undefined;
function typeOf(i: number): string {
  return _typeFn ? _typeFn(i) : 'word';
}
function stopOf(i: number): boolean {
  return _stopFn ? _stopFn(i) : false;
}

// ── Group offsets by term ──────────────────────────────────────────

/** Group spans by term, preserving first-occurrence order, with offsets. */
function groupOffsets<T extends { term: string; start: number }>(
  items: T[],
): OffsetEntry[] {
  const map = new Map<string, OffsetEntry>();
  for (const item of items) {
    let entry = map.get(item.term);
    if (!entry) {
      entry = { term: item.term, offsets: [], count: 0 };
      map.set(item.term, entry);
    }
    entry.offsets.push(item.start);
    entry.count++;
  }
  return [...map.values()];
}

// ── Document overview ──────────────────────────────────────────────

/** Build the overview (named entities + top keywords) from the document. */
function buildOverview(doc: Document, spans: TokenSpan[], retained: RetainedSpan[]): DocumentOverview {
  // Named entities (grouped by surface form + type).
  const entValues = doc.entities().out() as string[];
  const entTypes = doc.entities().out(nlp.its.type) as string[];
  const entOffsets = entityOffsets(doc, spans);
  const entityMap = new Map<string, EntityEntry>();
  for (let i = 0; i < entValues.length; i++) {
    const key = `${entTypes[i]}::${entValues[i]}`;
    let entry = entityMap.get(key);
    if (!entry) {
      entry = { text: entValues[i], type: entTypes[i], offsets: [] };
      entityMap.set(key, entry);
    }
    if (entOffsets[i] != null) entry.offsets.push(entOffsets[i]);
  }

  // Top keywords by frequency.
  const keywordCounts = new Map<string, number>();
  for (const r of retained) {
    keywordCounts.set(r.term, (keywordCounts.get(r.term) ?? 0) + 1);
  }
  const topKeywords = [...keywordCounts.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, 20);

  return {
    entities: [...entityMap.values()],
    topKeywords,
  };
}

/** Reconstruct each entity's character start offset from its first token. */
function entityOffsets(doc: Document, spans: TokenSpan[]): number[] {
  const out: number[] = [];
  doc.entities().each((e) => {
    const firstIdx = e.tokens().itemAt(0)?.index();
    out.push(firstIdx != null ? spans[firstIdx]?.start ?? -1 : -1);
  });
  return out;
}

// ── Top-level analyze ──────────────────────────────────────────────

/** Analyze a document and return the overview + keyword offset index. */
function analyze(text: string): DocumentMap {
  const doc = nlp.readDoc(text);

  // Wire up per-token feature accessors for `retainKeywords`.
  const types = doc.tokens().out(nlp.its.type) as string[];
  const stops = doc.tokens().out(nlp.its.stopWordFlag) as boolean[];
  _typeFn = (i: number) => types[i];
  _stopFn = (i: number) => stops[i];

  const spans = tokenSpans(doc);
  const retained = retainKeywords(spans);

  const overview = buildOverview(doc, spans, retained);
  const keywordIndex = groupOffsets(retained).sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));

  // Clear the closures so they don't leak between calls.
  _typeFn = undefined;
  _stopFn = undefined;

  return { overview, keywordIndex };
}

// ── Pretty printing ────────────────────────────────────────────────

function printOverview(o: DocumentOverview): void {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  DOCUMENT OVERVIEW');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  ── Named entities ──');
  if (o.entities.length === 0) {
    console.log('  (none detected by the lite model)');
  } else {
    for (const e of o.entities) {
      console.log(`  ${e.type.padEnd(8)} ${e.text}  [${e.offsets.length}× @ ${e.offsets.join(', ')}]`);
    }
  }
  console.log('');
  console.log('  ── Top keywords (by frequency) ──');
  for (const k of o.topKeywords) {
    console.log(`  ${String(k.count).padStart(3)}×  ${k.term}`);
  }
  console.log('');
}

function printIndex(title: string, entries: OffsetEntry[], maxShow: number): void {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`  ${title}`);
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`  ${entries.length} unique entries`);
  console.log('');
  const shown = entries.slice(0, maxShow);
  for (const e of shown) {
    const preview = e.offsets.slice(0, 8).join(', ');
    const more = e.offsets.length > 8 ? `, +${e.offsets.length - 8} more` : '';
    console.log(`  ${String(e.count).padStart(3)}×  ${e.term.padEnd(28)} → [${preview}${more}]`);
  }
  if (entries.length > maxShow) {
    console.log(`  … and ${entries.length - maxShow} more entries`);
  }
  console.log('');
}

// ── Sample document ────────────────────────────────────────────────

const SAMPLE = `The Libra Agent Harness is a small, composable runtime for building LLM-powered agents in TypeScript. It is designed to be embedded as an ordinary library, with no requirement for a daemon, a database, or a running server.

The core agent owns only the turn lifecycle: preparing context, calling the model, executing tools, and returning a final response. Everything else — sessions, memory, MCP, observability, HTTP interfaces — is an extension. Extensions participate through lifecycle hooks such as beforeTurn, beforeContext, beforeLLM, and afterTurn.

Hooks are not merely event notifications. They support both observation and mutation. A session extension can load state in beforeTurn and persist it in afterTurn. A memory extension can inject context in beforeContext and extract durable facts in afterTurn. An MCP extension can register tools without the core knowing that MCP exists.

The harness supports multiple independent agents in one process. A research agent, a coding agent, and a private assistant can coexist, each with its own model, instructions, tools, and extensions. Agents can call other agents locally, in-process, without any network communication. Distribution is an optional deployment concern, not a requirement of the architecture.

Hook ordering is deterministic. Each extension declares a priority, and hooks run in priority order within each lifecycle stage, with registration order as the tiebreaker. Observability extensions typically use high priorities so they see raw state before mutators. Persistence extensions typically use low or negative priorities so they run after enrichment.

Errors are modeled explicitly. Tool errors become tool results so the model can react. Errors that escape the turn loop — model failures, hook crashes — flow through onError hooks first, then an error policy that can fall back gracefully, rethrow, or recover with a custom response.`;

// ── Main ───────────────────────────────────────────────────────────

function main(): void {
  const argPath = argv[2];
  const text = argPath
    ? readFileSync(argPath, 'utf-8')
    : SAMPLE;

  if (text.trim().length === 0) {
    console.error('Document is empty.');
    exit(1);
  }

  console.log(`\nAnalyzing ${argPath ? argPath : 'built-in sample document'}…\n`);

  const map = analyze(text);

  printOverview(map.overview);
  printIndex('KEYWORD → OFFSET INDEX', map.keywordIndex, 25);
}

main();
