// OTLP/JSON encoding of finished spans (the ExportTraceServiceRequest of opentelemetry-proto), for
// ``POST <endpoint>/v1/traces`` with ``content-type: application/json``. Trace and span ids are hex strings
// and times are nanosecond decimal strings, as the OTLP/JSON mapping requires.
import type { Attributes, AttributeValue, HrTime } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: AnyValue[] } };

interface KeyValue {
  key: string;
  value: AnyValue;
}

const nanos = ([s, ns]: HrTime): string => (BigInt(s) * 1_000_000_000n + BigInt(ns)).toString();

function anyValue(v: unknown): AnyValue {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => anyValue(x ?? '')) } };
  return { stringValue: String(v) };
}

export function keyValues(attrs: Attributes | undefined): KeyValue[] {
  const out: KeyValue[] = [];
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null) continue;
    out.push({ key, value: anyValue(value as AttributeValue) });
  }
  return out;
}

function spanJson(s: ReadableSpan) {
  const ctx = s.spanContext();
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    ...(ctx.traceState ? { traceState: ctx.traceState.serialize() } : {}),
    ...(s.parentSpanContext?.spanId ? { parentSpanId: s.parentSpanContext.spanId } : {}),
    flags: ctx.traceFlags,
    name: s.name,
    // OTLP's SpanKind is the API's plus one (0 is UNSPECIFIED).
    kind: s.kind + 1,
    startTimeUnixNano: nanos(s.startTime),
    endTimeUnixNano: nanos(s.endTime),
    attributes: keyValues(s.attributes),
    droppedAttributesCount: s.droppedAttributesCount ?? 0,
    events: s.events.map((e) => ({
      timeUnixNano: nanos(e.time),
      name: e.name,
      attributes: keyValues(e.attributes),
      droppedAttributesCount: e.droppedAttributesCount ?? 0,
    })),
    droppedEventsCount: s.droppedEventsCount ?? 0,
    links: s.links.map((l) => ({
      traceId: l.context.traceId,
      spanId: l.context.spanId,
      attributes: keyValues(l.attributes),
      droppedAttributesCount: l.droppedAttributesCount ?? 0,
    })),
    droppedLinksCount: s.droppedLinksCount ?? 0,
    status: { code: s.status.code, ...(s.status.message ? { message: s.status.message } : {}) },
  };
}

/** The OTLP/JSON request body: spans grouped by resource, then by instrumentation scope. */
export function encodeOtlpJson(spans: readonly ReadableSpan[]): string {
  const byResource = new Map<unknown, { attrs: Attributes; scopes: Map<string, { scope: ReadableSpan['instrumentationScope']; spans: ReadableSpan[] }> }>();
  for (const s of spans) {
    let r = byResource.get(s.resource);
    if (!r) byResource.set(s.resource, (r = { attrs: s.resource?.attributes ?? {}, scopes: new Map() }));
    const sc = s.instrumentationScope;
    const key = `${sc.name}\u0000${sc.version ?? ''}\u0000${sc.schemaUrl ?? ''}`;
    let g = r.scopes.get(key);
    if (!g) r.scopes.set(key, (g = { scope: sc, spans: [] }));
    g.spans.push(s);
  }
  return JSON.stringify({
    resourceSpans: [...byResource.values()].map((r) => ({
      resource: { attributes: keyValues(r.attrs) },
      scopeSpans: [...r.scopes.values()].map((g) => ({
        scope: { name: g.scope.name, ...(g.scope.version ? { version: g.scope.version } : {}) },
        ...(g.scope.schemaUrl ? { schemaUrl: g.scope.schemaUrl } : {}),
        spans: g.spans.map(spanJson),
      })),
    })),
  });
}
