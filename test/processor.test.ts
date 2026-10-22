import { context, createContextKey, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { gunzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../src/crypto';
import { RedberryProcessor, type TraceResult } from '../src/processor';
import type { RedberryOptions } from '../src/config';
import type { Store } from '../src/stores/types';
import { AGENT, AGENT_B, aiAttrs, azureEnv, fakeFetch, fakeSpan, json, memoryStore, productionEnv, withEnv, type FakeSpan } from './helpers';

const GRACE = 2000;
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
let restoreEnv: () => void;
let traceSeq = 0;
const newTrace = () => (++traceSeq).toString(16).padStart(32, '0');
const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

beforeEach(() => {
  restoreEnv = withEnv(productionEnv());
});
afterEach(() => {
  restoreEnv();
  vi.useRealTimers();
  delete (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT];
});

function setup(o: RedberryOptions & { reply?: (n: number) => Response } = {}) {
  const results: TraceResult[] = [];
  const store = (o.store as ReturnType<typeof memoryStore>) ?? memoryStore();
  const f = fakeFetch((_c, n) => (o.reply ? o.reply(n) : json(201, { leaf: 'l', window_start: 'w' })));
  const p = new RedberryProcessor({ fetch: f, retryDelaysMs: [1, 1], logger: silent, ...o, store, onResult: (r) => results.push(r) });
  return { p, results, store, fetch: f };
}

/** A request-shaped trace: root (next.js) -> invoke_agent -> chat, execute_tool; plus "start response". */
function tree(traceId = newTrace(), rootAttrs: Record<string, string> = { 'http.route': '/api/refund' }) {
  const root = fakeSpan({ traceId, spanId: 'r000000000000000', name: 'POST /api/refund', attributes: rootAttrs });
  const agent = fakeSpan({ traceId, spanId: 'a000000000000000', parent: root.spanContext().spanId, name: 'invoke_agent m', attributes: aiAttrs('invoke_agent'), scope: 'gen_ai' });
  const chat = fakeSpan({ traceId, spanId: 'c000000000000000', parent: 'a000000000000000', name: 'chat m', attributes: aiAttrs('chat'), scope: 'gen_ai' });
  const tool = fakeSpan({ traceId, spanId: 't000000000000000', parent: 'a000000000000000', name: 'execute_tool x', attributes: aiAttrs('execute_tool'), scope: 'gen_ai' });
  const resp = fakeSpan({ traceId, spanId: 's000000000000000', parent: root.spanContext().spanId, name: 'start response' });
  return { traceId, spans: [root, agent, chat, tool, resp] as FakeSpan[] };
}

const startAll = (p: RedberryProcessor, spans: FakeSpan[]) => spans.forEach((s) => p.onStart(s as never));
const end = (p: RedberryProcessor, s: FakeSpan) => {
  s.end();
  p.onEnd(s);
};

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
}

describe('finish rule: root ended + nothing open + grace', () => {
  it('finalises exactly once, only after the last span ends and the grace passes, for every end order (120)', async () => {
    vi.useFakeTimers();
    let checked = 0;
    for (const order of permutations([0, 1, 2, 3, 4])) {
      const { p, results } = setup();
      const { spans } = tree();
      startAll(p, spans);
      for (const i of order) {
        end(p, spans[i]!);
        await vi.advanceTimersByTimeAsync(GRACE - 1); // never enough on its own while anything is open
        if (i !== order[order.length - 1]) expect(results).toHaveLength(0);
      }
      expect(results).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await p.forceFlush();
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ finish: 'complete', cutReason: null, spanCount: 5, stored: true, report: { outcome: 'recorded' } });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(results).toHaveLength(1);
      checked++;
    }
    expect(checked).toBe(120);
  });

  it('holds for every interleaving of starts and ends (children may start after the root ended, as when streaming)', async () => {
    vi.useFakeTimers();
    // root R -> A -> B, and R -> C. A child starts after its parent starts; any span may end any time after it starts.
    const parents: Record<string, string | undefined> = { R: undefined, A: 'R', B: 'A', C: 'R' };
    type Ev = [kind: 's' | 'e', id: string];
    const sequences: Ev[][] = [];
    const walk = (seq: Ev[], started: Set<string>, ended: Set<string>) => {
      if (ended.size === 4) return void sequences.push(seq);
      for (const id of Object.keys(parents)) {
        const parent = parents[id];
        if (!started.has(id) && (!parent || started.has(parent))) walk([...seq, ['s', id]], new Set([...started, id]), ended);
        if (started.has(id) && !ended.has(id)) walk([...seq, ['e', id]], started, new Set([...ended, id]));
      }
    };
    walk([], new Set(), new Set());
    expect(sequences.length).toBeGreaterThan(100);
    for (const seq of sequences) {
      const { p, results } = setup();
      const traceId = newTrace();
      const spans: Record<string, FakeSpan> = {};
      for (const [kind, id] of seq) {
        if (kind === 's') {
          spans[id] = fakeSpan({ traceId, spanId: id.repeat(16), parent: parents[id]?.repeat(16), name: id, attributes: id === 'R' ? {} : aiAttrs() });
          p.onStart(spans[id] as never);
        } else end(p, spans[id]!);
        await vi.advanceTimersByTimeAsync(GRACE - 1);
        expect(results).toHaveLength(0);
      }
      await vi.advanceTimersByTimeAsync(1);
      await p.forceFlush();
      expect(results.map((r) => [r.finish, r.spanCount])).toEqual([['complete', 4]]);
    }
  });

  it('a span that starts inside the grace window resets it, and is included', async () => {
    vi.useFakeTimers();
    const { p, results } = setup();
    const { traceId, spans } = tree();
    startAll(p, spans);
    spans.forEach((s) => end(p, s));
    await vi.advanceTimersByTimeAsync(GRACE - 100);
    const late = fakeSpan({ traceId, spanId: 'l000000000000000', parent: 'a000000000000000', name: 'execute_tool late', attributes: aiAttrs('execute_tool') });
    p.onStart(late as never);
    await vi.advanceTimersByTimeAsync(GRACE * 3);
    expect(results).toHaveLength(0);
    end(p, late);
    await vi.advanceTimersByTimeAsync(GRACE);
    await p.forceFlush();
    expect(results).toHaveLength(1);
    expect(results[0]!.spanCount).toBe(6);
  });

  it('a span that starts after finalisation is counted late and ignored', async () => {
    vi.useFakeTimers();
    const { p, results } = setup();
    const { traceId, spans } = tree();
    startAll(p, spans);
    spans.forEach((s) => end(p, s));
    await vi.advanceTimersByTimeAsync(GRACE);
    await p.forceFlush();
    const late = fakeSpan({ traceId, spanId: 'l000000000000000', parent: 'r000000000000000' });
    p.onStart(late as never);
    end(p, late);
    await vi.advanceTimersByTimeAsync(GRACE * 2);
    expect(results).toHaveLength(1);
    expect(p.stats().lateSpans).toBe(2);
  });

  it('a child left open after the root ends is cut short at hardStopMs, open span included', async () => {
    vi.useFakeTimers();
    const { p, results } = setup({ hardStopMs: 30_000 });
    const { spans } = tree();
    startAll(p, spans);
    [0, 1, 2, 4].forEach((i) => end(p, spans[i]!)); // the tool span never ends
    await vi.advanceTimersByTimeAsync(29_999);
    expect(results).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await p.forceFlush();
    expect(results[0]).toMatchObject({ finish: 'cut_short', cutReason: 'hard_stop', spanCount: 5 });
    const doc = JSON.parse(new TextDecoder().decode(gunzipSync(results[0]!.bytes!)));
    expect(doc.finish).toBe('cut_short');
    expect(doc.spans.find((s: { spanId: string }) => s.spanId === 't000000000000000').endTimeUnixNano).toBeNull();
  });

  it('forceFlush (which @vercel/otel calls at every root end) does not finalise early', async () => {
    vi.useFakeTimers();
    const { p, results } = setup();
    const { spans } = tree();
    startAll(p, spans);
    end(p, spans[0]!);
    await p.forceFlush();
    spans.slice(1).forEach((s) => end(p, s));
    await p.forceFlush();
    expect(results).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(GRACE);
    await p.forceFlush();
    expect(results).toHaveLength(1);
  });

  it('shutdown cuts open traces short and finishes quiet ones as complete', async () => {
    const { p, results } = setup();
    const a = tree();
    const b = tree();
    startAll(p, [...a.spans, ...b.spans]);
    a.spans.forEach((s) => end(p, s)); // a: in its grace period
    end(p, b.spans[2]!); // b: still running
    await p.shutdown();
    const byTrace = Object.fromEntries(results.map((r) => [r.traceId, r]));
    expect(byTrace[a.traceId]).toMatchObject({ finish: 'complete', cutReason: null });
    expect(byTrace[b.traceId]).toMatchObject({ finish: 'cut_short', cutReason: 'shutdown', spanCount: 5 });
    expect(p.stats()).toMatchObject({ openTraces: 0, complete: 1, cutShort: 1 });
  });
});

