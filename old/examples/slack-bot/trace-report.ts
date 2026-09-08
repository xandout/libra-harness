#!/usr/bin/env tsx
/**
 * Trace analytics — reads traces.jsonl and prints a summary report.
 *
 * Usage:
 *   npm run report              # reads ./traces/traces.jsonl
 *   npm run report -- --file ./traces/traces.jsonl
 *   npm run report -- --csv     # output as CSV for spreadsheet import
 *   npm run report -- --tools   # tool breakdown only
 *   npm run report -- --tokens  # token usage breakdown
 *
 * The report covers:
 *   - Turn summary: count, duration stats (min/p50/p90/max), finish reasons
 *   - LLM calls: count, duration stats, token usage (prompt/completion/cached/reasoning)
 *   - Tool calls: per-tool count, duration stats, error rate
 *   - Errors: count and messages
 *   - Timeline: recent turns (last 20)
 */
import { readFileSync, existsSync } from 'node:fs';

// ── Types ──────────────────────────────────────────────────────────

interface TraceRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  attributes: Record<string, string | number | boolean>;
  status: { code: number; message?: string };
  events: { name: string; attributes?: Record<string, string | number | boolean>; time: number }[];
  resource: Record<string, unknown>;
  scope: string;
}

// ── CLI args ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
const fileFlag = args.indexOf('--file');
const traceFile = fileFlag >= 0 ? args[fileFlag + 1] : './traces/traces.jsonl';
const csvMode = args.includes('--csv');
const toolsOnly = args.includes('--tools');
const tokensOnly = args.includes('--tokens');
const sessionsOnly = args.includes('--sessions');

// ── Load traces ────────────────────────────────────────────────────

if (!existsSync(traceFile)) {
  console.error(`Trace file not found: ${traceFile}`);
  console.error('Run the bot first to generate traces, or specify --file <path>');
  process.exit(1);
}

const raw = readFileSync(traceFile, 'utf-8');
const lines = raw.split('\n').filter((l) => l.trim());
const records: TraceRecord[] = [];
for (const line of lines) {
  try {
    records.push(JSON.parse(line) as TraceRecord);
  } catch {
    // Skip malformed lines.
  }
}

if (records.length === 0) {
  console.log('No trace records found.');
  process.exit(0);
}

// ── Helpers ────────────────────────────────────────────────────────

function stats(values: number[]): { min: number; p50: number; p90: number; max: number; avg: number; count: number } {
  if (values.length === 0) return { min: 0, p50: 0, p90: 0, max: 0, avg: 0, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const pct = (p: number) => sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];
  return {
    min: sorted[0],
    p50: pct(0.5),
    p90: pct(0.9),
    max: sorted[sorted.length - 1],
    avg: sum / sorted.length,
    count: sorted.length,
  };
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function groupBy<T>(arr: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of arr) {
    const k = key(item);
    const list = map.get(k) ?? [];
    list.push(item);
    map.set(k, list);
  }
  return map;
}

// ── Categorize spans ───────────────────────────────────────────────

const turnSpans = records.filter((r) => r.name === 'agent.turn');
const llmSpans = records.filter((r) => r.name === 'llm.request');
const toolSpans = records.filter((r) => r.name.startsWith('tool.'));
const errorSpans = records.filter((r) => r.status.code === 2); // ERROR

// ── CSV mode ───────────────────────────────────────────────────────

