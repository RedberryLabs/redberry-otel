// Redberry's bucket ("Store logs with Redberry"): VALP hands out a signed, create-only PUT URL pinned to
// the run's size and SHA-256, and the bytes go straight to the bucket (VALP never handles them).
//
//   POST {REDBERRY_URL}/v1/agents/{agent_id}/stored-logs/upload-url
//        Authorization: Bearer <project token>   {run_id, sha256, size}
//     -> {url, method: "PUT", headers, object, expires_at}
//   PUT  url  with exactly those headers
//
// A 412 on the PUT means the object exists; VALP signed that name for this exact size and hash, so the
// bytes there are ours (a retry), reported as stored.
import { DEFAULT_RETRY_DELAYS_MS, describe, readJson, trimBase, withRetries, type Fetch } from '../http';
import type { Store } from './types';

export interface RedberryStoreOptions {
  /** Default: REDBERRY_URL. */
  url?: string;
  /** The project token; default: REDBERRY_PROJECT_TOKEN. */
  token?: string;
  fetch?: Fetch;
  retryDelaysMs?: readonly number[];
}

interface UploadUrl {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  object?: string;
}

export function redberry(options: RedberryStoreOptions = {}): Store {
  const f: Fetch = options.fetch ?? ((...a) => fetch(...a));
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  return {
    kind: 'redberry',
    async put(_path, bytes, meta) {
      const base = options.url ?? process.env.REDBERRY_URL;
      const token = options.token ?? process.env.REDBERRY_PROJECT_TOKEN;
      if (!base || !token) throw new Error('redberry store: REDBERRY_URL and REDBERRY_PROJECT_TOKEN are required');
      const ask = await withRetries(
        () =>
          f(`${trimBase(base)}/v1/agents/${encodeURIComponent(meta.agentId)}/stored-logs/upload-url`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ run_id: meta.traceId, sha256: meta.sha256, size: meta.size }),
          }),
        delays,
      );
      if (!ask.response) throw new Error(`redberry store: upload-url failed: ${String(ask.error)}`);
      if (!ask.response.ok) throw new Error(`redberry store: upload-url refused: ${await describe(ask.response)}`);
      const signed = (await readJson(ask.response)) as UploadUrl | undefined;
      if (!signed?.url) throw new Error('redberry store: upload-url reply has no url');
      const put = await withRetries(
        () =>
          f(signed.url, {
            method: signed.method ?? 'PUT',
            headers: signed.headers ?? { 'content-type': 'application/gzip' },
            body: bytes.slice().buffer as ArrayBuffer,
          }),
        delays,
      );
      if (!put.response) throw new Error(`redberry store: upload failed: ${String(put.error)}`);
      if (put.response.status === 412) return { url: signed.object, existing: true };
      if (!put.response.ok) throw new Error(`redberry store: upload failed: ${await describe(put.response)}`);
      return { url: signed.object };
    },
  };
}
