import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_MARGIN_MS } from '../src/ingest/credentials';
import { ExportResultCode, redberryExporter, type RedberryExporterOptions } from '../src/ingest/exporter';
import { AGENT_NAME_ATTRIBUTE, exporterOptionsFrom, validateAgentName } from '../src/ingest/config';
import { init } from '../src/init';
import { IAM_URL, STS_URL } from '../src/stores/gcs';

const INGEST = 'https://ingest-abc-ew.a.run.app';
const OIDC = 'vercel.oidc.jwt';

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;

type Call = { url: string; init: RequestInit };

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  });
  return { f: f as unknown as typeof fetch, calls };
}

const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const headersOf = (c: Call) => c.init.headers as Record<string, string>;

function spans(attrs: Record<string, string> = { [AGENT_NAME_ATTRIBUTE]: 'refund-agent' }): ReadableSpan[] {
  const mem = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ resource: resourceFromAttributes(attrs), spanProcessors: [new SimpleSpanProcessor(mem)] });
  const tracer = provider.getTracer('ai', '7.0.0');
  const root = tracer.startSpan('ai.generateText', { attributes: { 'ai.model.id': 'gpt', 'ai.usage.tokens': 12, ok: true } });
  const child = tracer.startSpan('ai.toolCall', {}, trace.setSpan(ROOT_CONTEXT, root));
  child.end();
  root.end();
  return mem.getFinishedSpans();
}

function exportOnce(e: ReturnType<typeof redberryExporter>, s: ReadableSpan[]) {
  return new Promise<{ code: number; error?: Error }>((resolve) => e.export(s, resolve));
}

const gcpOpts = (f: typeof fetch, extra: Partial<RedberryExporterOptions> = {}): RedberryExporterOptions =>
  ({
    cloud: 'gcp',
    endpoint: `${INGEST}/`,
    projectNumber: '123456789',
    poolId: 'vercel',
    providerId: 'acme',
    serviceAccount: 'ingest-invoker@p.iam.gserviceaccount.com',
    fetch: f,
    getOidcToken: async () => OIDC,
    retryDelaysMs: [1, 1, 1],
    ...extra,
  }) as RedberryExporterOptions;

function gcpHandler(opts: { exp?: number; ingest?: () => Response } = {}) {
  return (url: string): Response => {
    if (url === STS_URL) return ok({ access_token: 'federated' });
    if (url.startsWith(IAM_URL)) return ok({ token: jwt(opts.exp ?? Math.floor(Date.now() / 1000) + 3600) });
    return opts.ingest ? opts.ingest() : new Response('', { status: 200 });
  };
}

describe('redberryExporter: gcp', () => {
  it('exchanges the Vercel OIDC token at STS, mints an ID token for the ingest URL and sends it as Bearer', async () => {
    const { f, calls } = mockFetch(gcpHandler());
    const e = redberryExporter(gcpOpts(f));
    const r = await exportOnce(e, spans());
    expect(r.code).toBe(ExportResultCode.SUCCESS);
    expect(calls.map((c) => c.url)).toEqual([
      STS_URL,
      `${IAM_URL}${encodeURIComponent('ingest-invoker@p.iam.gserviceaccount.com')}:generateIdToken`,
      `${INGEST}/v1/traces`,
    ]);
    const sts = new URLSearchParams(String(calls[0]!.init.body));
    expect(Object.fromEntries(sts)).toMatchObject({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: '//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/vercel/providers/acme',
      subject_token: OIDC,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    });
    expect(headersOf(calls[1]!).authorization).toBe('Bearer federated');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ audience: INGEST, includeEmail: true });
    const post = calls[2]!;
    expect(headersOf(post).authorization).toMatch(/^Bearer h\./);
    expect(headersOf(post)['content-type']).toBe('application/json');
  });

  it('encodes OTLP/JSON with the spans and redberry.agent.name on the resource', async () => {
    const { f, calls } = mockFetch(gcpHandler());
    await exportOnce(redberryExporter(gcpOpts(f)), spans());
    const body = JSON.parse(String(calls[2]!.init.body));
    const rs = body.resourceSpans[0];
    expect(rs.resource.attributes).toContainEqual({ key: AGENT_NAME_ATTRIBUTE, value: { stringValue: 'refund-agent' } });
    const ss = rs.scopeSpans[0];
    expect(ss.scope).toEqual({ name: 'ai', version: '7.0.0' });
    const names = ss.spans.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(['ai.generateText', 'ai.toolCall']);
    const root = ss.spans.find((s: { name: string }) => s.name === 'ai.generateText');
    const child = ss.spans.find((s: { name: string }) => s.name === 'ai.toolCall');
    expect(child.parentSpanId).toBe(root.spanId);
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.kind).toBe(1);
    expect(root.startTimeUnixNano).toMatch(/^\d{19}$/);
    expect(root.attributes).toEqual(
      expect.arrayContaining([
        { key: 'ai.model.id', value: { stringValue: 'gpt' } },
        { key: 'ai.usage.tokens', value: { intValue: '12' } },
        { key: 'ok', value: { boolValue: true } },
      ]),
    );
  });

  it('caches the ID token and refreshes it once, five minutes before expiry', async () => {
    let clock = 1_800_000_000_000;
    const exp = Math.floor(clock / 1000) + 3600;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { f, calls } = mockFetch(async (url) => {
      if (url === STS_URL) await gate;
      return gcpHandler({ exp })(url);
    });
    const e = redberryExporter(gcpOpts(f, { now: () => clock }));
    const a = exportOnce(e, spans());
    const b = exportOnce(e, spans());
    release();
    await Promise.all([a, b]);
    expect(calls.filter((c) => c.url === STS_URL)).toHaveLength(1);
    await exportOnce(e, spans());
    expect(calls.filter((c) => c.url === STS_URL)).toHaveLength(1);
    clock = exp * 1000 - REFRESH_MARGIN_MS + 1;
    await exportOnce(e, spans());
    expect(calls.filter((c) => c.url === STS_URL)).toHaveLength(2);
  });
});

