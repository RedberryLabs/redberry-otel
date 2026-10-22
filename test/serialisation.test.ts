import canonicalize from 'canonicalize';
import { gunzipSync } from 'fflate';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { gunzipSync as nodeGunzip } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { canonicalJson, deterministicGzip } from '../src/canonical';
import { unb64, hex } from '../src/encoding';
import { buildEnvelope, encodeTrace, storagePath, type EnvelopeInput } from '../src/envelope';
import { isAiSpan, sortSpans, spanToJson } from '../src/span';
import { VERSION } from '../src/version';
import pkg from '../package.json';
import { fakeSpan } from './helpers';

const DIR = join(import.meta.dirname, 'vectors');
const vectors = readdirSync(DIR)
  .filter((f) => /^v\d+-.*\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as {
    name: string;
    input: EnvelopeInput;
    expected: { canonical: string; gzip_base64: string; sha256: string; size: number };
  });

describe('golden vectors (SPEC.md §7)', () => {
  it('has the pinned vectors', () => {
    expect(vectors.map((v) => v.name).sort()).toEqual(['v1-edge-cases', 'v1-minimal', 'v1-spike-refund-run']);
  });

  for (const v of vectors) {
    describe(v.name, () => {
      it('serialises to exactly the pinned canonical JSON, gzip bytes, hash and size', async () => {
        const e = await encodeTrace(buildEnvelope(v.input));
        expect(new TextDecoder().decode(e.json)).toBe(v.expected.canonical);
        expect(hex(e.gz)).toBe(hex(unb64(v.expected.gzip_base64)));
        expect(e.sha256).toBe(v.expected.sha256);
        expect(e.size).toBe(v.expected.size);
      });

      it('is RFC 8785 (JCS) JSON, per an independent implementation', () => {
        expect(canonicalize(JSON.parse(v.expected.canonical))).toBe(v.expected.canonical);
      });

      it('gzip header is fixed (mtime 0, no name, OS 3) and gunzips (fflate and zlib) to the canonical JSON', () => {
        const gz = unb64(v.expected.gzip_base64);
        expect(hex(gz.slice(0, 10))).toBe('1f8b0800000000000003');
        expect(new TextDecoder().decode(gunzipSync(gz))).toBe(v.expected.canonical);
        expect(nodeGunzip(gz).toString('utf8')).toBe(v.expected.canonical);
        expect(createHash('sha256').update(gz).digest('hex')).toBe(v.expected.sha256);
      });

      it('does not depend on span or key insertion order', async () => {
        const shuffled: EnvelopeInput = {
          ...v.input,
          spans: [...v.input.spans].reverse().map((s) => Object.fromEntries(Object.entries(s).reverse()) as typeof s),
        };
        expect((await encodeTrace(buildEnvelope(shuffled))).sha256).toBe(v.expected.sha256);
      });
    });
  }
});

describe('canonicalJson', () => {
  it('sorts keys by UTF-16 code unit at every level, no whitespace', () => {
    expect(canonicalJson({ b: { y: 1, x: [{ d: 1, c: 2 }] }, a: null, '\ue000': 1, '\u{1f600}': 2 })).toBe(
      '{"a":null,"b":{"x":[{"c":2,"d":1}],"y":1},"\u{1f600}":2,"\ue000":1}',
    );
  });

  it('writes numbers in ECMAScript shortest form', () => {
    expect(canonicalJson([1, 1.0, -0, 0.1, 1e21, 1e-7, 2 ** 53, 123.456e-10])).toBe('[1,1,0,0.1,1e+21,1e-7,9007199254740992,1.23456e-8]');
  });

  it('turns values JSON cannot hold into pinned forms', () => {
    expect(canonicalJson({ a: NaN, b: Infinity, c: -Infinity, d: 10n, e: undefined, f: [undefined, 1] })).toBe(
      '{"a":"NaN","b":"Infinity","c":"-Infinity","d":"10","f":[null,1]}',
    );
  });

  it('escapes strings as JSON.stringify does (well-formed: lone surrogates escaped)', () => {
    expect(canonicalJson(['\u0000\b\t\n\f\r"\\/\u007f\u2028', '\ud800'])).toBe('["\\u0000\\b\\t\\n\\f\\r\\"\\\\/\u007f\u2028","\\ud800"]');
  });

  it('refuses binary values', () => {
    expect(() => canonicalJson({ a: new Uint8Array(2) })).toThrow(/binary/);
  });

  it('gzip is deterministic across calls', () => {
    const data = new TextEncoder().encode('{"a":1}'.repeat(500));
    expect(hex(deterministicGzip(data))).toBe(hex(deterministicGzip(data)));
  });
});

