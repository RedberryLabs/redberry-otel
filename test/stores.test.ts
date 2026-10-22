import { describe, expect, it, vi } from 'vitest';
import { azureBlob, azureCredentialFor, BLOB_API_VERSION, containerUrlOf, LOGIN_URL } from '../src/stores/azure-blob';
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

describe('azureBlob (Vercel OIDC or managed identity -> Put Blob, If-None-Match: *)', () => {
  const CONTAINER = 'https://acmetraces.blob.core.windows.net/redberry-runs';
  const TENANT = '0f3a2b1c-1111-2222-3333-444455556666';
  const CLIENT = '9e8d7c6b-aaaa-bbbb-cccc-ddddeeeeffff';
  const MSI = 'http://localhost:8081/msi/token';
  const blobUrl = `${CONTAINER}/${path}`;
  const vercel = { containerUrl: CONTAINER, tenantId: TENANT, clientId: CLIENT, env: { VERCEL: '1' }, getOidcToken: async () => 'vercel-oidc-jwt', retryDelaysMs: [1, 1] };
  const functionsEnv = { WEBSITE_SITE_NAME: 'refund-app', IDENTITY_ENDPOINT: MSI, IDENTITY_HEADER: 'identity-header-value' };

  /** Entra ID, the managed-identity endpoint and Blob Storage, each answering with a token stamped by ``now``. */
  function azure(now: () => number, upload: (c: { headers: Record<string, string> }, n: number) => Response = () => new Response(null, { status: 201 })) {
    let uploads = 0;
    return fakeFetch((c) => {
      if (c.url.startsWith(LOGIN_URL)) return json(200, { token_type: 'Bearer', expires_in: 3599, access_token: `entra-${now()}` });
      if (c.url.startsWith(MSI)) return json(200, { access_token: `msi-${now()}`, expires_on: String(Math.floor(now() / 1000) + 3600), resource: 'https://storage.azure.com/', token_type: 'Bearer' });
      if (c.url.startsWith(CONTAINER)) return upload(c, ++uploads);
      return json(404, {});
    });
  }

  it('exchanges the Vercel OIDC token at Entra ID and puts create-only', async () => {
    let t = 1_000_000;
    const now = () => t;
    const f = azure(now);
    const s = azureBlob({ ...vercel, fetch: f, now });
    expect(s.kind).toBe('azure-blob');
    expect(await s.put(path, bytes, meta)).toEqual({ url: blobUrl });

    const [login, up] = f.calls;
    expect(login).toMatchObject({ url: `${LOGIN_URL}${TENANT}/oauth2/v2.0/token`, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(Object.fromEntries(new URLSearchParams(new TextDecoder().decode(login!.body)))).toEqual({
      grant_type: 'client_credentials',
      client_id: CLIENT,
      scope: 'https://storage.azure.com/.default',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: 'vercel-oidc-jwt',
    });
    expect(up).toMatchObject({ url: blobUrl, method: 'PUT', body: bytes });
    expect(up!.headers).toEqual({
      authorization: 'Bearer entra-1000000',
      'x-ms-version': BLOB_API_VERSION,
      'x-ms-blob-type': 'BlockBlob',
      'if-none-match': '*',
      'content-type': 'application/gzip',
      'x-ms-meta-sha256': meta.sha256,
    });
    expect(BLOB_API_VERSION).toBe('2023-11-03');

    // Cached: a second put within the hour goes straight to Blob Storage.
    t += 30 * 60_000;
    await s.put(path, bytes, meta);
    expect(f.calls.map((c) => new URL(c.url).host)).toEqual(['login.microsoftonline.com', 'acmetraces.blob.core.windows.net', 'acmetraces.blob.core.windows.net']);
    // Within a minute of expiry: minted again.
    t += 29.5 * 60_000;
    await s.put(path, bytes, meta);
    expect(f.calls).toHaveLength(5);
    expect(f.calls[4]!.headers.authorization).toBe(`Bearer entra-${t}`);
  });

  it('asks the App Service / Functions managed-identity endpoint, with the identity header and client id', async () => {
    let t = 2_000_000_000;
    const now = () => t;
    const f = azure(now);
    const s = azureBlob({ containerUrl: CONTAINER, clientId: CLIENT, env: functionsEnv, fetch: f, now, retryDelaysMs: [1, 1] });
    await s.put(path, bytes, meta);
    const [msi, up] = f.calls;
    expect(msi!.method).toBe('GET');
    expect(msi!.headers['x-identity-header']).toBe('identity-header-value');
    const u = new URL(msi!.url);
    expect(`${u.origin}${u.pathname}`).toBe(MSI);
    expect(Object.fromEntries(u.searchParams)).toEqual({ resource: 'https://storage.azure.com/', 'api-version': '2019-08-01', client_id: CLIENT });
    expect(up!.headers.authorization).toBe(`Bearer msi-${t}`);
    // expires_on is epoch seconds: still cached 58 minutes on, minted again at 59.5.
    t += 58 * 60_000;
    await s.put(path, bytes, meta);
    expect(f.calls).toHaveLength(3);
    t += 90_000;
    await s.put(path, bytes, meta);
    expect(f.calls).toHaveLength(5);

    // A system-assigned identity: no client_id.
    const g = azure(now);
    await azureBlob({ containerUrl: CONTAINER, env: functionsEnv, fetch: g, now }).put(path, bytes, meta);
    expect(new URL(g.calls[0]!.url).searchParams.has('client_id')).toBe(false);
  });

  it('picks the credential from where it runs', () => {
    expect(azureCredentialFor(functionsEnv)).toBe('managed-identity');
    expect(azureCredentialFor({ VERCEL: '1', VERCEL_ENV: 'production' })).toBe('vercel-oidc');
    expect(azureCredentialFor({ WEBSITE_SITE_NAME: 'x' })).toBeUndefined();
    expect(() => azureBlob({ containerUrl: CONTAINER, env: {} })).toThrow(/no Azure credential/);
    expect(() => azureBlob({ ...vercel, tenantId: undefined })).toThrow(/REDBERRY_AZURE_TENANT_ID/);
    expect(() => azureBlob({ ...vercel, clientId: '' })).toThrow(/REDBERRY_AZURE_CLIENT_ID/);
    expect(() => azureBlob({ containerUrl: CONTAINER, credential: 'managed-identity', env: { VERCEL: '1' } })).toThrow(/IDENTITY_ENDPOINT/);
  });

  it('mints one token for concurrent puts', async () => {
    const f = azure(() => 0);
    const s = azureBlob({ ...vercel, fetch: f });
    await Promise.all([s.put(path, bytes, meta), s.put(path, bytes, meta), s.put(path, bytes, meta)]);
    expect(f.calls.filter((c) => c.url.startsWith(LOGIN_URL))).toHaveLength(1);
  });

  it('409 (BlobAlreadyExists) is a StoreConflictError', async () => {
    const conflict = () => new Response('<Error><Code>BlobAlreadyExists</Code></Error>', { status: 409, headers: { 'x-ms-error-code': 'BlobAlreadyExists' } });
    const s = azureBlob({ ...vercel, fetch: azure(() => 0, conflict) });
    const err = await s.put(path, bytes, meta).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreConflictError);
    expect(String((err as Error).message)).toMatch(/BlobAlreadyExists/);
  });

  it('401 drops the cached token, mints a new one and tries once more', async () => {
    let t = 1_000_000;
    const f = azure(() => t, (_c, n) => (n === 1 ? new Response('', { status: 401 }) : new Response(null, { status: 201 })));
    const s = azureBlob({ ...vercel, fetch: f, now: () => t++ });
    expect(await s.put(path, bytes, meta)).toEqual({ url: blobUrl });
    const hosts = f.calls.map((c) => new URL(c.url).host);
    expect(hosts).toEqual(['login.microsoftonline.com', 'acmetraces.blob.core.windows.net', 'login.microsoftonline.com', 'acmetraces.blob.core.windows.net']);
    expect(f.calls[1]!.headers.authorization).not.toBe(f.calls[3]!.headers.authorization);

    // Still 401 after a fresh token: an error, and the next put mints again.
    const denied = azure(() => t, () => new Response('', { status: 401 }));
    const d = azureBlob({ ...vercel, fetch: denied });
    await expect(d.put(path, bytes, meta)).rejects.toThrow(/upload failed: HTTP 401/);
    await expect(d.put(path, bytes, meta)).rejects.toThrow(/HTTP 401/);
    expect(denied.calls.filter((c) => c.url.startsWith(LOGIN_URL))).toHaveLength(4);
  });

  it('a refused token request or upload is an error, and 5xx is retried', async () => {
    const refused = fakeFetch(() => json(400, { error: 'invalid_client', error_description: 'AADSTS700213: No matching federated identity record found' }));
    await expect(azureBlob({ ...vercel, fetch: refused }).put(path, bytes, meta)).rejects.toThrow(/Entra ID token request failed: HTTP 400.*AADSTS700213/);
    const forbidden = azureBlob({ ...vercel, fetch: azure(() => 0, () => new Response('AuthorizationPermissionMismatch', { status: 403 })) });
    await expect(forbidden.put(path, bytes, meta)).rejects.toThrow(/upload failed: HTTP 403/);
    const flaky = azure(() => 0, (_c, n) => new Response(null, { status: n < 3 ? 503 : 201 }));
    expect(await azureBlob({ ...vercel, fetch: flaky }).put(path, bytes, meta)).toEqual({ url: blobUrl });
    expect(flaky.calls).toHaveLength(4);
  });

  it('accepts only https://<account>.blob.core.windows.net/<container>, and never echoes the URL', () => {
    expect(containerUrlOf(CONTAINER)).toBe(CONTAINER);
    expect(containerUrlOf(`${CONTAINER}/`)).toBe(CONTAINER);
    for (const bad of [
      'http://acmetraces.blob.core.windows.net/redberry-runs',
      'https://acmetraces.blob.core.windows.net',
      'https://acmetraces.blob.core.windows.net/redberry-runs/nested',
      'https://acmetraces.blob.core.windows.net/Redberry',
      'https://acmetraces.blob.core.windows.net/a--b',
      'https://acmetraces.example.com/redberry-runs',
      'https://acmetraces.blob.core.windows.net.evil.test/redberry-runs',
      'not a url',
    ]) expect(() => containerUrlOf(bad), bad).toThrow(/containerUrl/);
    let message = '';
    try {
      containerUrlOf(`${CONTAINER}?sv=2022-11-02&sig=secret`);
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).toMatch(/no SAS token/);
    expect(message).not.toContain('secret');
    // A test double or storage emulator, by explicit opt-in.
    expect(containerUrlOf('http://127.0.0.1:10000/devstoreaccount1/runs', '127.0.0.1:10000')).toBe('http://127.0.0.1:10000/devstoreaccount1/runs');
    expect(containerUrlOf('https://blob.test/runs', 'blob.test')).toBe('https://blob.test/runs');
    expect(() => containerUrlOf('http://blob.test/runs', 'blob.test')).toThrow(/https/);
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