describe('redberryExporter: failures', () => {
  it('retries 429, 5xx and 403 (re-minting the token after 403), then succeeds', async () => {
    const statuses = [503, 429, 403, 200];
    const { f, calls } = mockFetch(gcpHandler({ ingest: () => new Response('', { status: statuses.shift()! }) }));
    const r = await exportOnce(redberryExporter(gcpOpts(f)), spans());
    expect(r.code).toBe(ExportResultCode.SUCCESS);
    expect(calls.filter((c) => c.url.endsWith('/v1/traces'))).toHaveLength(4);
    expect(calls.filter((c) => c.url === STS_URL)).toHaveLength(2);
  });

  it('resolves FAILED without throwing, counts dropped spans and does not retry a 400', async () => {
    const { f, calls } = mockFetch(gcpHandler({ ingest: () => new Response('', { status: 400 }) }));
    const e = redberryExporter(gcpOpts(f));
    const r = await exportOnce(e, spans());
    expect(r.code).toBe(ExportResultCode.FAILED);
    expect(calls.filter((c) => c.url.endsWith('/v1/traces'))).toHaveLength(1);
    expect(e.droppedSpans()).toBe(2);
  });

  it('resolves FAILED when the token chain throws or the network fails, within the time bound', async () => {
    const { f } = mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    const e = redberryExporter(gcpOpts(f, { timeoutMillis: 200, retryDelaysMs: [50, 50, 50, 50, 50, 50] }));
    const t = Date.now();
    const r = await exportOnce(e, spans());
    expect(r.code).toBe(ExportResultCode.FAILED);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(e.droppedSpans()).toBe(2);
    await e.shutdown();
    expect((await exportOnce(e, spans())).code).toBe(ExportResultCode.FAILED);
  });
});

describe('redberryExporter: aws', () => {
  const STS_XML = `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials>
    <AccessKeyId>ASIAEXAMPLE</AccessKeyId><SecretAccessKey>secret</SecretAccessKey><SessionToken>session</SessionToken>
    <Expiration>2099-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`;
  const URL_ = 'https://abc123.lambda-url.eu-west-1.on.aws';

  it('assumes the role with the Vercel OIDC token and SigV4-signs the POST for lambda', async () => {
    const { f, calls } = mockFetch((url) => (url.startsWith('https://sts.') ? new Response(STS_XML) : new Response('')));
    const e = redberryExporter({
      cloud: 'aws',
      endpoint: URL_,
      region: 'eu-west-1',
      roleArn: 'arn:aws:iam::123456789012:role/redberry-ingest',
      env: { VERCEL: '1' },
      fetch: f,
      getOidcToken: async () => OIDC,
    });
    expect((await exportOnce(e, spans())).code).toBe(ExportResultCode.SUCCESS);
    expect(calls[0]!.url).toBe('https://sts.eu-west-1.amazonaws.com/');
    const form = Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)));
    expect(form).toMatchObject({ Action: 'AssumeRoleWithWebIdentity', RoleArn: 'arn:aws:iam::123456789012:role/redberry-ingest', WebIdentityToken: OIDC });
    const h = headersOf(calls[1]!);
    expect(calls[1]!.url).toBe(`${URL_}/v1/traces`);
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE\/\d{8}\/eu-west-1\/lambda\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    expect(h['x-amz-security-token']).toBe('session');
    expect(h['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(h['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
    await exportOnce(e, spans());
    expect(calls.filter((c) => c.url.startsWith('https://sts.'))).toHaveLength(1);
  });

  it("uses the Lambda environment's credentials when there is no role", async () => {
    const { f, calls } = mockFetch(() => new Response(''));
    const e = redberryExporter({
      cloud: 'aws',
      endpoint: URL_,
      region: 'eu-west-1',
      env: { AWS_ACCESS_KEY_ID: 'AKIDLAMBDA', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 'tok' },
      fetch: f,
    });
    expect((await exportOnce(e, spans())).code).toBe(ExportResultCode.SUCCESS);
    expect(calls).toHaveLength(1);
    expect(headersOf(calls[0]!).authorization).toContain('Credential=AKIDLAMBDA/');
    expect(headersOf(calls[0]!)['x-amz-security-token']).toBe('tok');
  });
});

