import { describe, expect, it } from 'vitest';
import { loadSigner, verify } from '../src/crypto';
import { unb64 } from '../src/encoding';
import { sendReport, uploadSample, type ReportBody } from '../src/report';
import { AGENT, fakeFetch, fromHex, json, KEY_ID, PUBLIC_KEY_HEX, SIGNING_KEY, TOKEN, URL_ } from './helpers';

const body: ReportBody = {
  v: 1, agent_id: AGENT, trace_id: '45e3cc173b7aae7a6e658021710f8848', sha256: 'cd'.repeat(32), size: 618,
  started_at: '2026-10-21T15:14:18.004Z', ended_at: '2026-10-21T15:14:19.744Z', stored: true, store: 'vercel-blob',
  leaf_kind: 'stored-bytes',
};
const signer = loadSigner(SIGNING_KEY);
const send = async (f: typeof fetch) => sendReport({ url: `${URL_}/`, token: TOKEN, signer: await signer, body, fetch: f, retryDelaysMs: [1, 1] });

describe('sendReport', () => {
  it('POSTs exactly the VALP request: path, bearer token, key id, SUITE-1 signature, the ten fields', async () => {
    const f = fakeFetch(() => json(201, { leaf: `hashes/${AGENT}/2026-10-21/x`, window_start: '2026-10-21T15:10:00.000000Z' }));
    const r = await send(f);
    expect(r).toEqual({ outcome: 'recorded', status: 201, attempts: 1, leaf: `hashes/${AGENT}/2026-10-21/x`, windowStart: '2026-10-21T15:10:00.000000Z' });
    const c = f.calls[0]!;
    expect(c.url).toBe(`${URL_}/v1/agents/${AGENT}/hashes`);
    expect(c.method).toBe('POST');
    expect(c.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(c.headers['x-redberry-key']).toBe(KEY_ID);
    const sig = c.headers['x-redberry-signature']!;
    expect(sig).toMatch(/^ed25519=[A-Za-z0-9+/]{86}==$/);
    expect(await verify(fromHex(PUBLIC_KEY_HEX), c.body, unb64(sig.slice(8)))).toBe(true);
    const sent = JSON.parse(new TextDecoder().decode(c.body));
    expect(Object.keys(sent).sort()).toEqual(['agent_id', 'ended_at', 'leaf_kind', 'sha256', 'size', 'started_at', 'store', 'stored', 'trace_id', 'v']);
    expect(c.body.byteLength).toBeLessThanOrEqual(4096);
  });

  it('200 is a duplicate (the same body again)', async () => {
    expect(await send(fakeFetch(() => json(200, { leaf: 'l', window_start: 'w' })))).toMatchObject({ outcome: 'duplicate', status: 200 });
  });

  it('passes a sample through from the reply', async () => {
    const sample = { url: 'https://storage.googleapis.com/s?sig', method: 'PUT', headers: { 'Content-Type': 'application/gzip' } };
    expect(await send(fakeFetch(() => json(201, { leaf: 'l', window_start: 'w', sample })))).toMatchObject({ sample });
  });

  for (const status of [400, 401, 403, 404, 409, 413]) {
    it(`${status} is final: refused after one attempt`, async () => {
      const f = fakeFetch(() => json(status, { error: 'x', detail: 'nope', retryable: false }));
      const r = await send(f);
      expect(r).toMatchObject({ outcome: 'refused', status, attempts: 1 });
      expect(f.calls).toHaveLength(1);
    });
  }

  for (const status of [500, 502, 503, 429]) {
    it(`${status} is retried, and the retry sends the same bytes`, async () => {
      const f = fakeFetch((_c, n) => (n === 1 ? json(status, {}) : json(200, { leaf: 'l', window_start: 'w' })));
      expect(await send(f)).toMatchObject({ outcome: 'duplicate', attempts: 2 });
      expect(f.calls[1]!.body).toEqual(f.calls[0]!.body);
      expect(f.calls[1]!.headers['x-redberry-signature']).toBe(f.calls[0]!.headers['x-redberry-signature']);
    });
  }

  it('gives up after 3 attempts of 5xx', async () => {
    const f = fakeFetch(() => json(503, {}));
    expect(await send(f)).toMatchObject({ outcome: 'failed', status: 503, attempts: 3 });
    expect(f.calls).toHaveLength(3);
  });

  it('retries network errors, then gives up after 3', async () => {
    const f = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await send(f)).toMatchObject({ outcome: 'failed', status: null, attempts: 3, error: expect.stringMatching(/fetch failed/) });
  });

  it('recovers from a network error on the second attempt', async () => {
    const f = fakeFetch((_c, n) => {
      if (n === 1) throw new TypeError('ECONNRESET');
      return json(201, { leaf: 'l', window_start: 'w' });
    });
    expect(await send(f)).toMatchObject({ outcome: 'recorded', attempts: 2 });
  });
});

describe('uploadSample', () => {
  const sample = { url: 'https://storage.googleapis.com/b/o?X-Goog-Signature=1', method: 'PUT', headers: { 'Content-Type': 'application/gzip', 'x-goog-if-generation-match': '0' } };
  const bytes = new Uint8Array([1, 2, 3]);

  it('PUTs the bytes with exactly the signed headers', async () => {
    const f = fakeFetch(() => new Response(null, { status: 200 }));
    expect(await uploadSample(sample, bytes, f, [1, 1])).toEqual({ ok: true, status: 200, existing: false });
    expect(f.calls[0]).toMatchObject({ url: sample.url, method: 'PUT', headers: { 'content-type': 'application/gzip', 'x-goog-if-generation-match': '0' }, body: bytes });
  });

  it('412 means it is already there', async () => {
    expect(await uploadSample(sample, bytes, fakeFetch(() => new Response(null, { status: 412 })), [1, 1])).toEqual({ ok: true, status: 412, existing: true });
  });

  it('403 is a failure, 5xx retried', async () => {
    expect(await uploadSample(sample, bytes, fakeFetch(() => new Response('expired', { status: 403 })), [1, 1])).toMatchObject({ ok: false, status: 403 });
    const f = fakeFetch((_c, n) => new Response(null, { status: n < 3 ? 500 : 200 }));
    expect(await uploadSample(sample, bytes, f, [1, 1])).toMatchObject({ ok: true });
    expect(f.calls).toHaveLength(3);
  });
});