if (csvMode) {
  // Output turns as CSV with session correlation columns.
  console.log('timestamp,duration_ms,finish_reason,iterations,tool_calls,prompt_tokens,completion_tokens,cached_tokens,reasoning_tokens,session_id,channel_id,thread_ts,user_id');

  for (const turn of turnSpans) {
    const traceId = turn.traceId;
    // Find child LLM spans for this turn.
    const turnLlm = llmSpans.filter((l) => l.traceId === traceId);
    const promptTokens = turnLlm.reduce((s, l) => s + (l.attributes['libra.llm.prompt_tokens'] as number ?? 0), 0);
    const completionTokens = turnLlm.reduce((s, l) => s + (l.attributes['libra.llm.completion_tokens'] as number ?? 0), 0);
    const cachedTokens = turnLlm.reduce((s, l) => s + (l.attributes['libra.llm.cached_prompt_tokens'] as number ?? 0), 0);
    const reasoningTokens = turnLlm.reduce((s, l) => s + (l.attributes['libra.llm.reasoning_tokens'] as number ?? 0), 0);

    const sessionId = turn.attributes['libra.turn.sessionId'] ?? '';
    const channelId = turn.attributes['libra.turn.slack.channelId'] ?? '';
    const threadTs = turn.attributes['libra.turn.slack.threadTs'] ?? '';
    const userId = turn.attributes['libra.turn.slack.userId'] ?? '';

    console.log([
      new Date(turn.startTime * 1000).toISOString(),
      turn.durationMs,
      turn.attributes['libra.turn.finish_reason'] ?? '',
      turn.attributes['libra.turn.iterations'] ?? '',
      turn.attributes['libra.turn.tool_calls'] ?? '',
      promptTokens,
      completionTokens,
      cachedTokens,
      reasoningTokens,
      sessionId,
      channelId,
      threadTs,
      userId,
    ].join(','));
  }
  process.exit(0);
}

// ── Report ─────────────────────────────────────────────────────────

const totalDuration = turnSpans.reduce((s, t) => s + t.durationMs, 0);
const turnDurations = turnSpans.map((t) => t.durationMs);
const llmDurations = llmSpans.map((l) => l.durationMs);
const turnStats = stats(turnDurations);
const llmStats = stats(llmDurations);

// ── Token usage ────────────────────────────────────────────────────

const totalPromptTokens = llmSpans.reduce((s, l) => s + (l.attributes['libra.llm.prompt_tokens'] as number ?? 0), 0);
const totalCompletionTokens = llmSpans.reduce((s, l) => s + (l.attributes['libra.llm.completion_tokens'] as number ?? 0), 0);
const totalCachedTokens = llmSpans.reduce((s, l) => s + (l.attributes['libra.llm.cached_prompt_tokens'] as number ?? 0), 0);
const totalReasoningTokens = llmSpans.reduce((s, l) => s + (l.attributes['libra.llm.reasoning_tokens'] as number ?? 0), 0);

// ── Finish reasons ─────────────────────────────────────────────────

const finishReasons = groupBy(turnSpans, (t) => String(t.attributes['libra.turn.finish_reason'] ?? 'unknown'));

// ── Tools only mode ────────────────────────────────────────────────

if (toolsOnly) {
  console.log('\n─ Tool Breakdown ──────────────────────────────────────────\n');
  const toolGroups = groupBy(toolSpans, (t) => t.name);
  const sorted = [...toolGroups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [name, spans] of sorted) {
    const s = stats(spans.map((t) => t.durationMs));
    const errors = spans.filter((t) => t.status.code === 2).length;
    const errRate = spans.length > 0 ? ((errors / spans.length) * 100).toFixed(1) : '0';
    console.log(`  ${name}`);
    console.log(`    calls: ${s.count}  errors: ${errors} (${errRate}%)`);
    console.log(`    duration: min=${fmtMs(s.min)} p50=${fmtMs(s.p50)} p90=${fmtMs(s.p90)} max=${fmtMs(s.max)} avg=${fmtMs(s.avg)}`);
    console.log();
  }
  process.exit(0);
}

// ── Tokens only mode ───────────────────────────────────────────────

