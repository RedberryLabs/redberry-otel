// The signed hash report (VALP valp_collector.hashes) and the optional pricing-sample upload.
//
//   POST {REDBERRY_URL}/v1/agents/{agent_id}/hashes
//     Authorization: Bearer <project token>       (64 lowercase hex)
//     X-Redberry-Key: <key_id>                     (32 lowercase hex)
//     X-Redberry-Signature: ed25519=<base64>       (Ed25519 over 0x05 || SHA-256(raw body); 88 chars)
//     body: exactly {v, agent_id, trace_id, sha256, size, started_at, ended_at, stored, store, leaf_kind}
//
// 201 recorded (a new leaf), 200 the same body again (a retry), 4xx final, 5xx/429/network retried.
import { canonicalBytes } from './canonical';
import type { Signer } from './crypto';
import { b64 } from './encoding';
import { DEFAULT_RETRY_DELAYS_MS, describe, readJson, trimBase, withRetries, type Fetch } from './http';
import type { StoreKind } from './stores/types';

export const MAX_REPORT_BYTES = 4096;

export interface ReportBody {
  v: 1;
  agent_id: string;
  trace_id: string;
  sha256: string;
  size: number;
  started_at: string;
  ended_at: string;
  stored: boolean;
  store: StoreKind;
  leaf_kind: 'stored-bytes';
}

/** The report's bytes: canonical JSON, so a retry sends exactly the same body (VALP answers 200, not 409). */
export function reportBytes(body: ReportBody): Uint8Array {
  const raw = canonicalBytes(body);
  if (raw.byteLength > MAX_REPORT_BYTES) throw new Error(`hash report is over ${MAX_REPORT_BYTES} bytes`);
  return raw;
}

export interface Sample {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  object?: string;
  expires_at?: string;
}

export type ReportOutcome =
  | { outcome: 'recorded' | 'duplicate'; status: number; attempts: number; leaf?: string; windowStart?: string; sample?: Sample }
  | { outcome: 'refused'; status: number; attempts: number; error: string }
  | { outcome: 'failed'; status: number | null; attempts: number; error: string };

export interface SendReportOptions {
  url: string;
  token: string;
  signer: Signer;
  body: ReportBody;
  fetch?: Fetch;
  retryDelaysMs?: readonly number[];
}

export async function sendReport(o: SendReportOptions): Promise<ReportOutcome> {
  const raw = reportBytes(o.body);
  const signature = await o.signer.sign(raw);
  const f: Fetch = o.fetch ?? ((...a) => fetch(...a));
  const target = `${trimBase(o.url)}/v1/agents/${encodeURIComponent(o.body.agent_id)}/hashes`;
  const r = await withRetries(
    () =>
      f(target, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${o.token}`,
          'content-type': 'application/json',
          'x-redberry-key': o.signer.keyId,
          'x-redberry-signature': `ed25519=${b64(signature)}`,
        },
        body: raw.slice().buffer as ArrayBuffer,
      }),
    o.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
  );
  if (!r.response) return { outcome: 'failed', status: null, attempts: r.attempts, error: String(r.error) };
  const { status } = r.response;
  if (status === 200 || status === 201) {
    const reply = (await readJson(r.response)) as { leaf?: string; window_start?: string; sample?: Sample } | undefined;
    return {
      outcome: status === 201 ? 'recorded' : 'duplicate',
      status,
      attempts: r.attempts,
      ...(reply?.leaf ? { leaf: reply.leaf } : {}),
      ...(reply?.window_start ? { windowStart: reply.window_start } : {}),
      ...(reply?.sample?.url ? { sample: reply.sample } : {}),
    };
  }
  const error = await describe(r.response);
  if (status >= 400 && status < 500 && status !== 429) return { outcome: 'refused', status, attempts: r.attempts, error };
  return { outcome: 'failed', status, attempts: r.attempts, error };
}

export type SampleOutcome = { ok: true; status: number; existing: boolean } | { ok: false; status: number | null; error: string };

/** PUT the stored bytes to the signed pricing-sample URL VALP returned, with exactly its headers. */
export async function uploadSample(sample: Sample, bytes: Uint8Array, fetchImpl?: Fetch, delays?: readonly number[]): Promise<SampleOutcome> {
  const f: Fetch = fetchImpl ?? ((...a) => fetch(...a));
  const r = await withRetries(
    () =>
      f(sample.url, {
        method: sample.method ?? 'PUT',
        headers: sample.headers ?? { 'content-type': 'application/gzip' },
        body: bytes.slice().buffer as ArrayBuffer,
      }),
    delays ?? DEFAULT_RETRY_DELAYS_MS,
  );
  if (!r.response) return { ok: false, status: null, error: String(r.error) };
  if (r.response.ok) return { ok: true, status: r.response.status, existing: false };
  // Create-only (x-goog-if-generation-match: 0) and pinned to this size and hash: 412 means it is there.
  if (r.response.status === 412) return { ok: true, status: 412, existing: true };
  return { ok: false, status: r.response.status, error: await describe(r.response) };
}
