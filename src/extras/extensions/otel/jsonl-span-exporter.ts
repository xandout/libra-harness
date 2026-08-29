import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';

/**
 * A JSONL span exporter for OpenTelemetry.
 *
 * Appends each ended span as one JSON line to a `.jsonl` file — same
 * append-only pattern as disk-session. Each line is a self-contained
 * record with the span name, attributes, timing, status, and events.
 *
 * The file is structured so it can be read line-by-line for analytics
 * (no need to parse the whole file into memory).
 *
 * ## Record format
 *
 * ```json
 * {
 *   "traceId": "abc123...",
 *   "spanId": "span_0",
 *   "parentSpanId": "span_1",
 *   "name": "agent.turn",
 *   "kind": 0,
 *   "startTime": 1234567890.123,
 *   "endTime": 1234567890.456,
 *   "durationMs": 333,
 *   "attributes": { "libra.turn.finish_reason": "stop", ... },
 *   "status": { "code": 1 },
 *   "events": [{ "name": "tool.result", "attributes": {...}, "time": ... }],
 *   "resource": { "service.name": "my-agent" },
 *   "scope": "libra"
 * }
 * ```
 *
 * ## Usage
 *
 * ```typescript
 * import { JsonlSpanExporter } from 'libra-harness/extras/otel';
 * import { NodeSDK } from '@opentelemetry/sdk-node';
 *
 * const sdk = new NodeSDK({
 *   serviceName: 'my-agent',
 *   traceExporter: new JsonlSpanExporter('./traces/traces.jsonl'),
 * });
 * sdk.start();
 * ```
 *
 * No external infrastructure required — just a file path. Good for
 * local development and single-process deployments. For multi-process
 * or dashboard scenarios, use the OTLP exporter instead.
 */
export class JsonlSpanExporter implements SpanExporter {
  private readonly filePath: string;
  private isShutdown = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: number }) => void,
  ): void {
    if (this.isShutdown) {
      resultCallback({ code: 1 }); // FAILURE
      return;
    }

    try {
      const lines = spans.map((span) => JSON.stringify(this.serialize(span))).join('\n') + '\n';
      appendFileSync(this.filePath, lines);
      resultCallback({ code: 0 }); // SUCCESS
    } catch (err) {
      console.error('[otel/jsonl] export failed:', err);
      resultCallback({ code: 1 }); // FAILURE
    }
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
  }

  async forceFlush(): Promise<void> {
    // Writes are synchronous — nothing to flush.
  }

  private serialize(span: ReadableSpan): Record<string, unknown> {
    const ctx = span.spanContext();
    const parent = span.parentSpanContext;

    // Convert HrTime [seconds, nanos] to ms.
    const durationMs = span.duration
      ? Math.round(span.duration[0] * 1000 + span.duration[1] / 1_000_000)
      : 0;

    // Convert start/end HrTime to epoch seconds (float).
    const startTime = span.startTime
      ? span.startTime[0] + span.startTime[1] / 1_000_000_000
      : 0;
    const endTime = span.endTime
      ? span.endTime[0] + span.endTime[1] / 1_000_000_000
      : 0;

    // Serialize events (TimedEvent[]).
    const events = span.events?.map((e: { name: string; attributes?: Record<string, unknown>; time?: [number, number] }) => ({
      name: e.name,
      attributes: e.attributes ?? {},
      time: e.time ? e.time[0] + e.time[1] / 1_000_000_000 : 0,
    })) ?? [];

    // Serialize resource attributes.
    const resource: Record<string, unknown> = {};
    try {
      const attrs = span.resource.attributes as Map<string, unknown> | Record<string, unknown> | undefined;
      if (attrs && typeof (attrs as Map<string, unknown>).forEach === 'function') {
        (attrs as Map<string, unknown>).forEach((value: unknown, key: string) => {
          resource[key] = value;
        });
      } else if (attrs) {
        Object.assign(resource, attrs);
      }
    } catch {
      // Resource may not have attributes — skip.
    }

    return {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      parentSpanId: parent?.spanId,
      name: span.name,
      kind: span.kind,
      startTime,
      endTime,
      durationMs,
      attributes: span.attributes ?? {},
      status: span.status,
      events,
      resource,
      scope: span.instrumentationScope?.name ?? '',
    };
  }
}