if (tokensOnly) {
  console.log('\n─ Token Usage ─────────────────────────────────────────────\n');
  console.log(`  Total LLM calls:     ${llmSpans.length}`);
  console.log(`  Prompt tokens:       ${totalPromptTokens.toLocaleString()}`);
  console.log(`  Completion tokens:   ${totalCompletionTokens.toLocaleString()}`);
  console.log(`  Cached prompt:       ${totalCachedTokens.toLocaleString()}` + (totalCachedTokens > 0 ? ` (${((totalCachedTokens / totalPromptTokens) * 100).toFixed(1)}% hit rate)` : ''));
  console.log(`  Reasoning tokens:    ${totalReasoningTokens.toLocaleString()}`);
  console.log(`  Total tokens:        ${(totalPromptTokens + totalCompletionTokens + totalReasoningTokens).toLocaleString()}`);
  console.log();

  // Per-turn token breakdown.
  console.log('  Per-turn tokens (last 20):');
  const recent = turnSpans.slice(-20);
  for (const turn of recent) {
    const turnLlm = llmSpans.filter((l) => l.traceId === turn.traceId);
    const pt = turnLlm.reduce((s, l) => s + (l.attributes['libra.llm.prompt_tokens'] as number ?? 0), 0);
    const ct = turnLlm.reduce((s, l) => s + (l.attributes['libra.llm.completion_tokens'] as number ?? 0), 0);
    const rt = turnLlm.reduce((s, l) => s + (l.attributes['libra.llm.reasoning_tokens'] as number ?? 0), 0);
    const time = new Date(turn.startTime * 1000).toLocaleTimeString();
    console.log(`    ${time}  prompt=${String(pt).padStart(6)}  completion=${String(ct).padStart(5)}  reasoning=${String(rt).padStart(5)}  iters=${turn.attributes['libra.turn.iterations'] ?? '?'}`);
  }
  process.exit(0);
}

// ── Sessions only mode ─────────────────────────────────────────────

if (sessionsOnly) {
  console.log('\n─ Session Breakdown ────────────────────────────────────────\n');

  // Group turns by sessionId (or '(no session)' if missing).
  const sessionGroups = groupBy(turnSpans, (t) => String(t.attributes['libra.turn.sessionId'] ?? '(no session)'));
  const sortedSessions = [...sessionGroups.entries()].sort((a, b) => {
    // Sort by first turn timestamp ascending (oldest session first).
    const aFirst = Math.min(...a[1].map((t) => t.startTime));
    const bFirst = Math.min(...b[1].map((t) => t.startTime));
    return aFirst - bFirst;
  });

  for (const [sessionId, turns] of sortedSessions) {
    const s = stats(turns.map((t) => t.durationMs));
    const totalTokens = turns.reduce((sum, turn) => {
      const turnLlm = llmSpans.filter((l) => l.traceId === turn.traceId);
      return sum + turnLlm.reduce((s2, l) => s2 + (l.attributes['libra.llm.prompt_tokens'] as number ?? 0) + (l.attributes['libra.llm.completion_tokens'] as number ?? 0), 0);
    }, 0);
    const totalTools = turns.reduce((sum, turn) => sum + (turn.attributes['libra.turn.tool_calls'] as number ?? 0), 0);
    const errors = turns.filter((t) => t.status.code === 2).length;
    const channelId = turns[0].attributes['libra.turn.slack.channelId'] ?? '?';
    const channelType = turns[0].attributes['libra.turn.slack.channelType'] ?? '?';
    const firstTime = new Date(Math.min(...turns.map((t) => t.startTime)) * 1000).toLocaleString();
    const lastTime = new Date(Math.max(...turns.map((t) => t.startTime)) * 1000).toLocaleString();

    console.log(`  Session: ${sessionId}`);
    console.log(`    Channel: ${channelId} (${channelType})`);
    console.log(`    Turns:   ${s.count}  Errors: ${errors}`);
    console.log(`    Tools:   ${totalTools} total`);
    console.log(`    Tokens:  ${totalTokens.toLocaleString()} total`);
    console.log(`    Duration: min=${fmtMs(s.min)} p50=${fmtMs(s.p50)} p90=${fmtMs(s.p90)} max=${fmtMs(s.max)} avg=${fmtMs(s.avg)}`);
    console.log(`    Active:  ${firstTime} → ${lastTime}`);
    console.log();

    // Per-turn detail within this session.
    console.log('    Turns:');
    for (const turn of turns) {
      const time = new Date(turn.startTime * 1000).toLocaleTimeString();
      const dur = fmtMs(turn.durationMs);
      const reason = String(turn.attributes['libra.turn.finish_reason'] ?? '?');
      const iters = String(turn.attributes['libra.turn.iterations'] ?? '?');
      const tools = String(turn.attributes['libra.turn.tool_calls'] ?? '0');
      const turnLlm = llmSpans.filter((l) => l.traceId === turn.traceId);
      const tokens = turnLlm.reduce((s2, l) => s2 + (l.attributes['libra.llm.prompt_tokens'] as number ?? 0) + (l.attributes['libra.llm.completion_tokens'] as number ?? 0), 0);
      const user = turn.attributes['libra.turn.slack.userId'] ?? '?';
      console.log(`      ${time}  ${dur.padStart(9)}  ${reason.padStart(15)}  iters=${iters}  tools=${tools}  tokens=${tokens}  user=${user}`);
    }
    console.log();
  }
  process.exit(0);
}

