// discoveryFailureMarker: for an hour after the exporter recovers from a discovery failure, marks each new span
// ``redberry.sdk.discovery_failure`` = "<code>;<minutes>", so the install learns that, and for how long, the
// agent could not send. init() adds it; with @vercel/otel, add it beside redberryExporter().
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { DISCOVERY_FAILURE_ATTRIBUTE, type RedberryExporter } from './exporter';

export function discoveryFailureMarker(exporter: Pick<RedberryExporter, 'recentRecovery'>): SpanProcessor {
  return {
    onStart(span: Span, _parent: Context) {
      try {
        const r = exporter.recentRecovery();
        if (r) span.setAttribute(DISCOVERY_FAILURE_ATTRIBUTE, `${r.code};${r.minutes}`);
      } catch {
        // never fail a span over a marker
      }
    },
    onEnd(_span: ReadableSpan) {},
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}
