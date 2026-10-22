// Writes the golden serialisation vectors in test/vectors/ (SPEC.md §7). Vectors are append-only: once
// committed, a vector's expected bytes never change. A change to the canonical form is a new schema and
// new vectors, never an edit. Run: npm run vectors -- <name> (only writes vectors that do not exist yet).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { b64 } from '../src/encoding';
import { buildEnvelope, encodeTrace, type EnvelopeInput } from '../src/envelope';
import type { SpanJson } from '../src/span';

const DIR = join(import.meta.dirname, '..', 'test', 'vectors');
const PRODUCER = { name: '@redberry/otel', version: '0.1.0' };
const AGENT = 'AGT-01K5V8QJ3M7XW2ZB4YRNCDEFGH';
const TRACE = '45e3cc173b7aae7a6e658021710f8848';

const span = (o: Partial<SpanJson> & { spanId: string; startTimeUnixNano: string }): SpanJson => ({
  traceId: TRACE,
  parentSpanId: null,
  name: o.spanId,
  kind: 0,
  endTimeUnixNano: o.endTimeUnixNano === undefined ? (BigInt(o.startTimeUnixNano) + 1_000_000n).toString() : o.endTimeUnixNano,
  attributes: {},
  status: { code: 0, message: null },
  events: [],
  links: [],
  scope: { name: 'gen_ai', version: null, schemaUrl: null },
  dropped: { attributes: 0, events: 0, links: 0 },
  ...o,
});

function spikeInput(): EnvelopeInput {
  const d = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'test', 'fixtures', 'spike-example-trace.json'), 'utf8'));
  const spans: SpanJson[] = d.spans.map((s: SpanJson & { scope: SpanJson['scope'] }) => ({
    ...s,
    events: s.events.map((e: Record<string, unknown>) => ({ ...e, droppedAttributesCount: 0 })),
    links: s.links.map((l: Record<string, unknown>) => ({ ...l, droppedAttributesCount: 0 })),
    scope: { ...s.scope, schemaUrl: null },
  }));
  // Reversed, so the vector also proves the span sort.
  return { agentId: AGENT, traceId: d.traceId, finish: 'complete', resource: d.resource, spans: spans.reverse(), producer: PRODUCER };
}

const vectors: Record<string, { description: string; input: EnvelopeInput }> = {
  'v1-minimal': {
    description: 'A root request span and one gen_ai chat span, given child first; finish complete.',
    input: {
      agentId: AGENT,
      traceId: TRACE,
      finish: 'complete',
      resource: { 'service.name': 'refund-agent', 'vercel.runtime': 'nodejs' },
      producer: PRODUCER,
      spans: [
        span({
          spanId: 'bbbbbbbbbbbbbbbb', parentSpanId: 'aaaaaaaaaaaaaaaa', name: 'chat openai/gpt-4o-mini', kind: 2,
          startTimeUnixNano: '1792595658010000000', endTimeUnixNano: '1792595659250123456',
          attributes: { 'gen_ai.usage.output_tokens': 12, 'gen_ai.operation.name': 'chat', 'gen_ai.request.temperature': 1, 'gen_ai.request.model': 'openai/gpt-4o-mini' },
        }),
        span({
          spanId: 'aaaaaaaaaaaaaaaa', name: 'POST /api/refund', kind: 1, scope: { name: 'next.js', version: '16.4.2', schemaUrl: null },
          startTimeUnixNano: '1792595658004000000', endTimeUnixNano: '1792595659744832569',
          attributes: { 'http.route': '/api/refund', 'http.status_code': 200, 'next.rsc': false },
        }),
      ],
    },
  },
  'v1-spike-refund-run': {
    description: 'The spike\'s real 32-span AI SDK 7 refund run (GenAI semconv, 7 tool calls, one tool error with an exception event), spans given in reverse order.',
    input: spikeInput(),
  },
  'v1-edge-cases': {
    description: 'Key order by UTF-16 code units (astral before U+E000), escapes, numbers in ECMAScript form, arrays, equal start times ordered by span id, and a span still open at a deadline cut (cut_short).',
    input: {
      agentId: AGENT,
      traceId: TRACE,
      finish: 'cut_short',
      cutReason: 'deadline',
      cutAtMs: 1792595718000,
      resource: { 'z': 1, 'a': 'x' },
      producer: PRODUCER,
      spans: [
        span({ spanId: '00000000000000ff', startTimeUnixNano: '1792595658000000000', name: 'same start, larger id', endTimeUnixNano: null }),
        span({
          spanId: '000000000000000a', startTimeUnixNano: '1792595658000000000', name: 'same start, smaller id',
          attributes: {
            '\ue000': 'private use',
            '\u{1f600}': 'astral key',
            '\u20ac': 'euro',
            'a': 'plain',
            'A': 'upper',
            '1': 'digit',
            '\r': 'cr',
            'gen_ai.operation.name': 'execute_tool',
            'strings': ['quote " backslash \\ slash /', 'tab\tnewline\nnul\u0000 del\u007f', 'caf\u00e9 cafe\u0301 \u{1f600} \u2028\u2029'],
            'numbers': [0, 1, -1, 0.1, 1e21, 1e-7, 123.456, 9007199254740991, -9007199254740991, 1.5e300, 5e-324],
            'bools': [true, false],
            'gen_ai.tool.call.arguments': '{"b":1,"a":2}',
          },
          status: { code: 2, message: 'Amount exceeds agent limit' },
          events: [{ name: 'exception', timeUnixNano: '1792595658000500000', attributes: { 'exception.message': 'boom' }, droppedAttributesCount: 0 }],
        }),
        span({ spanId: '0000000000000001', startTimeUnixNano: '1792595657999999999', name: 'earliest', kind: 1 }),
      ],
    },
  },
};

const only = process.argv.slice(2);
for (const [name, v] of Object.entries(vectors)) {
  if (only.length && !only.includes(name)) continue;
  const file = join(DIR, `${name}.json`);
  if (existsSync(file)) {
    console.log(`${name}: exists, not rewritten (vectors are append-only)`);
    continue;
  }
  const encoded = await encodeTrace(buildEnvelope(v.input));
  const out = {
    name,
    description: v.description,
    input: v.input,
    expected: {
      canonical: new TextDecoder().decode(encoded.json),
      gzip_base64: b64(encoded.gz),
      sha256: encoded.sha256,
      size: encoded.size,
    },
  };
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`${name}: wrote ${file} sha256=${encoded.sha256} size=${encoded.size}`);
}
