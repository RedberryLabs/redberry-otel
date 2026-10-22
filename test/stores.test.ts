import { describe, expect, it, vi } from 'vitest';
import { gcs, IAM_URL, STS_URL, UPLOAD_URL } from '../src/stores/gcs';
import { redberry } from '../src/stores/redberry';
import { StoreConflictError, type PutMeta } from '../src/stores/types';
import { vercelBlob } from '../src/stores/vercel-blob';
import { AGENT, fakeFetch, json, TOKEN, URL_ } from './helpers';

const meta: PutMeta = { agentId: AGENT, traceId: '45e3cc173b7aae7a6e658021710f8848', sha256: 'ef'.repeat(32), size: 3 };
const path = `redberry/${AGENT}/2026-10-21/${meta.traceId}.json.gz`;
const bytes = new Uint8Array([0x1f, 0x8b, 8]);

describe('vercelBlob', () => {
  it('puts privately, at exactly the path, refusing overwrite (the options the spike proved)', async () => {
    const put = vi.fn(async (p: string) => ({ url: `https://x.private.blob.vercel-storage.com/${p}` }));
    const s = vercelBlob({ put: put as never, token: 'vercel_blob_rw_x' });
    expect(s.kind).toBe('vercel-blob');
    expect(await s.put(path, bytes, meta)).toEqual({ url: `https://x.private.blob.vercel-storage.com/${path}` });
    const [p, blob, opts] = put.mock.calls[0]! as unknown as [string, Blob, Record<string, unknown>];
    expect(p).toBe(path);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(opts).toEqual({ access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/gzip', token: 'vercel_blob_rw_x' });
  });

  it('maps "already exists" to StoreConflictError and passes other errors through', async () => {
    const exists = vercelBlob({ put: (async () => { throw new Error('Vercel Blob: This blob already exists, use `allowOverwrite: true`'); }) as never });
    await expect(exists.put(path, bytes, meta)).rejects.toBeInstanceOf(StoreConflictError);
    const down = vercelBlob({ put: (async () => { throw new Error('BlobServiceNotAvailable'); }) as never });
    await expect(down.put(path, bytes, meta)).rejects.toThrow(/BlobServiceNotAvailable/);
  });

  it('loads @vercel/blob lazily when no put is injected', async () => {
    vi.resetModules();
    vi.doMock('@vercel/blob', () => ({ put: vi.fn(async () => ({ url: 'u' })) }));
    const { vercelBlob: fresh } = await import('../src/stores/vercel-blob');
    expect(await fresh().put(path, bytes, meta)).toEqual({ url: 'u' });
    vi.doUnmock('@vercel/blob');
  });
});

describe('gcs (Vercel OIDC -> STS -> IAM Credentials -> JSON API upload)', () => {
  const opts = { bucket: 'acme-traces', projectNumber: '123456789', poolId: 'vercel', providerId: 'redberrylabs', serviceAccount: 'writer@acme.iam.gserviceaccount.com' };
  function google(now: () => number, upload: () => Response = () => json(200, { name: path, generation: '1' })) {
    return fakeFetch((c) => {
      if (c.url === STS_URL) return json(200, { access_token: 'federated', expires_in: 3600 });
      if (c.url.startsWith(IAM_URL)) return json(200, { accessToken: `sa-${now()}`, expireTime: new Date(now() + 3_600_000).toISOString() });
      if (c.url.startsWith(UPLOAD_URL)) return upload();
      return json(404, {});
    });
  }

  it('exchanges the Vercel OIDC token and uploads create-only', async () => {
    let t = 1_000_000;
    const now = () => t;
    const f = google(now);
    const s = gcs({ ...opts, fetch: f, now, getOidcToken: async () => 'vercel-oidc-jwt', retryDelaysMs: [1, 1] });
    expect(s.kind).toBe('gcs');
    expect(await s.put(path, bytes, meta)).toEqual({ url: `gs://acme-traces/${path}` });

    const [sts, iam, up] = f.calls;
    const form = new URLSearchParams(new TextDecoder().decode(sts!.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/vercel/providers/redberrylabs',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: 'vercel-oidc-jwt',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    });
    expect(iam!.url).toBe(`${IAM_URL}writer%40acme.iam.gserviceaccount.com:generateAccessToken`);
    expect(iam!.headers.authorization).toBe('Bearer federated');
    expect(JSON.parse(new TextDecoder().decode(iam!.body))).toEqual({ scope: ['https://www.googleapis.com/auth/devstorage.read_write'], lifetime: '3600s' });
    expect(up!.url).toBe(`${UPLOAD_URL}acme-traces/o?uploadType=multipart&ifGenerationMatch=0`);
    expect(up!.headers.authorization).toBe(`Bearer sa-1000000`);
    expect(up!.headers['content-type']).toMatch(/^multipart\/related; boundary=/);
    const text = new TextDecoder().decode(up!.body);
    expect(text).toContain(JSON.stringify({ name: path, contentType: 'application/gzip', metadata: { sha256: meta.sha256 } }));
    const at = text.indexOf('content-type: application/gzip\r\n\r\n') + 'content-type: application/gzip\r\n\r\n'.length;
    expect(up!.body.slice(at, at + bytes.length)).toEqual(bytes); // the media part is the bytes, unchanged

    // Cached: a second put within the hour goes straight to the upload.
    t += 30 * 60_000;
    await s.put(path, bytes, meta);
    expect(f.calls.map((c) => c.url.split('?')[0]!.split('/')[2])).toEqual(['sts.googleapis.com', 'iamcredentials.googleapis.com', 'storage.googleapis.com', 'storage.googleapis.com']);
    // Within a minute of expiry: minted again.
    t += 29.5 * 60_000;
    await s.put(path, bytes, meta);
    expect(f.calls).toHaveLength(7);
    expect(f.calls[6]!.headers.authorization).toBe(`Bearer sa-${t}`);
  });

  it('412 (generation exists) is a StoreConflictError', async () => {
    const s = gcs({ ...opts, fetch: google(() => 0, () => new Response('', { status: 412 })), getOidcToken: async () => 'j', retryDelaysMs: [1, 1] });
    await expect(s.put(path, bytes, meta)).rejects.toBeInstanceOf(StoreConflictError);
  });

  it('a refused STS exchange or upload is an error', async () => {
    const sts = fakeFetch(() => json(400, { error: 'invalid_grant' }));
    await expect(gcs({ ...opts, fetch: sts, getOidcToken: async () => 'j', retryDelaysMs: [1, 1] }).put(path, bytes, meta)).rejects.toThrow(/STS token exchange failed: HTTP 400/);
    const denied = gcs({ ...opts, fetch: google(() => 0, () => new Response('forbidden', { status: 403 })), getOidcToken: async () => 'j', retryDelaysMs: [1, 1] });
    await expect(denied.put(path, bytes, meta)).rejects.toThrow(/upload failed: HTTP 403/);
  });

  it('needs every option', () => {
    expect(() => gcs({ ...opts, bucket: '' })).toThrow(/bucket is required/);
  });
});

describe('redberry (VALP signed upload URL)', () => {
  const signed = {
    url: 'https://storage.googleapis.com/valp-stored-logs/agent%3DAGT/x?X-Goog-Signature=abc',
    method: 'PUT',
    headers: { 'Content-Type': 'application/gzip', 'x-goog-if-generation-match': '0', 'x-goog-content-length-range': '3,3', 'x-goog-meta-sha256': meta.sha256 },
    object: `agent=${AGENT}/dt=2026-10-21/${meta.traceId}.ndjson.gz`,
    expires_at: '2026-10-21T15:24:18.000000Z',
  };

  it('asks VALP for a URL with the project token, then PUTs with exactly its headers', async () => {
    const f = fakeFetch((c) => (c.url.startsWith(URL_) ? json(200, signed) : new Response(null, { status: 200 })));
    const s = redberry({ url: URL_, token: TOKEN, fetch: f, retryDelaysMs: [1, 1] });
    expect(s.kind).toBe('redberry');
    expect(await s.put(path, bytes, meta)).toEqual({ url: signed.object });
    expect(f.calls[0]).toMatchObject({ url: `${URL_}/v1/agents/${AGENT}/stored-logs/upload-url`, method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(JSON.parse(new TextDecoder().decode(f.calls[0]!.body))).toEqual({ run_id: meta.traceId, sha256: meta.sha256, size: 3 });
    expect(f.calls[1]).toMatchObject({ url: signed.url, method: 'PUT', body: bytes, headers: { 'content-type': 'application/gzip', 'x-goog-if-generation-match': '0', 'x-goog-content-length-range': '3,3', 'x-goog-meta-sha256': meta.sha256 } });
  });

  it('412 on the PUT: already stored with this hash (VALP pinned it), so stored', async () => {
    const f = fakeFetch((c) => (c.url.startsWith(URL_) ? json(200, signed) : new Response(null, { status: 412 })));
    expect(await redberry({ url: URL_, token: TOKEN, fetch: f }).put(path, bytes, meta)).toEqual({ url: signed.object, existing: true });
  });

  it('403 (not opted in, bad token) and 409 (different hash) are errors', async () => {
    for (const status of [403, 409]) {
      const f = fakeFetch(() => json(status, { error: 'no' }));
      await expect(redberry({ url: URL_, token: TOKEN, fetch: f }).put(path, bytes, meta)).rejects.toThrow(new RegExp(`refused: HTTP ${status}`));
    }
  });

  it('reads REDBERRY_URL / REDBERRY_PROJECT_TOKEN at put time', async () => {
    await expect(redberry({ fetch: fakeFetch(() => json(500, {})) }).put(path, bytes, meta)).rejects.toThrow(/REDBERRY_URL and REDBERRY_PROJECT_TOKEN/);
  });
});