describe('deadline', () => {
  it('cuts a still-running trace short deadlineMarginMs before deadlineMs, and still stores and reports it', async () => {
    vi.useFakeTimers();
    const { p, results, store, fetch } = setup({ deadlineMs: 60_000, deadlineMarginMs: 5_000 });
    const { spans } = tree();
    startAll(p, spans);
    end(p, spans[2]!);
    await vi.advanceTimersByTimeAsync(54_999);
    expect(results).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await p.forceFlush();
    expect(results[0]).toMatchObject({ finish: 'cut_short', cutReason: 'deadline', stored: true, report: { outcome: 'recorded' } });
    expect(store.puts).toHaveLength(1);
    const report = JSON.parse(new TextDecoder().decode(fetch.calls[0]!.body));
    const doc = JSON.parse(new TextDecoder().decode(gunzipSync(results[0]!.bytes!)));
    expect(doc).toMatchObject({ finish: 'cut_short', cut_reason: 'deadline' });
    expect(Date.parse(report.ended_at)).toBeGreaterThanOrEqual(Date.parse(report.started_at));
    // the spans that end after the cut are late, not a second report
    spans.forEach((s) => (s.ended ? undefined : end(p, s)));
    await vi.advanceTimersByTimeAsync(GRACE * 2);
    expect(results).toHaveLength(1);
  });

  it('uses Vercel\'s own invocation deadline when it is earlier', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = { get: () => ({ deadline: now + 15_000 }) };
    const { p, results } = setup({ deadlineMs: 300_000, deadlineMarginMs: 5_000 });
    startAll(p, tree().spans);
    await vi.advanceTimersByTimeAsync(10_000);
    await p.forceFlush();
    expect(results[0]).toMatchObject({ cutReason: 'deadline' });
  });

  it('does nothing to a trace that completes before it', async () => {
    vi.useFakeTimers();
    const { p, results } = setup({ deadlineMs: 60_000 });
    const { spans } = tree();
    startAll(p, spans);
    spans.forEach((s) => end(p, s));
    await vi.advanceTimersByTimeAsync(120_000);
    await p.forceFlush();
    expect(results).toHaveLength(1);
    expect(results[0]!.finish).toBe('complete');
  });

  it('is off unless set', async () => {
    vi.useFakeTimers();
    const { p, results } = setup();
    startAll(p, tree().spans);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(results).toHaveLength(0);
    expect(p.stats().openTraces).toBe(1);
  });
});

