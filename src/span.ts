// ReadableSpan -> the span object pinned in SPEC.md §2 (OTLP/JSON field names, nanosecond times as
// decimal strings), plus the ordering and classification helpers the processor needs.
import type { Attributes, HrTime } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

export interface SpanJson {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  /** null for a span still open when the trace was cut short. */
  endTimeUnixNano: string | null;
  attributes: Attributes;
  status: { code: number; message: string | null };
  events: { name: string; timeUnixNano: string; attributes: Attributes; droppedAttributesCount: number }[];
  links: { traceId: string; spanId: string; attributes: Attributes; droppedAttributesCount: number }[];
  scope: { name: string; version: string | null; schemaUrl: string | null };
  dropped: { attributes: number; events: number; links: number };
}

/** HrTime [seconds, nanoseconds] -> decimal nanoseconds since the epoch. */
export const hrToNs = (t: HrTime): string => (BigInt(t[0]) * 1_000_000_000n + BigInt(t[1])).toString();

/** Decimal nanoseconds -> ISO-8601 UTC with milliseconds (``YYYY-MM-DDTHH:MM:SS.mmmZ``), truncated. */
export const nsToIso = (ns: string): string => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();

type AnySpan = ReadableSpan & {
  parentSpanId?: string; // @opentelemetry/sdk-trace-base 1.x
  instrumentationLibrary?: { name: string; version?: string; schemaUrl?: string }; // 1.x
};

export function parentSpanId(s: ReadableSpan): string | undefined {
  const a = s as AnySpan;
  return a.parentSpanContext?.spanId ?? a.parentSpanId ?? undefined;
}

export function spanToJson(s: ReadableSpan, open = false): SpanJson {
  const a = s as AnySpan;
  const sc = s.spanContext();
  const scope = a.instrumentationScope ?? a.instrumentationLibrary ?? { name: '' };
  return {
    traceId: sc.traceId,
    spanId: sc.spanId,
    parentSpanId: parentSpanId(s) ?? null,
    name: s.name,
    kind: s.kind,
    startTimeUnixNano: hrToNs(s.startTime),
    endTimeUnixNano: open ? null : hrToNs(s.endTime),
    attributes: { ...s.attributes },
    status: { code: s.status.code, message: s.status.message || null },
    events: s.events.map((e) => ({
      name: e.name,
      timeUnixNano: hrToNs(e.time),
      attributes: { ...(e.attributes ?? {}) },
      droppedAttributesCount: e.droppedAttributesCount ?? 0,
    })),
    links: s.links.map((l) => ({
      traceId: l.context.traceId,
      spanId: l.context.spanId,
      attributes: { ...(l.attributes ?? {}) },
      droppedAttributesCount: l.droppedAttributesCount ?? 0,
    })),
    scope: { name: scope.name, version: scope.version ?? null, schemaUrl: scope.schemaUrl ?? null },
    dropped: {
      attributes: s.droppedAttributesCount ?? 0,
      events: s.droppedEventsCount ?? 0,
      links: s.droppedLinksCount ?? 0,
    },
  };
}

/** SPEC.md §2.2: by start time (numerically), then span id. */
export function sortSpans(spans: SpanJson[]): SpanJson[] {
  return [...spans].sort((a, b) => {
    const x = BigInt(a.startTimeUnixNano);
    const y = BigInt(b.startTimeUnixNano);
    if (x !== y) return x < y ? -1 : 1;
    return a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0;
  });
}

/** An AI SDK span: GenAI semantic conventions (``@ai-sdk/otel`` OpenTelemetry) or the legacy ``ai.*`` shape. */
export function isAiSpan(s: SpanJson): boolean {
  return (
    s.name.startsWith('ai.') ||
    'gen_ai.operation.name' in s.attributes ||
    s.scope.name === 'ai' ||
    s.scope.name === 'gen_ai'
  );
}