describe('spanToJson / envelope', () => {
  it('maps a ReadableSpan to the pinned span object', () => {
    const s = fakeSpan({ traceId: 't'.repeat(32), spanId: 's1', parent: 'p1', name: 'chat x', attributes: { a: 1 }, scope: 'gen_ai', startMs: 1000 });
    s.end();
    const j = spanToJson(s);
    expect(Object.keys(j).sort()).toEqual(
      ['attributes', 'dropped', 'endTimeUnixNano', 'events', 'kind', 'links', 'name', 'parentSpanId', 'scope', 'spanId', 'startTimeUnixNano', 'status', 'traceId'],
    );
    expect(j).toMatchObject({ parentSpanId: 'p1', startTimeUnixNano: '1000000000', status: { code: 0, message: null }, scope: { name: 'gen_ai', version: null, schemaUrl: null } });
    expect(spanToJson(s, true).endTimeUnixNano).toBeNull();
  });

  it('orders spans by start time numerically, then span id', () => {
    const mk = (spanId: string, start: string) => ({ ...spanToJson(fakeSpan({ traceId: 'a'.repeat(32), spanId })), startTimeUnixNano: start });
    const sorted = sortSpans([mk('b', '10'), mk('a', '10'), mk('c', '9'), mk('d', '100')]);
    expect(sorted.map((s) => s.spanId)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('recognises GenAI semconv and legacy ai.* spans', () => {
    const base = spanToJson(fakeSpan({ traceId: 'a'.repeat(32), spanId: 'x' }));
    expect(isAiSpan(base)).toBe(false);
    expect(isAiSpan({ ...base, name: 'ai.streamText' })).toBe(true);
    expect(isAiSpan({ ...base, attributes: { 'gen_ai.operation.name': 'chat' } })).toBe(true);
    expect(isAiSpan({ ...base, scope: { name: 'gen_ai', version: null, schemaUrl: null } })).toBe(true);
  });

  it('stamps the resolved agent on every span as redberry.agent_id, replacing any emitted value', () => {
    const v = vectors.find((x) => x.name === 'v1-spike-refund-run')!;
    const spans = v.input.spans.map((s, n) => (n === 0 ? { ...s, attributes: { ...s.attributes, 'redberry.agent_id': 'AGT-SPOOFED' } } : s));
    const e = buildEnvelope({ ...v.input, spans });
    expect(e.spans).toHaveLength(32);
    for (const s of e.spans) expect(s.attributes['redberry.agent_id']).toBe(v.input.agentId);
    for (const s of JSON.parse(v.expected.canonical).spans) expect(s.attributes['redberry.agent_id']).toBe(v.input.agentId);
  });

  it('derives started_at / ended_at and the storage path', () => {
    const v = vectors.find((x) => x.name === 'v1-minimal')!;
    const e = buildEnvelope(v.input);
    expect(e.started_at).toBe('2026-10-21T15:14:18.004Z');
    expect(e.ended_at).toBe('2026-10-21T15:14:19.744Z');
    expect(e.cut_reason).toBeNull();
    expect(storagePath(e)).toBe('redberry/AGT-01K5V8QJ3M7XW2ZB4YRNCDEFGH/2026-10-21/45e3cc173b7aae7a6e658021710f8848.json.gz');
  });

  it('records the package version as producer by default', () => {
    expect(VERSION).toBe(pkg.version);
    const v = vectors.find((x) => x.name === 'v1-minimal')!;
    const { producer: _p, ...rest } = v.input;
    expect(buildEnvelope(rest).producer).toEqual({ name: '@redberrylabs/otel', version: VERSION });
  });
});