// ── Full report ────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║                    Trace Analytics Report                    ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

console.log(`  File:        ${traceFile}`);
console.log(`  Total spans: ${records.length}`);
console.log(`  Turns:       ${turnSpans.length}`);
console.log(`  LLM calls:   ${llmSpans.length}`);
console.log(`  Tool calls:  ${toolSpans.length}`);
console.log(`  Errors:      ${errorSpans.length}`);
console.log(`  Time range:  ${new Date(Math.min(...records.map(r => r.startTime)) * 1000).toLocaleString()} → ${new Date(Math.max(...records.map(r => r.startTime)) * 1000).toLocaleString()}`);
console.log();

// ── Turn Summary ───────────────────────────────────────────────────

console.log('─ Turn Summary ──────────────────────────────────────────────\n');
console.log(`  Total turn time: ${fmtMs(totalDuration)}`);
console.log(`  Duration:  min=${fmtMs(turnStats.min)}  p50=${fmtMs(turnStats.p50)}  p90=${fmtMs(turnStats.p90)}  max=${fmtMs(turnStats.max)}  avg=${fmtMs(turnStats.avg)}`);
console.log();
console.log('  Finish reasons:');
for (const [reason, spans] of finishReasons) {
  console.log(`    ${reason}: ${spans.length} (${((spans.length / turnSpans.length) * 100).toFixed(1)}%)`);
}
console.log();

// ── LLM Summary ────────────────────────────────────────────────────

console.log('─ LLM Calls ─────────────────────────────────────────────────\n');
console.log(`  Duration:  min=${fmtMs(llmStats.min)}  p50=${fmtMs(llmStats.p50)}  p90=${fmtMs(llmStats.p90)}  max=${fmtMs(llmStats.max)}  avg=${fmtMs(llmStats.avg)}`);
console.log();
console.log(`  Token usage:`);
console.log(`    Prompt:       ${totalPromptTokens.toLocaleString()}`);
console.log(`    Completion:   ${totalCompletionTokens.toLocaleString()}`);
console.log(`    Cached:       ${totalCachedTokens.toLocaleString()}` + (totalCachedTokens > 0 && totalPromptTokens > 0 ? ` (${((totalCachedTokens / totalPromptTokens) * 100).toFixed(1)}% hit rate)` : ''));
console.log(`    Reasoning:    ${totalReasoningTokens.toLocaleString()}`);
console.log(`    Total:        ${(totalPromptTokens + totalCompletionTokens + totalReasoningTokens).toLocaleString()}`);
if (llmSpans.length > 0) {
  console.log(`    Per call avg: prompt=${Math.round(totalPromptTokens / llmSpans.length)}  completion=${Math.round(totalCompletionTokens / llmSpans.length)}`);
}
console.log();

// ── Tool Breakdown ─────────────────────────────────────────────────

