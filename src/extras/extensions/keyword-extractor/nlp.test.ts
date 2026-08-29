import { describe, it, expect } from 'vitest';
import { createWinkQueryAnalyzer, type QueryAnalyzer } from './index.js';

// Use a fresh analyzer instance for the suite so initialization is
// controlled and independent of any process-wide singleton.
const analyzer: QueryAnalyzer = createWinkQueryAnalyzer();

describe('WinkQueryAnalyzer', () => {
  // ── Normal conversational sentence ──────────────────────────────
  it('extracts terms from a normal conversational sentence', () => {
    const out = analyzer.analyze(
      "Can you find the documentation for the TypeScript library we're using to build nested knowledge graphs?",
    );
    expect(out.terms).toEqual([
      'find',
      'documentation',
      'TypeScript',
      'library',
      'build',
      'nested',
      'knowledge',
      'graphs',
    ]);
    // Trigram first, then bigrams.
    expect(out.phrases).toEqual([
      'build nested knowledge',
      'nested knowledge graphs',
      'TypeScript library',
      'build nested',
      'nested knowledge',
      'knowledge graphs',
    ]);
  });

  // ── Heavy conversational filler ─────────────────────────────────
  it('drops conversational filler and keeps meaningful terms', () => {
    const out = analyzer.analyze(
      'Hey, could you please look through our documentation and find the thing we discussed yesterday about MCP authentication?',
    );
    // Filler (hey, could, you, please, through, our, and, the, we,
    // yesterday, about) is gone. "look" is a real verb and is retained.
    expect(out.terms).toEqual([
      'look',
      'documentation',
      'find',
      'thing',
      'discussed',
      'MCP',
      'authentication',
    ]);
    expect(out.phrases).toEqual(['MCP authentication']);
  });

  // ── Technical terms ─────────────────────────────────────────────
  it('preserves technical/proper-noun terms with their casing', () => {
    const out = analyzer.analyze('AWS Kubernetes Terraform API MCP JavaScript');
    expect(out.terms).toEqual([
      'AWS',
      'Kubernetes',
      'Terraform',
      'API',
      'MCP',
      'JavaScript',
    ]);
  });

  // ── Acronyms ────────────────────────────────────────────────────
  it('preserves acronyms as proper nouns', () => {
    const out = analyzer.analyze('What is the MCP?');
    expect(out.terms).toEqual(['MCP']);
    expect(out.phrases).toEqual([]);
  });

  // ── Duplicate words ─────────────────────────────────────────────
  it('removes duplicate terms (same casing)', () => {
    const out = analyzer.analyze('MCP, MCP, MCP');
    expect(out.terms).toEqual(['MCP']);
  });

  it('removes duplicate non-stopwords across a sentence', () => {
    const out = analyzer.analyze('find the documentation, find the thing!');
    expect(out.terms).toEqual(['find', 'documentation', 'thing']);
  });

  // ── Punctuation ─────────────────────────────────────────────────
  it('strips punctuation and keeps only word tokens', () => {
    const out = analyzer.analyze('Hello, world!!! How are you doing today?');
    // "Hello" (INTJ) and "today" (ADV) are dropped by the POS filter;
    // punctuation is dropped by the word-type filter.
    expect(out.terms).toEqual(['world']);
    expect(out.phrases).toEqual([]);
  });

  // ── Empty string ────────────────────────────────────────────────
  it('returns empty terms for an empty string', () => {
    const out = analyzer.analyze('');
    expect(out.terms).toEqual([]);
    expect(out.phrases).toEqual([]);
  });

  it('returns empty terms for whitespace-only input', () => {
    const out = analyzer.analyze('   ');
    expect(out.terms).toEqual([]);
    expect(out.phrases).toEqual([]);
  });

  it('returns empty terms for nullish input', () => {
    const out = analyzer.analyze(undefined as unknown as string);
    expect(out.terms).toEqual([]);
    expect(out.phrases).toEqual([]);
  });

  // ── Very short input ────────────────────────────────────────────
  it('handles very short input (single filler word)', () => {
    const out = analyzer.analyze('Hi');
    // "Hi" is an interjection — dropped by the POS filter.
    expect(out.terms).toEqual([]);
  });

  it('handles very short input (single stop-word-only phrase)', () => {
    const out = analyzer.analyze('the and of');
    expect(out.terms).toEqual([]);
  });

  // ── A question ──────────────────────────────────────────────────
  it('extracts terms from a question about agent memory', () => {
    const out = analyzer.analyze('Where did we decide to store agent memory?');
    expect(out.terms).toEqual(['decide', 'store', 'agent', 'memory']);
    expect(out.phrases).toEqual([
      'store agent memory',
      'store agent',
      'agent memory',
    ]);
  });

  // ── Multi-word technical concepts ───────────────────────────────
  it('extracts multi-word technical concepts as phrases', () => {
    const out = analyzer.analyze('Can you find our documentation about the MCP server architecture?');
    expect(out.terms).toEqual([
      'find',
      'documentation',
      'MCP',
      'server',
      'architecture',
    ]);
    expect(out.phrases).toEqual([
      'MCP server architecture',
      'MCP server',
      'server architecture',
    ]);
  });

  it('extracts phrases from "nested knowledge graph"', () => {
    const out = analyzer.analyze('nested knowledge graph');
    expect(out.terms).toEqual(['nested', 'knowledge', 'graph']);
    expect(out.phrases).toEqual([
      'nested knowledge graph',
      'nested knowledge',
      'knowledge graph',
    ]);
  });

  // ── Mixed casing ────────────────────────────────────────────────
  it('treats different surface casings of a proper noun as distinct terms', () => {
    // winkNLP tags "typescript" (lowercase) as a proper noun too, so
    // each surface form is preserved verbatim and not collapsed.
    const out = analyzer.analyze('TypeScript typescript TYPESCRIPT');
    expect(out.terms).toEqual(['TypeScript', 'typescript', 'TYPESCRIPT']);
  });

  // ── Determinism ─────────────────────────────────────────────────
  it('is deterministic — same input yields same output across calls', () => {
    const input = 'Can you find our documentation about the MCP server architecture?';
    const a = analyzer.analyze(input);
    const b = analyzer.analyze(input);
    expect(b).toEqual(a);
  });

  it('is safe to reuse repeatedly (long-running process)', () => {
    const analyzer2 = createWinkQueryAnalyzer();
    const samples = [
      'Find the MCP documentation',
      'Where did we store agent memory?',
      'AWS Kubernetes Terraform',
      '',
      'nested knowledge graph',
    ];
    // Run many times — should never throw and stay deterministic.
    for (let i = 0; i < 50; i++) {
      for (const s of samples) {
        const out = analyzer2.analyze(s);
        expect(Array.isArray(out.terms)).toBe(true);
      }
    }
    // Final call matches a fresh call on another instance.
    expect(analyzer2.analyze('nested knowledge graph')).toEqual(
      analyzer.analyze('nested knowledge graph'),
    );
  });
});