describe('filters', () => {
  async function run(o: RedberryOptions, rootAttrs?: Record<string, string>, ai = true) {
    const s = setup(o);
    const t = tree(newTrace(), rootAttrs);
    const spans = ai ? t.spans : [t.spans[0]!, t.spans[4]!];
    startAll(s.p, spans);
    spans.forEach((x) => end(s.p, x));
    await s.p.shutdown();
    return s;
  }

  it('skips a trace without AI SDK spans (no store, no report)', async () => {
    const { results, store, fetch, p } = await run({}, undefined, false);
    expect(results[0]).toMatchObject({ skipped: 'no_ai_spans' });
    expect(store.puts).toHaveLength(0);
    expect(fetch.calls).toHaveLength(0);
    expect(p.stats().skippedNoAiSpans).toBe(1);
  });

  it('hashes it anyway with requireAiSpans: false', async () => {
    expect((await run({ requireAiSpans: false }, undefined, false)).results[0]).toMatchObject({ stored: true, agentId: AGENT });
  });

  it('picks the agent from the route map against the root span', async () => {
    const { results, fetch } = await run({ agentsByRoute: { '/api/refund': AGENT_B } });
    expect(results[0]!.agentId).toBe(AGENT_B);
    const doc = JSON.parse(new TextDecoder().decode(gunzipSync(results[0]!.bytes!)));
    expect(new Set(doc.spans.map((s: { attributes: Record<string, unknown> }) => s.attributes['redberry.agent_id']))).toEqual(new Set([AGENT_B]));
    expect(fetch.calls[0]!.url).toBe(`https://valp.test/v1/agents/${AGENT_B}/hashes`);
  });

  it('skips and counts a trace with no agent', async () => {
    restoreEnv();
    restoreEnv = withEnv(productionEnv({ REDBERRY_AGENT_ID: '' }));
    const { results, store, p } = await run({ agentsByRoute: { '/api/other': AGENT_B } });
    expect(results[0]).toMatchObject({ skipped: 'no_agent' });
    expect(store.puts).toHaveLength(0);
    expect(p.stats().skippedNoAgent).toBe(1);
  });

  it('does nothing outside production', async () => {
    restoreEnv();
    restoreEnv = withEnv(productionEnv({ VERCEL_ENV: 'preview' }));
    const { results, p } = await run({});
    expect(results).toHaveLength(0);
    expect(p.stats()).toMatchObject({ enabled: false, traces: 0 });
  });

  it('caps open traces and spans per trace', async () => {
    const { p, results } = setup({ maxTraces: 1, maxSpansPerTrace: 3 });
    const a = tree();
    const b = tree();
    startAll(p, [...a.spans, ...b.spans]);
    [...a.spans, ...b.spans].forEach((s) => end(p, s));
    await p.shutdown();
    expect(results).toHaveLength(1);
    expect(results[0]!.spanCount).toBe(3);
    const doc = JSON.parse(new TextDecoder().decode(gunzipSync(results[0]!.bytes!)));
    expect(doc.dropped_spans).toBe(2);
    expect(p.stats()).toMatchObject({ droppedTraces: 1, droppedSpans: 2 });
  });
});