if (toolSpans.length > 0) {
  console.log('─ Tool Breakdown ────────────────────────────────────────────\n');
  const toolGroups = groupBy(toolSpans, (t) => t.name);
  const sorted = [...toolGroups.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log(`  ${'Tool'.padEnd(35)} ${'Calls'.padStart(6)} ${'Errors'.padStart(7)} ${'p50'.padStart(8)} ${'p90'.padStart(8)} ${'max'.padStart(8)}`);
  console.log(`  ${'─'.repeat(35)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)}`);
  for (const [name, spans] of sorted) {
    const s = stats(spans.map((t) => t.durationMs));
    const errors = spans.filter((t) => t.status.code === 2).length;
    console.log(`  ${name.padEnd(35)} ${String(s.count).padStart(6)} ${String(errors).padStart(7)} ${fmtMs(s.p50).padStart(8)} ${fmtMs(s.p90).padStart(8)} ${fmtMs(s.max).padStart(8)}`);
  }
  console.log();
}

// ── Errors ─────────────────────────────────────────────────────────

if (errorSpans.length > 0) {
  console.log('─ Errors ────────────────────────────────────────────────────\n');
  const errorGroups = groupBy(errorSpans, (e) => e.name);
  for (const [name, spans] of errorGroups) {
    console.log(`  ${name}: ${spans.length} error(s)`);
    for (const span of spans.slice(0, 5)) {
      const time = new Date(span.startTime * 1000).toLocaleString();
      const excEvent = span.events.find((e) => e.name === 'exception');
      const msg = excEvent?.attributes?.['exception.message'] ?? span.status.message ?? '(no message)';
      console.log(`    ${time}: ${msg}`);
    }
    if (spans.length > 5) console.log(`    ... and ${spans.length - 5} more`);
  }
  console.log();
}

// ── Recent Turns ───────────────────────────────────────────────────

console.log('─ Recent Turns (last 20) ────────────────────────────────────\n');
console.log(`  ${'Time'.padEnd(10)} ${'Duration'.padStart(9)} ${'Finish'.padStart(15)} ${'Iters'.padStart(6)} ${'Tools'.padStart(6)} ${'Tokens'.padStart(8)}  ${'Session'.padEnd(30)}`);
console.log(`  ${'─'.repeat(10)} ${'─'.repeat(9)} ${'─'.repeat(15)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(8)}  ${'─'.repeat(30)}`);
const recent = turnSpans.slice(-20);
for (const turn of recent) {
  const time = new Date(turn.startTime * 1000).toLocaleTimeString();
  const dur = fmtMs(turn.durationMs);
  const reason = String(turn.attributes['libra.turn.finish_reason'] ?? '?');
  const iters = String(turn.attributes['libra.turn.iterations'] ?? '?');
  const tools = String(turn.attributes['libra.turn.tool_calls'] ?? '0');
  const turnLlm = llmSpans.filter((l) => l.traceId === turn.traceId);
  const tokens = turnLlm.reduce((s, l) => s + (l.attributes['libra.llm.prompt_tokens'] as number ?? 0) + (l.attributes['libra.llm.completion_tokens'] as number ?? 0), 0);
  const session = String(turn.attributes['libra.turn.sessionId'] ?? '?');
  console.log(`  ${time.padEnd(10)} ${dur.padStart(9)} ${reason.padStart(15)} ${iters.padStart(6)} ${tools.padStart(6)} ${String(tokens).padStart(8)}  ${session.padEnd(30)}`);
}
console.log();

// ── Tips ───────────────────────────────────────────────────────────

console.log('─ Commands ──────────────────────────────────────────────────\n');
console.log('  npm run report -- --csv       Export turns as CSV (spreadsheet)');
console.log('  npm run report -- --tools     Tool breakdown only');
console.log('  npm run report -- --tokens    Token usage breakdown only');
console.log('  npm run report -- --sessions  Session breakdown (per-session turns, tokens, tools)');
console.log();
