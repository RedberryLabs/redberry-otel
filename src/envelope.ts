// The stored trace document (SPEC.md §1) and its bytes, hash and size.
import type { Attributes } from '@opentelemetry/api';
import { canonicalBytes, deterministicGzip } from './canonical';
import { sha256Hex } from './crypto';
import { nsToIso, sortSpans, type SpanJson } from './span';
import { VERSION } from './version';

export const SCHEMA = 'redberry.trace.v1';

export type Finish = 'complete' | 'cut_short';
export type CutReason = 'deadline' | 'hard_stop' | 'shutdown';

export interface TraceEnvelope {
  schema: typeof SCHEMA;
  agent_id: string;
  trace_id: string;
  finish: Finish;
  cut_reason: CutReason | null;
  started_at: string;
  ended_at: string;
  resource: Attributes;
  spans: SpanJson[];
  dropped_spans: number;
  producer: { name: string; version: string };
}

export interface EnvelopeInput {
  agentId: string;
  traceId: string;
  finish: Finish;
  cutReason?: CutReason | null;
  /** When the trace was cut short (ms since the epoch); ended_at is at least this. */
  cutAtMs?: number;
  resource: Attributes;
  spans: SpanJson[];
  droppedSpans?: number;
  producer?: { name: string; version: string };
}

/** The span attribute every stored span carries: the agent the package resolved (SPEC.md §2.1). */
export const AGENT_ATTRIBUTE = 'redberry.agent_id';

export function buildEnvelope(i: EnvelopeInput): TraceEnvelope {
  if (i.spans.length === 0) throw new Error('a trace has at least one span');
  // AI SDK 7 drops metadata, so readers (the OTELLINE normaliser) find the agent on each span here.
  const spans = sortSpans(i.spans).map((s) => ({ ...s, attributes: { ...s.attributes, [AGENT_ATTRIBUTE]: i.agentId } }));
  let start = BigInt(spans[0]!.startTimeUnixNano);
  let end = start;
  for (const s of spans) {
    const st = BigInt(s.startTimeUnixNano);
    if (st < start) start = st;
    const en = s.endTimeUnixNano === null ? st : BigInt(s.endTimeUnixNano);
    if (en > end) end = en;
  }
  if (i.cutAtMs !== undefined) {
    const cut = BigInt(Math.floor(i.cutAtMs)) * 1_000_000n;
    if (cut > end) end = cut;
  }
  return {
    schema: SCHEMA,
    agent_id: i.agentId,
    trace_id: i.traceId,
    finish: i.finish,
    cut_reason: i.finish === 'complete' ? null : (i.cutReason ?? null),
    started_at: nsToIso(start.toString()),
    ended_at: nsToIso(end.toString()),
    resource: { ...i.resource },
    spans,
    dropped_spans: i.droppedSpans ?? 0,
    producer: i.producer ?? { name: '@redberrylabs/otel', version: VERSION },
  };
}

export interface EncodedTrace {
  /** Canonical JSON (SPEC.md §3), UTF-8. */
  json: Uint8Array;
  /** The stored bytes: deterministic gzip of ``json`` (SPEC.md §4). */
  gz: Uint8Array;
  /** Lowercase hex SHA-256 of ``gz``: what the hash report commits to. */
  sha256: string;
  size: number;
}

export async function encodeTrace(envelope: TraceEnvelope): Promise<EncodedTrace> {
  const json = canonicalBytes(envelope);
  const gz = deterministicGzip(json);
  return { json, gz, sha256: await sha256Hex(gz), size: gz.byteLength };
}

/** Where a trace is stored (SPEC.md §5): ``redberry/<agent_id>/<yyyy-mm-dd of started_at>/<trace_id>.json.gz``. */
export const storagePath = (e: Pick<TraceEnvelope, 'agent_id' | 'trace_id' | 'started_at'>): string =>
  `redberry/${e.agent_id}/${e.started_at.slice(0, 10)}/${e.trace_id}.json.gz`;