describe('pipeline', () => {
  it('stores the canonical gzip, reports its hash signed, stamps the agent id', async () => {
    const { p, results, store, fetch } = setup();
    const { traceId, spans } = tree();
    startAll(p, spans);
    spans.forEach((s) => end(p, s));
    await p.shutdown();
    const r = results[0]!;
    const put = store.puts[0]!;
    // The date is the run's start date (SPEC.md §5), not today's.
    expect(put.path).toMatch(new RegExp(`^redberry/${AGENT}/\\d{4}-\\d{2}-\\d{2}/${traceId}\\.json\\.gz$`));
    expect(put.meta).toEqual({ agentId: AGENT, traceId, sha256: r.sha256, size: r.size });
    expect(await sha256Hex(put.bytes)).toBe(r.sha256);
    const doc = JSON.parse(new TextDecoder().decode(gunzipSync(put.bytes)));
    expect(doc).toMatchObject({ schema: 'redberry.trace.v1', agent_id: AGENT, trace_id: traceId, finish: 'complete', resource: { 'service.name': 'test' } });
    expect(doc.spans).toHaveLength(5);
    expect(doc.spans.map((s: { attributes: Record<string, unknown> }) => s.attributes['redberry.agent_id'])).toEqual(Array(5).fill(AGENT));
    const report = JSON.parse(new TextDecoder().decode(fetch.calls[0]!.body));
    expect(report).toEqual({
      v: 1, agent_id: AGENT, trace_id: traceId, sha256: r.sha256, size: r.size, started_at: doc.started_at,
      ended_at: doc.ended_at, stored: true, store: 'vercel-blob', leaf_kind: 'stored-bytes',
    });
    expect(p.stats()).toMatchObject({ traces: 1, complete: 1, stored: 1, recorded: 1 });
  });

  it('reports stored: false when the store fails, and still reports', async () => {
    const { p, results, fetch } = setup({ store: memoryStore('vercel-blob', new Error('BlobServiceNotAvailable')) });
    const { spans } = tree();
    startAll(p, spans);
    spans.forEach((s) => end(p, s));
    await p.shutdown();
    expect(results[0]).toMatchObject({ stored: false, storeError: 'BlobServiceNotAvailable', report: { outcome: 'recorded' } });
    expect(JSON.parse(new TextDecoder().decode(fetch.calls[0]!.body)).stored).toBe(false);
    expect(p.stats().storeFailed).toBe(1);
  });

  it('uploads the pricing sample when VALP asks for one', async () => {
    const sample = { url: 'https://storage.googleapis.com/sample?sig', method: 'PUT', headers: { 'Content-Type': 'application/gzip' } };
    const { p, results, fetch } = setup({ reply: (n) => (n === 1 ? json(201, { leaf: 'l', window_start: 'w', sample }) : new Response(null, { status: 200 })) });
    const { spans } = tree();
    startAll(p, spans);
    spans.forEach((s) => end(p, s));
    await p.shutdown();
    expect(results[0]!.sample).toEqual({ ok: true, status: 200, existing: false });
    expect(fetch.calls[1]).toMatchObject({ url: sample.url, method: 'PUT', body: results[0]!.bytes });
    expect(p.stats().samples).toBe(1);
  });

  it('counts refusals and failures', async () => {
    for (const [status, counter] of [[403, 'refused'], [503, 'reportFailed']] as const) {
      const { p, results } = setup({ reply: () => json(status, {}) });
      const { spans } = tree();
      startAll(p, spans);
      spans.forEach((s) => end(p, s));
      await p.shutdown();
      expect(results[0]!.report!.outcome).toBe(status === 403 ? 'refused' : 'failed');
      expect(p.stats()[counter]).toBe(1);
    }
  });

  it('registers each trace with waitUntil once, resolving after store and report', async () => {
    const waited: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = { get: () => ({ waitUntil: (pr: Promise<unknown>) => waited.push(pr) }) };
    const { p, results } = setup({ graceMs: 5 });
    const { spans } = tree();
    startAll(p, spans);
    expect(waited).toHaveLength(1);
    spans.forEach((s) => end(p, s));
    await waited[0];
    expect(results).toHaveLength(1);
  });

  it('outside Vercel, does not use waitUntil: settle() finalises a quiet trace at once and resolves after store and report', async () => {
    restoreEnv();
    restoreEnv = withEnv(azureEnv());
    const waited: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = { get: () => ({ waitUntil: (pr: Promise<unknown>) => waited.push(pr) }) };
    const { p, results, store } = setup({ graceMs: 60_000 });
    const { traceId, spans } = tree();
    startAll(p, spans);
    expect(waited).toHaveLength(0);
    expect(p.settle(traceId)).toBeUndefined(); // still running: nothing to wait for yet
    spans.forEach((s) => end(p, s)); // ...and once the last span ends it is finalised without the grace period
    const done = p.settle(traceId);
    expect(done).toBeInstanceOf(Promise);
    expect(await done).toMatchObject({ traceId, finish: 'complete', stored: true, report: { outcome: 'recorded' } });
    expect(results).toHaveLength(1);
    expect(store.puts).toHaveLength(1);
    expect(p.settle('f'.repeat(32))).toBeUndefined();
  });

  it('runs store and report with tracing suppressed', async () => {
    // As @vercel/otel does: without a context manager, context.with is a no-op.
    const manager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(manager);
    const KEY = createContextKey('OpenTelemetry SDK Context Key SUPPRESS_TRACING');
    const seen: unknown[] = [];
    const store: Store = { kind: 'vercel-blob', put: async () => (seen.push(context.active().getValue(KEY)), {}) };
    const { p, spans } = { ...setup({ store }), spans: tree().spans };
    startAll(p, spans);
    spans.forEach((s) => end(p, s));
    await p.shutdown();
    context.disable();
    expect(seen).toEqual([true]);
  });

  it('works under a real OpenTelemetry tracer provider', async () => {
    const results: TraceResult[] = [];
    const store = memoryStore();
    const p = new RedberryProcessor({ store, graceMs: 20, fetch: fakeFetch(() => json(201, {})), logger: silent, onResult: (r) => results.push(r) });
    const tracer = new BasicTracerProvider({ spanProcessors: [p] }).getTracer('test');
    const root = tracer.startSpan('POST /api/refund', { attributes: { 'http.route': '/api/refund' } }, ROOT_CONTEXT);
    const agent = tracer.startSpan('invoke_agent m', { attributes: { 'gen_ai.operation.name': 'invoke_agent' } }, trace.setSpan(ROOT_CONTEXT, root));
    root.end();
    const tool = tracer.startSpan('execute_tool x', { attributes: { 'gen_ai.operation.name': 'execute_tool' } }, trace.setSpan(ROOT_CONTEXT, agent));
    tool.end();
    agent.end();
    await vi.waitFor(() => expect(results).toHaveLength(1), { timeout: 2000 });
    const doc = JSON.parse(new TextDecoder().decode(gunzipSync(store.puts[0]!.bytes)));
    const byName = Object.fromEntries(doc.spans.map((s: { name: string }) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual(['POST /api/refund', 'execute_tool x', 'invoke_agent m']);
    expect(byName['execute_tool x'].parentSpanId).toBe(byName['invoke_agent m'].spanId);
    expect(byName['invoke_agent m'].parentSpanId).toBe(byName['POST /api/refund'].spanId);
    expect(byName['POST /api/refund'].scope.name).toBe('test');
    expect(results[0]).toMatchObject({ finish: 'complete', agentId: AGENT });
  });
});
