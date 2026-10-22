// withRedberry and registerRedberry: an Azure Functions invocation as one trace, stored and reported before
// the wrapper returns.
import { context, SpanKind, trace, type Span } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { gunzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedberryOptions } from '../src/config';
import { registerRedberry } from '../src/node';
import { RedberryProcessor, type TraceResult } from '../src/processor';
import { withRedberry } from '../src/wrap';
import type { PutMeta, Store } from '../src/stores/types';
import { AGENT, AGENT_B, azureEnv, fakeFetch, json, withEnv } from './helpers';

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let restoreEnv: () => void;

/** A store whose put takes ``ms`` (or never settles), recording each write. */
function slowStore(ms: number | 'never') {
  const puts: { path: string; bytes: Uint8Array; meta: PutMeta }[] = [];
  const store: Store = {
    kind: 'azure-blob',
    async put(path, bytes, meta) {
      await (ms === 'never' ? new Promise(() => {}) : sleep(ms));
      puts.push({ path, bytes, meta });
      return {};
    },
  };
  return { store, puts };
}

/** The global set-up registerRedberry makes, with a processor of the test's own. */
function install(o: RedberryOptions = {}, storeMs: number | 'never' = 30) {
  const results: TraceResult[] = [];
  const { store, puts } = slowStore(storeMs);
  const f = fakeFetch(async () => (await sleep(10), json(201, { leaf: 'l', window_start: 'w' })));
  const p = new RedberryProcessor({ store, fetch: f, retryDelaysMs: [1, 1], logger: silent, graceMs: 60_000, ...o, onResult: (r) => results.push(r) });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [p] }));
  return { p, results, puts, fetch: f };
}

/** What the AI SDK's OpenTelemetry integration does: spans from the global tracer under context.active(). */
async function generateText(): Promise<string> {
  const tracer = trace.getTracer('gen_ai');
  const root = tracer.startSpan('invoke_agent refund', { attributes: { 'gen_ai.operation.name': 'invoke_agent' } });
  await sleep(1);
  const chat = tracer.startSpan('chat gpt', { attributes: { 'gen_ai.operation.name': 'chat' } }, trace.setSpan(context.active(), root));
  await sleep(1);
  chat.end();
  root.end();
  return 'refund approved';
}

const request = { method: 'POST', url: 'https://refund-agent-app.azurewebsites.net/api/refund?code=function-key', headers: new Headers() };
const invocation = { invocationId: 'c0ffee00-0000-4000-8000-000000000001', functionName: 'refund', options: { trigger: { type: 'httpTrigger' } } };

const stored = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(gunzipSync(bytes)));

beforeEach(() => {
  restoreEnv = withEnv(azureEnv());
});
afterEach(() => {
  restoreEnv();
  trace.disable();
  context.disable();
  vi.restoreAllMocks();
});

