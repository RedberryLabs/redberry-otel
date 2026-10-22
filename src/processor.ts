// RedberryProcessor: an OpenTelemetry SpanProcessor that, per trace (one request), collects the spans,
// decides when the run is over, and then (inside waitUntil, with tracing suppressed):
//
//   canonical JSON -> deterministic gzip -> SHA-256 -> store.put -> signed hash report -> pricing sample
//
// The finish rule is the spike's (131 of 131 surviving traces finalised correctly): the local root span
// has ended, no span of the trace is open, and nothing new started for ``graceMs``. Escape hatches cut a
// trace short and still store and report it: ``hardStopMs`` after the root ended, the function deadline
// (``deadlineMs``), and ``shutdown()``. A run killed outright (maxDuration reached before the deadline
// timer fires, a crash of the instance) is still lost: nothing in-process survives a hard kill.
import { context, createContextKey, ROOT_CONTEXT, type Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { getDeadline, waitUntil } from '@vercel/functions';
import { isAgentId, resolveAgent } from './agents';
import { resolveConfig, type RedberryOptions, type ResolvedConfig } from './config';
import { loadSigner, type Signer } from './crypto';
import { buildEnvelope, encodeTrace, storagePath, type CutReason, type Finish } from './envelope';
import { sendReport, uploadSample, type ReportBody, type ReportOutcome, type SampleOutcome } from './report';
import { isAiSpan, parentSpanId, spanToJson } from './span';
import { StoreConflictError, type StoreKind } from './stores/types';

// The key @opentelemetry/core's suppressTracing() sets (createContextKey is Symbol.for(description)):
// our own Blob, GCS and VALP fetches must not add spans to the trace just hashed, or start new ones.
const SUPPRESS_TRACING_KEY = createContextKey('OpenTelemetry SDK Context Key SUPPRESS_TRACING');

const REMEMBERED = 10_000;

interface TraceState {
  traceId: string;
  ended: ReadableSpan[];
  open: Map<string, Span>;
  started: Set<string>;
  rootId?: string;
  root?: Span;
  rootEnded: boolean;
  firstStartMs: number;
  droppedSpans: number;
  graceResets: number;
  grace?: ReturnType<typeof setTimeout>;
  hardStop?: ReturnType<typeof setTimeout>;
  deadline?: ReturnType<typeof setTimeout>;
  resolve: () => void;
}

export interface TraceResult {
  traceId: string;
  finish: Finish;
  cutReason: CutReason | null;
  /** Set when the trace was not hashed: no AI SDK span, or no agent for it. */
  skipped?: 'no_ai_spans' | 'no_agent';
  agentId?: string;
  spanCount?: number;
  sha256?: string;
  size?: number;
  path?: string;
  store?: StoreKind;
  stored?: boolean;
  storeError?: string;
  report?: ReportOutcome;
  sample?: SampleOutcome;
  /** The stored bytes (gzip of the canonical JSON). */
  bytes?: Uint8Array;
}

export interface RedberryStats {
  enabled: boolean;
  disabledReason?: string;
  openTraces: number;
  traces: number;
  complete: number;
  cutShort: number;
  skippedNoAiSpans: number;
  skippedNoAgent: number;
  droppedTraces: number;
  droppedSpans: number;
  lateSpans: number;
  stored: number;
  storeFailed: number;
  recorded: number;
  duplicates: number;
  refused: number;
  reportFailed: number;
  samples: number;
  samplesFailed: number;
}

type Counter = Exclude<keyof RedberryStats, 'enabled' | 'disabledReason' | 'openTraces'>;

function remember(set: Set<string>, id: string): void {
  set.add(id);
  if (set.size > REMEMBERED) set.delete(set.values().next().value as string);
}

export class RedberryProcessor implements SpanProcessor {
  private readonly cfg: ResolvedConfig;
  private readonly traces = new Map<string, TraceState>();
  private readonly finalised = new Set<string>();
  private readonly ignored = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();
  private signer?: Promise<Signer>;
  private readonly counts: Record<Counter, number> = {
    traces: 0, complete: 0, cutShort: 0, skippedNoAiSpans: 0, skippedNoAgent: 0, droppedTraces: 0,
    droppedSpans: 0, lateSpans: 0, stored: 0, storeFailed: 0, recorded: 0, duplicates: 0, refused: 0,
    reportFailed: 0, samples: 0, samplesFailed: 0,
  };

  constructor(options: RedberryOptions = {}) {
    this.cfg = resolveConfig(options);
  }

  stats(): RedberryStats {
    return {
      enabled: this.cfg.enabled,
      ...(this.cfg.disabledReason ? { disabledReason: this.cfg.disabledReason } : {}),
      openTraces: this.traces.size,
      ...this.counts,
    };
  }

  onStart(span: Span, _parentContext?: Context): void {
    if (!this.cfg.enabled) return;
    const sc = span.spanContext();
    const tid = sc.traceId;
    if (this.ignored.has(tid)) return;
    if (this.finalised.has(tid)) {
      this.counts.lateSpans++;
      this.cfg.logger.debug?.(`span "${span.name}" started after trace ${tid} was finalised`);
      return;
    }
    let t = this.traces.get(tid);
    if (!t) {
      if (this.traces.size >= this.cfg.maxTraces) {
        this.counts.droppedTraces++;
        remember(this.ignored, tid);
        return;
      }
      t = this.open(tid);
    }
    if (t.started.size >= this.cfg.maxSpansPerTrace) {
      t.droppedSpans++;
      this.counts.droppedSpans++;
      return;
    }
    const parent = parentSpanId(span);
    if (!t.rootId && (!parent || !t.started.has(parent))) {
      t.rootId = sc.spanId;
      t.root = span;
    }
    t.started.add(sc.spanId);
    t.open.set(sc.spanId, span);
    if (t.grace) {
      clearTimeout(t.grace);
      t.grace = undefined;
      t.graceResets++;
    }
  }

  onEnd(span: ReadableSpan): void {
    if (!this.cfg.enabled) return;
    const sc = span.spanContext();
    const tid = sc.traceId;
    if (this.finalised.has(tid)) {
      this.counts.lateSpans++;
      return;
    }
    const t = this.traces.get(tid);
    if (!t || !t.open.has(sc.spanId)) return; // not ours: ignored, dropped, or started before we were
    t.open.delete(sc.spanId);
    t.ended.push(span);
    if (sc.spanId === t.rootId) {
      t.rootEnded = true;
      t.hardStop = timer(() => this.finalise(tid, 'hard_stop'), this.cfg.hardStopMs);
    }
    if (t.rootEnded && t.open.size === 0) {
      if (t.grace) clearTimeout(t.grace);
      t.grace = timer(() => {
        if (t.open.size === 0) this.finalise(tid, null);
      }, this.cfg.graceMs);
    }
  }

  /** Waits for traces already being stored and reported; it does not cut open traces short. */
  async forceFlush(): Promise<void> {
    // @vercel/otel calls forceFlush when each request's root span ends, so finalising here would hash
    // every trace before its grace period, and before streamed AI spans finish.
    await Promise.allSettled([...this.inflight]);
  }

  /** Cuts every open trace short (cut_reason "shutdown"), then waits for all of them. */
  async shutdown(): Promise<void> {
    for (const tid of [...this.traces.keys()]) this.finalise(tid, 'shutdown');
    await this.forceFlush();
  }

  // ── per trace ────────────────────────────────────────────────────────────────────────────

  private open(tid: string): TraceState {
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const t: TraceState = {
      traceId: tid, ended: [], open: new Map(), started: new Set(), rootEnded: false,
      firstStartMs: Date.now(), droppedSpans: 0, graceResets: 0, resolve,
    };
    this.traces.set(tid, t);
    this.counts.traces++;
    try {
      // Keeps the function alive until this trace is stored and reported (no-op outside Vercel).
      waitUntil(done);
    } catch (e) {
      this.cfg.logger.debug?.('waitUntil unavailable', e);
    }
    if (this.cfg.deadlineMs !== undefined) {
      let at = t.firstStartMs + this.cfg.deadlineMs;
      try {
        const vercel = getDeadline();
        if (vercel && vercel.getTime() < at) at = vercel.getTime();
      } catch {
        // not in a Vercel request
      }
      t.deadline = timer(() => this.finalise(tid, 'deadline'), Math.max(0, at - this.cfg.deadlineMarginMs - Date.now()));
    }
    return t;
  }

  /** ``reason`` null: the finish rule held. Otherwise an escape hatch fired. */
  private finalise(tid: string, reason: CutReason | null): void {
    const t = this.traces.get(tid);
    if (!t) return;
    this.traces.delete(tid);
    remember(this.finalised, tid);
    for (const h of [t.grace, t.hardStop, t.deadline]) if (h) clearTimeout(h);
    const finish: Finish = t.rootEnded && t.open.size === 0 ? 'complete' : 'cut_short';
    const cutAtMs = Date.now();
    this.counts[finish === 'complete' ? 'complete' : 'cutShort']++;
    const suppressed = ROOT_CONTEXT.setValue(SUPPRESS_TRACING_KEY, true);
    const work = context
      .with(suppressed, () => this.process(t, finish, finish === 'complete' ? null : reason, cutAtMs))
      .then(
        (r) => this.cfg.onResult?.(r),
        (e: unknown) => this.cfg.logger.error(`trace ${tid}: ${String(e)}`),
      )
      .finally(() => {
        this.inflight.delete(work);
        t.resolve();
      });
    this.inflight.add(work);
  }

  private async process(t: TraceState, finish: Finish, cutReason: CutReason | null, cutAtMs: number): Promise<TraceResult> {
    const base: TraceResult = { traceId: t.traceId, finish, cutReason };
    const spans = [
      ...t.ended.map((s) => spanToJson(s)),
      ...[...t.open.values()].map((s) => spanToJson(s, true)),
    ];
    if (this.cfg.requireAiSpans && !spans.some(isAiSpan)) {
      this.counts.skippedNoAiSpans++;
      return { ...base, skipped: 'no_ai_spans', spanCount: spans.length };
    }
    const agentId = resolveAgent(t.root?.attributes ?? {}, this.cfg.agentsByRoute, this.cfg.agentId);
    if (!agentId || !isAgentId(agentId)) {
      this.counts.skippedNoAgent++;
      this.cfg.logger.warn(`trace ${t.traceId}: no agent for route ${String(t.root?.attributes?.['http.route'] ?? t.root?.name ?? '?')}; not hashed`);
      return { ...base, skipped: 'no_agent', spanCount: spans.length };
    }
    const first = (t.root ?? t.ended[0]) as (ReadableSpan & { resource?: { attributes?: Record<string, unknown> } }) | undefined;
    const envelope = buildEnvelope({
      agentId,
      traceId: t.traceId,
      finish,
      cutReason,
      ...(finish === 'cut_short' ? { cutAtMs } : {}),
      resource: (first?.resource?.attributes ?? {}) as ReadableSpan['attributes'],
      spans,
      droppedSpans: t.droppedSpans,
    });
    const encoded = await encodeTrace(envelope);
    const path = storagePath(envelope);
    const store = this.cfg.store!;
    const result: TraceResult = {
      ...base, agentId, spanCount: spans.length, sha256: encoded.sha256, size: encoded.size, path,
      store: store.kind, bytes: encoded.gz,
    };

    try {
      await store.put(path, encoded.gz, { agentId, traceId: t.traceId, sha256: encoded.sha256, size: encoded.size });
      result.stored = true;
      this.counts.stored++;
    } catch (e) {
      result.stored = false;
      result.storeError = e instanceof StoreConflictError ? e.message : String((e as Error)?.message ?? e);
      this.counts.storeFailed++;
      this.cfg.logger.error(`trace ${t.traceId}: not stored (${store.kind}): ${result.storeError}`);
    }

    const body: ReportBody = {
      v: 1, agent_id: agentId, trace_id: t.traceId, sha256: encoded.sha256, size: encoded.size,
      started_at: envelope.started_at, ended_at: envelope.ended_at, stored: result.stored === true,
      store: store.kind, leaf_kind: 'stored-bytes',
    };
    let signer: Signer;
    try {
      signer = await (this.signer ??= loadSigner(this.cfg.signingKey, this.cfg.keyId));
    } catch (e) {
      this.counts.reportFailed++;
      result.report = { outcome: 'failed', status: null, attempts: 0, error: `signing key: ${String((e as Error)?.message ?? e)}` };
      this.cfg.logger.error(`trace ${t.traceId}: not reported: ${result.report.error}`);
      return result;
    }
    const report = await sendReport({
      url: this.cfg.url, token: this.cfg.token, signer, body,
      ...(this.cfg.fetch ? { fetch: this.cfg.fetch } : {}),
      ...(this.cfg.retryDelaysMs ? { retryDelaysMs: this.cfg.retryDelaysMs } : {}),
    });
    result.report = report;
    if (report.outcome === 'recorded') this.counts.recorded++;
    else if (report.outcome === 'duplicate') this.counts.duplicates++;
    else if (report.outcome === 'refused' || report.outcome === 'failed') {
      this.counts[report.outcome === 'refused' ? 'refused' : 'reportFailed']++;
      this.cfg.logger.error(`trace ${t.traceId}: hash report ${report.outcome} after ${report.attempts} attempt(s): ${report.error}`);
    }

    if ((report.outcome === 'recorded' || report.outcome === 'duplicate') && report.sample) {
      result.sample = await uploadSample(report.sample, encoded.gz, this.cfg.fetch, this.cfg.retryDelaysMs);
      if (result.sample.ok) this.counts.samples++;
      else {
        this.counts.samplesFailed++;
        this.cfg.logger.warn(`trace ${t.traceId}: pricing sample not uploaded: ${result.sample.error}`);
      }
    }
    this.cfg.logger.debug?.(
      `trace ${t.traceId} ${finish}${cutReason ? `/${cutReason}` : ''} agent=${agentId} spans=${spans.length} ` +
        `sha256=${encoded.sha256.slice(0, 16)} stored=${result.stored} report=${report.outcome}`,
    );
    return result;
  }
}

function timer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const h = setTimeout(fn, ms);
  (h as { unref?: () => void }).unref?.();
  return h;
}
