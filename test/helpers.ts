// Test doubles: a minimal span that satisfies what RedberryProcessor and spanToJson read, a fake VALP,
// and a recording store.
import type { Attributes, HrTime } from '@opentelemetry/api';
import type { ReadableSpan, Span } from '@opentelemetry/sdk-trace-base';
import { vi } from 'vitest';
import vector from './vectors/signature.json';
import type { PutMeta, Store, StoreKind } from '../src/stores/types';

export const AGENT = 'AGT-01K5V8QJ3M7XW2ZB4YRNCDEFGH';
export const AGENT_B = 'AGT-01K5V8QJ3M7XW2ZB4YRNCDEFGK';
export const TOKEN = 'ab'.repeat(32);
export const URL_ = 'https://valp.test';
export const SIGNING_KEY = vector.signing_key_pkcs8_b64;
export const KEY_ID = vector.key_id;
export const PUBLIC_KEY_HEX = vector.public_key_hex;

export const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

let clock = 1_792_595_658_000; // ms; advanced per span start so start order is the call order
export const hr = (ms: number): HrTime => [Math.floor(ms / 1000), (ms % 1000) * 1_000_000];

export interface FakeSpan extends ReadableSpan {
  end(): void;
  setAttribute(k: string, v: unknown): void;
}

export function fakeSpan(o: {
  traceId: string;
  spanId: string;
  parent?: string;
  name?: string;
  attributes?: Attributes;
  scope?: string;
  startMs?: number;
}): FakeSpan & Span {
  const start = o.startMs ?? (clock += 1);
  const s = {
    name: o.name ?? o.spanId,
    kind: 0,
    attributes: { ...(o.attributes ?? {}) } as Attributes,
    startTime: hr(start),
    endTime: [0, 0] as HrTime,
    status: { code: 0 },
    events: [],
    links: [],
    resource: { attributes: { 'service.name': 'test' } },
    instrumentationScope: { name: o.scope ?? 'next.js' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    duration: [0, 0] as HrTime,
    ended: false,
    parentSpanContext: o.parent ? { traceId: o.traceId, spanId: o.parent, traceFlags: 1 } : undefined,
    spanContext: () => ({ traceId: o.traceId, spanId: o.spanId, traceFlags: 1 }),
    end() {
      s.endTime = hr((clock += 1));
      s.ended = true;
    },
    setAttribute(k: string, v: unknown) {
      (s.attributes as Record<string, unknown>)[k] = v;
    },
  };
  return s as unknown as FakeSpan & Span;
}

export const aiAttrs = (op = 'chat'): Attributes => ({ 'gen_ai.operation.name': op });

/** A recording store; ``fail`` makes put throw. */
export function memoryStore(kind: StoreKind = 'vercel-blob', fail?: Error): Store & { puts: { path: string; bytes: Uint8Array; meta: PutMeta }[] } {
  const puts: { path: string; bytes: Uint8Array; meta: PutMeta }[] = [];
  return {
    kind,
    puts,
    async put(path, bytes, meta) {
      if (fail) throw fail;
      puts.push({ path, bytes, meta });
      return { url: `mem://${path}` };
    },
  };
}

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** A fetch that answers from a queue (or a function) and records every call. */
export function fakeFetch(answer: (c: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = init?.body === undefined || init.body === null
      ? new Uint8Array()
      : typeof init.body === 'string'
        ? new TextEncoder().encode(init.body)
        : new Uint8Array(init.body as ArrayBuffer);
    const c: Call = { url: String(input), method: init?.method ?? 'GET', headers, body };
    calls.push(c);
    return answer(c, calls.length);
  });
  return Object.assign(fn as unknown as typeof fetch, { calls });
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const productionEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  VERCEL_ENV: 'production',
  REDBERRY_URL: URL_,
  REDBERRY_PROJECT_TOKEN: TOKEN,
  REDBERRY_SIGNING_KEY: SIGNING_KEY,
  REDBERRY_AGENT_ID: AGENT,
  ...extra,
});

/** Set process.env for one test; returns a restore function. */
export function withEnv(env: Record<string, string | undefined>): () => void {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('REDBERRY_') || k === 'VERCEL_ENV' || k === 'NEXT_RUNTIME') delete process.env[k];
  Object.assign(process.env, env);
  return () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  };
}