describe('withRedberry', () => {
  it('returns the handler\'s response only after the run is stored and reported, without the grace period', async () => {
    const { results, puts, fetch } = install();
    const response = { status: 200, jsonBody: { ok: true } };
    const handler = withRedberry(async (req: typeof request, ctx: typeof invocation) => {
      expect(ctx.functionName).toBe('refund');
      expect(req.method).toBe('POST');
      await generateText();
      return response;
    }, { agentId: AGENT_B });

    const started = Date.now();
    expect(await handler(request, invocation)).toBe(response);
    expect(Date.now() - started).toBeLessThan(5_000); // graceMs is 60 s: the wrapper finalised at once
    expect(puts).toHaveLength(1);
    expect(fetch.calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ finish: 'complete', agentId: AGENT_B, stored: true, store: 'azure-blob', report: { outcome: 'recorded' } });
    expect(fetch.calls[0]!.url).toBe(`https://valp.test/v1/agents/${AGENT_B}/hashes`);

    // One trace: the invocation's root, with the AI SDK's spans under it.
    const doc = stored(puts[0]!.bytes);
    const byName = Object.fromEntries(doc.spans.map((s: { name: string }) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual(['chat gpt', 'invoke_agent refund', 'refund']);
    const root = byName['refund'];
    expect(root.parentSpanId).toBeNull();
    expect(root.kind).toBe(SpanKind.SERVER);
    expect(root.scope.name).toBe('@redberrylabs/otel');
    expect(root.attributes).toMatchObject({
      'faas.name': 'refund', 'faas.invocation_id': invocation.invocationId, 'faas.trigger': 'http',
      'http.request.method': 'POST', 'url.path': '/api/refund', 'http.response.status_code': 200, 'redberry.agent_id': AGENT_B,
    });
    expect(JSON.stringify(doc)).not.toContain('function-key'); // the query string (function keys) is not recorded
    expect(byName['invoke_agent refund'].parentSpanId).toBe(root.spanId);
    expect(byName['chat gpt'].parentSpanId).toBe(byName['invoke_agent refund'].spanId);
  });

  it('uses the configured agent when the wrapper names none', async () => {
    const { results } = install();
    await withRedberry(generateText)();
    expect(results[0]).toMatchObject({ agentId: AGENT, stored: true });
  });

  it('rethrows the handler\'s error after the flush, and records it on the root', async () => {
    const { results, puts } = install();
    const handler = withRedberry(async () => {
      await generateText();
      throw new Error('model refused');
    });
    const err = await handler().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('model refused');
    expect(results).toHaveLength(1);
    const root = stored(puts[0]!.bytes).spans.find((s: { parentSpanId: string | null }) => s.parentSpanId === null);
    expect(root.status).toEqual({ code: 2, message: 'model refused' });
    expect(root.events[0].name).toBe('exception');
  });

  it('waits at most flushTimeoutMs for a slow store, then returns and finishes in the background', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { results } = install({}, 'never');
    const started = Date.now();
    expect(await withRedberry(generateText, { flushTimeoutMs: 50 })()).toBe('refund approved');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(results).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith('[redberry]', expect.stringMatching(/not stored and reported within 50 ms/));
  });

  it('does not hold a streamed response: spans still open are finalised, without grace, when they end', async () => {
    const { results } = install();
    let streaming: Span | undefined;
    const handler = withRedberry(async () => {
      streaming = trace.getTracer('gen_ai').startSpan('chat gpt', { attributes: { 'gen_ai.operation.name': 'chat' } });
      return { status: 200, body: 'stream' };
    });
    const started = Date.now();
    await handler();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(results).toHaveLength(0);
    streaming!.end();
    await vi.waitFor(() => expect(results).toHaveLength(1), { timeout: 2_000 });
    expect(results[0]).toMatchObject({ finish: 'complete', spanCount: 2 });
  });

  it('just runs the handler, with its this and arguments, when nothing is registered', async () => {
    const self = { tag: 'svc' };
    const handler = withRedberry(async function (this: typeof self, a: number, b: number) {
      return `${this.tag}:${a + b}`;
    });
    expect(await handler.call(self, 2, 3)).toBe('svc:5');
    await expect(withRedberry(() => {
      throw new Error('sync');
    })()).rejects.toThrow('sync');
  });

  it('does nothing extra when the processor is disabled (REDBERRY_DISABLED=1)', async () => {
    restoreEnv();
    restoreEnv = withEnv(azureEnv({ REDBERRY_DISABLED: '1' }));
    const { p, results } = install();
    expect(await withRedberry(generateText)()).toBe('refund approved');
    expect(results).toHaveLength(0);
    expect(p.stats()).toMatchObject({ enabled: false, traces: 0 });
  });
});

describe('registerRedberry', () => {
  it('registers a provider and context manager once, so wrapped handlers are stored and reported', async () => {
    const puts: Uint8Array[] = [];
    const store: Store = { kind: 'azure-blob', put: async (_p, bytes) => (puts.push(bytes), {}) };
    const fetch = fakeFetch(() => json(201, {}));
    const p = registerRedberry({ store, fetch, logger: silent, serviceName: 'refund-agent' });
    expect(p).toBeInstanceOf(RedberryProcessor);
    expect(registerRedberry()).toBe(p);
    expect(p.stats().enabled).toBe(true);

    await withRedberry((_req: typeof request, _ctx: typeof invocation) => generateText(), { agentId: AGENT_B })(request, invocation);
    expect(puts).toHaveLength(1);
    expect(p.stats()).toMatchObject({ complete: 1, stored: 1, recorded: 1 });
    const doc = stored(puts[0]!);
    expect(doc.resource).toMatchObject({
      'service.name': 'refund-agent', 'cloud.provider': 'azure', 'cloud.platform': 'azure.functions', 'telemetry.sdk.language': 'nodejs',
    });
    expect(doc.spans).toHaveLength(3);
  });
});
