// The live contract check: this package against VALP's real hashes route, run locally in memory by
// scripts/python/valp_local_server.py. Skipped unless VALP_SRC (a VALP checkout with the hashes route,
// PR #53/#54) is set; VALP_PYTHON defaults to $VALP_SRC/.venv/bin/python.
//
//   VALP_SRC=../VALP-hashes VALP_PYTHON=../VALP/.venv/bin/python npm test
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSigner, type Signer } from '../src/crypto';
import { RedberryProcessor, type TraceResult } from '../src/processor';
import { sendReport, uploadSample, type ReportBody } from '../src/report';
import { aiAttrs, fakeSpan, memoryStore, SIGNING_KEY, withEnv } from './helpers';

const VALP_SRC = process.env.VALP_SRC;
const PYTHON = process.env.VALP_PYTHON ?? (VALP_SRC ? join(VALP_SRC, '.venv', 'bin', 'python') : '');

describe.skipIf(!VALP_SRC)('VALP hashes route (live, local)', () => {
  let server: ChildProcess;
  let valp: { url: string; token: string; agent_id: string; key_id: string };
  let signer: Signer;

  beforeAll(async () => {
    server = spawn(PYTHON, [join(import.meta.dirname, '..', 'scripts', 'python', 'valp_local_server.py')], {
      env: { ...process.env, PYTHONPATH: `${join(VALP_SRC!, 'src')}:${VALP_SRC}` },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const line = await new Promise<string>((resolve, reject) => {
      createInterface({ input: server.stdout! }).once('line', resolve);
      server.once('exit', (c) => reject(new Error(`VALP server exited ${c}`)));
    });
    valp = JSON.parse(line);
    signer = await loadSigner(SIGNING_KEY);
  }, 30_000);

  afterAll(() => {
    server?.kill();
  });

  const body = (over: Partial<ReportBody> = {}): ReportBody => ({
    v: 1, agent_id: valp.agent_id, trace_id: 'contract-1', sha256: 'ab'.repeat(32), size: 3,
    started_at: '2026-10-21T15:14:18.004Z', ended_at: '2026-10-21T15:14:19.744Z', stored: true, store: 'vercel-blob',
    leaf_kind: 'stored-bytes', ...over,
  });

  it('key ids agree (TS keyIdOf vs valp_core.hashing.key_id, via project creation)', () => {
    expect(signer.keyId).toBe(valp.key_id);
  });

  it('201 with a leaf and a pricing sample; the sample PUT is accepted', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) => x.toString(16).padStart(2, '0')).join('');
    const r = await sendReport({ url: valp.url, token: valp.token, signer, body: body({ sha256: sha }) });
    expect(r).toMatchObject({ outcome: 'recorded', status: 201, leaf: expect.stringMatching(`^hashes/${valp.agent_id}/`) });
    if (r.outcome !== 'recorded') throw new Error('unreachable');
    expect(r.sample?.headers?.['x-goog-meta-sha256']).toBe(sha);
    expect(await uploadSample(r.sample!, bytes)).toEqual({ ok: true, status: 200, existing: false });
    expect(await uploadSample(r.sample!, bytes)).toEqual({ ok: true, status: 412, existing: true });
    const samples = await (await fetch(`${valp.url}/_samples`)).json();
    expect(samples[`agent=${valp.agent_id}/contract-1.json.gz`]).toEqual({ size: 3, sha256: sha, meta_sha256: sha });
  });

  it('200 for the same body again; 409 (refused) for a different body under that trace', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) => x.toString(16).padStart(2, '0')).join('');
    expect(await sendReport({ url: valp.url, token: valp.token, signer, body: body({ sha256: sha }) })).toMatchObject({ outcome: 'duplicate', status: 200 });
    expect(await sendReport({ url: valp.url, token: valp.token, signer, body: body({ size: 4 }) })).toMatchObject({ outcome: 'refused', status: 409 });
  });

  it('403 for a wrong token and for a key VALP does not know', async () => {
    expect(await sendReport({ url: valp.url, token: 'cd'.repeat(32), signer, body: body({ trace_id: 'c2' }) })).toMatchObject({ outcome: 'refused', status: 403 });
    const other = await loadSigner(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
    const r = await sendReport({ url: valp.url, token: valp.token, signer: other, body: body({ trace_id: 'c3' }) });
    expect(r).toMatchObject({ outcome: 'refused', status: 403, error: expect.stringMatching(/key_unknown/) });
  });

  it('the whole processor: a finished AI run is stored, hashed, signed and recorded', async () => {
    const restore = withEnv({ VERCEL_ENV: 'production' });
    const results: TraceResult[] = [];
    const store = memoryStore();
    const p = new RedberryProcessor({
      url: valp.url, token: valp.token, signingKey: SIGNING_KEY, agentId: valp.agent_id, store, graceMs: 10,
      onResult: (x) => results.push(x),
    });
    const traceId = 'f'.repeat(32);
    const root = fakeSpan({ traceId, spanId: '1'.repeat(16), name: 'POST /api/refund', attributes: { 'http.route': '/api/refund' } });
    const chat = fakeSpan({ traceId, spanId: '2'.repeat(16), parent: '1'.repeat(16), name: 'chat m', attributes: aiAttrs(), scope: 'gen_ai' });
    for (const s of [root, chat]) p.onStart(s as never);
    for (const s of [chat, root]) {
      s.end();
      p.onEnd(s);
    }
    await new Promise((r) => setTimeout(r, 50));
    await p.forceFlush();
    restore();
    expect(results[0]).toMatchObject({ finish: 'complete', stored: true, report: { outcome: 'recorded', status: 201 }, sample: { ok: true } });
    expect(p.stats()).toMatchObject({ recorded: 1, samples: 1 });
  });
});