describe('redberryExporter: azure', () => {
  it('sends the Vercel OIDC token as a client assertion and the access token as Bearer', async () => {
    const { f, calls } = mockFetch((url) => (url.startsWith('https://login.') ? ok({ access_token: 'entra', expires_in: 3599 }) : new Response('')));
    const e = redberryExporter({
      cloud: 'azure',
      endpoint: 'https://ingest.example.azurewebsites.net',
      tenantId: 'tenant-1',
      clientId: 'client-1',
      scope: 'api://redberry-ingest/.default',
      fetch: f,
      getOidcToken: async () => OIDC,
    });
    expect((await exportOnce(e, spans())).code).toBe(ExportResultCode.SUCCESS);
    expect(calls[0]!.url).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init.body)))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'client-1',
      scope: 'api://redberry-ingest/.default',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: OIDC,
    });
    expect(headersOf(calls[1]!).authorization).toBe('Bearer entra');
  });
});

describe('validateAgentName', () => {
  it('accepts 1-64 printable characters without surrounding whitespace', () => {
    expect(validateAgentName('refund-agent')).toBe('refund-agent');
    expect(validateAgentName('a'.repeat(64))).toHaveLength(64);
    expect(validateAgentName('Agent ünd 2')).toBe('Agent ünd 2');
  });
  it.each([[''], ['a'.repeat(65)], [' lead'], ['trail '], ['tab\tin'], ['nl\n'], [42], [undefined]])('refuses %j', (v) => {
    expect(() => validateAgentName(v)).toThrow();
  });
});

describe('init', () => {
  const KEY = Symbol.for('@redberrylabs/otel.init');
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[KEY];
    trace.disable();
  });

  it('reads the environment, sets redberry.agent.name, and is idempotent', async () => {
    const { f, calls } = mockFetch(gcpHandler());
    const env = {
      REDBERRY_INGEST_URL: INGEST,
      REDBERRY_CLOUD: 'gcp',
      REDBERRY_GCP_PROJECT_NUMBER: '1',
      REDBERRY_GCP_POOL_ID: 'p',
      REDBERRY_GCP_PROVIDER_ID: 'v',
      REDBERRY_GCP_SERVICE_ACCOUNT: 'sa@p.iam.gserviceaccount.com',
    };
    const a = init({ agent: 'refund-agent', env, fetch: f, getOidcToken: async () => OIDC });
    const b = init({ agent: 'other', env, fetch: f });
    expect(b).toBe(a);
    trace.getTracer('t').startSpan('x').end();
    await a.provider.forceFlush();
    const post = calls.find((c) => c.url === `${INGEST}/v1/traces`)!;
    const body = JSON.parse(String(post.init.body));
    expect(body.resourceSpans[0].resource.attributes).toContainEqual({ key: AGENT_NAME_ATTRIBUTE, value: { stringValue: 'refund-agent' } });
    await a.shutdown();
  });

  it('refuses a bad agent name or incomplete configuration', () => {
    expect(() => init({ agent: ' x', env: {} })).toThrow(/whitespace/);
    expect(() => init({ agent: 'x', env: {} })).toThrow(/REDBERRY_INGEST_URL/);
    expect(() => exporterOptionsFrom({}, { REDBERRY_INGEST_URL: INGEST, REDBERRY_CLOUD: 'ibm' })).toThrow(/REDBERRY_CLOUD/);
    expect(exporterOptionsFrom({}, { REDBERRY_INGEST_URL: INGEST, REDBERRY_CLOUD: 'azure', REDBERRY_AZURE_TENANT_ID: 't', REDBERRY_AZURE_CLIENT_ID: 'c', REDBERRY_AZURE_SCOPE: 's' })).toMatchObject({
      cloud: 'azure',
      tenantId: 't',
      clientId: 'c',
      scope: 's',
    });
  });
});
