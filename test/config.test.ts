import { describe, expect, it, vi } from 'vitest';
import { matchRoute, resolveAgent, routeCandidates } from '../src/agents';
import { resolveConfig, storeFromEnv, type Logger } from '../src/config';
import { AGENT, AGENT_B, azureEnv, fakeFetch, json, productionEnv, SIGNING_KEY, TOKEN } from './helpers';

// The azure-blob store's Vercel OIDC token, outside a Vercel function.
vi.mock('@vercel/functions/oidc', () => ({ getVercelOidcToken: async () => 'vercel-oidc-jwt' }));

const quiet = (): Logger & { warnings: string[] } => {
  const warnings: string[] = [];
  return { warnings, info: () => {}, warn: (m: unknown) => warnings.push(String(m)), error: () => {} };
};

describe('agent resolution', () => {
  const map = { '/api/refund': AGENT, '/api/agents/*': AGENT_B, '/api/*': 'AGT-01K5V8QJ3M7XW2ZB4YRNCDEFGM' };

  it('collects routes from http.route, next.route and the URL path, in that order', () => {
    expect(routeCandidates({ 'http.route': '/api/[id]', 'next.route': '/api/[id]', 'http.target': '/api/7?x=1' })).toEqual(['/api/[id]', '/api/7']);
    expect(routeCandidates({ 'url.path': '/a', 'http.url': 'https://h.example/b?q' })).toEqual(['/a', '/b']);
  });

  it('matches exactly, else the longest * prefix', () => {
    expect(matchRoute('/api/refund', map)).toBe(AGENT);
    expect(matchRoute('/api/agents/sales', map)).toBe(AGENT_B);
    expect(matchRoute('/api/other', map)).toBe('AGT-01K5V8QJ3M7XW2ZB4YRNCDEFGM');
    expect(matchRoute('/health', map)).toBeUndefined();
  });

  it('uses the route map against the root span, else the default agent', () => {
    expect(resolveAgent({ 'http.route': '/api/refund' }, map, AGENT_B)).toBe(AGENT);
    expect(resolveAgent({ 'next.route': '/api/agents/[name]' }, map, undefined)).toBe(AGENT_B);
    expect(resolveAgent({ 'http.target': '/api/refund?model=x' }, map, undefined)).toBe(AGENT);
    expect(resolveAgent({ 'http.route': '/health' }, { '/api/refund': AGENT }, AGENT_B)).toBe(AGENT_B);
    expect(resolveAgent({ 'http.route': '/health' }, { '/api/refund': AGENT }, undefined)).toBeUndefined();
    expect(resolveAgent({}, undefined, AGENT)).toBe(AGENT);
  });

  it('lets the root span name its own agent (withRedberry), ahead of routes and the default', () => {
    expect(resolveAgent({ 'redberry.agent_id': AGENT_B, 'http.route': '/api/refund' }, map, AGENT)).toBe(AGENT_B);
    expect(resolveAgent({ 'redberry.agent_id': 'AGT-SPIKE', 'http.route': '/api/refund' }, map, AGENT_B)).toBe(AGENT);
  });
});

describe('resolveConfig', () => {
  it('reads everything from the environment', () => {
    const c = resolveConfig({ logger: quiet() }, productionEnv({ REDBERRY_AGENTS: JSON.stringify({ '/api/x': AGENT_B }), REDBERRY_DEADLINE_MS: '60000', REDBERRY_KEY_ID: 'a'.repeat(32) }));
    expect(c).toMatchObject({
      enabled: true, url: 'https://valp.test', token: TOKEN, signingKey: SIGNING_KEY, agentId: AGENT,
      agentsByRoute: { '/api/x': AGENT_B }, deadlineMs: 60000, deadlineMarginMs: 5000, graceMs: 2000, hardStopMs: 60000, keyId: 'a'.repeat(32),
    });
    expect(c.store?.kind).toBe('redberry');
  });

  it('options win over the environment', () => {
    const c = resolveConfig({ agentId: AGENT_B, url: 'https://other.test', graceMs: 10, logger: quiet() }, productionEnv());
    expect(c).toMatchObject({ enabled: true, agentId: AGENT_B, url: 'https://other.test', graceMs: 10 });
  });

  it('is production-only unless REDBERRY_ALL_ENVS=1 (or allEnvs)', () => {
    const log = quiet();
    expect(resolveConfig({ logger: log }, productionEnv({ VERCEL_ENV: 'preview' }))).toMatchObject({ enabled: false, disabledReason: expect.stringMatching(/not production/) });
    expect(log.warnings).toEqual([]); // quiet in preview and development
    expect(resolveConfig({ logger: log }, productionEnv({ VERCEL_ENV: 'preview', REDBERRY_ALL_ENVS: '1' })).enabled).toBe(true);
    expect(resolveConfig({ logger: log, allEnvs: true }, { ...productionEnv(), VERCEL_ENV: undefined }).enabled).toBe(true);
  });

  it('runs on Azure App Service / Functions (WEBSITE_SITE_NAME) unless REDBERRY_DISABLED=1', () => {
    const log = quiet();
    expect(resolveConfig({ logger: log }, azureEnv())).toMatchObject({ enabled: true, platform: 'azure' });
    expect(resolveConfig({ logger: log }, azureEnv({ REDBERRY_DISABLED: '1' }))).toMatchObject({ enabled: false, disabledReason: 'REDBERRY_DISABLED=1' });
    expect(resolveConfig({ logger: log }, productionEnv({ REDBERRY_DISABLED: '1' })).enabled).toBe(false);
    expect(log.warnings).toEqual([]);
  });

  it('is off elsewhere (local development, CI) unless REDBERRY_ALL_ENVS=1', () => {
    const log = quiet();
    const { WEBSITE_SITE_NAME: _site, ...local } = azureEnv();
    expect(resolveConfig({ logger: log }, local)).toMatchObject({ enabled: false, platform: 'other', disabledReason: expect.stringMatching(/not on Vercel or Azure/) });
    expect(resolveConfig({ logger: log }, { ...local, REDBERRY_ALL_ENVS: '1' })).toMatchObject({ enabled: true, platform: 'other' });
    expect(log.warnings).toEqual([]);
  });

  it('on Vercel needs a configured agent; elsewhere withRedberry may name it per handler', () => {
    expect(resolveConfig({ logger: quiet() }, productionEnv({ REDBERRY_AGENT_ID: '' })).enabled).toBe(false);
    expect(resolveConfig({ logger: quiet() }, azureEnv({ REDBERRY_AGENT_ID: '' })).enabled).toBe(true);
  });

  it('refuses the Edge runtime', () => {
    expect(resolveConfig({ logger: quiet() }, productionEnv({ NEXT_RUNTIME: 'edge' }))).toMatchObject({ enabled: false, disabledReason: expect.stringMatching(/Edge/) });
  });

  it.each([
    [{ REDBERRY_AGENT_ID: '' }, /no agent/],
    [{ REDBERRY_AGENT_ID: 'AGT-SPIKE' }, /not agent ids/],
    [{ REDBERRY_AGENTS: '[1]' }, /REDBERRY_AGENTS/],
    [{ REDBERRY_AGENTS: '{"/a": "nope"}' }, /not agent ids .*: nope/],
    [{ REDBERRY_URL: '' }, /REDBERRY_URL is not set/],
    [{ REDBERRY_URL: 'valp' }, /not a URL/],
    [{ REDBERRY_PROJECT_TOKEN: 'short' }, /PROJECT_TOKEN/],
    [{ REDBERRY_SIGNING_KEY: '' }, /SIGNING_KEY/],
    [{ REDBERRY_KEY_ID: 'xyz' }, /KEY_ID/],
    [{ REDBERRY_STORE: 's3' }, /REDBERRY_STORE must be/],
    [{ REDBERRY_STORE: 'gcs' }, /bucket is required/],
  ])('disables itself with one warning for %j', (env, why) => {
    const log = quiet();
    const c = resolveConfig({ logger: log }, productionEnv(env as Record<string, string>));
    expect(c.enabled).toBe(false);
    expect(c.disabledReason).toMatch(why);
    expect(log.warnings).toHaveLength(1);
  });

  it('builds the store REDBERRY_STORE names', () => {
    expect(resolveConfig({ logger: quiet() }, productionEnv({ REDBERRY_STORE: 'vercel-blob' })).store?.kind).toBe('vercel-blob');
    expect(resolveConfig({ logger: quiet() }, productionEnv({ REDBERRY_STORE: 'redberry' })).store?.kind).toBe('redberry');
    // The names `redberry connect --platform vercel --store gcs` writes.
    const gcsEnv = { REDBERRY_STORE: 'gcs', REDBERRY_GCS_BUCKET: 'b', GCP_PROJECT_NUMBER: '1', GCP_WORKLOAD_POOL: 'redberry-vercel', GCP_WORKLOAD_PROVIDER: 'vercel-acme', GCP_SERVICE_ACCOUNT: 'redberry-trace-writer@x.iam.gserviceaccount.com' };
    expect(resolveConfig({ logger: quiet() }, productionEnv(gcsEnv)).store?.kind).toBe('gcs');
  });

  it('builds the azure-blob store from the names `redberry connect --store azure-blob` writes', async () => {
    const azure = {
      REDBERRY_STORE: 'azure-blob',
      REDBERRY_AZURE_CONTAINER_URL: 'https://acmetraces.blob.core.windows.net/redberry-runs',
      AZURE_TENANT_ID: '0f3a2b1c-1111-2222-3333-444455556666',
      AZURE_CLIENT_ID: '9e8d7c6b-aaaa-bbbb-cccc-ddddeeeeffff',
    };
    // Vercel: OIDC -> Entra ID.
    expect(resolveConfig({ logger: quiet() }, productionEnv({ ...azure, VERCEL: '1' })).store?.kind).toBe('azure-blob');
    // Azure Functions: the managed-identity endpoint.
    const functions = azureEnv({ ...azure, IDENTITY_ENDPOINT: 'http://localhost:8081/msi/token', IDENTITY_HEADER: 'h' });
    expect(resolveConfig({ logger: quiet() }, functions).store?.kind).toBe('azure-blob');
    // The REDBERRY_AZURE_* names win over the app-wide AZURE_* ones, which stay as fallbacks.
    const f = fakeFetch(() => json(200, { access_token: 't', expires_in: 3600 }));
    const named = {
      REDBERRY_STORE: 'azure-blob', REDBERRY_AZURE_CONTAINER_URL: azure.REDBERRY_AZURE_CONTAINER_URL,
      REDBERRY_AZURE_TENANT_ID: 'tenant-redberry', REDBERRY_AZURE_CLIENT_ID: 'client-redberry',
      AZURE_TENANT_ID: 'tenant-app', AZURE_CLIENT_ID: 'client-app', VERCEL: '1',
    };
    const store = storeFromEnv(productionEnv(named), undefined, undefined, f);
    await store.put('redberry/a.json.gz', new Uint8Array([1]), { agentId: AGENT, traceId: 't', sha256: 'ab', size: 1 }).catch(() => undefined);
    expect(f.calls[0]!.url).toContain('/tenant-redberry/');
    expect(new URLSearchParams(new TextDecoder().decode(f.calls[0]!.body)).get('client_id')).toBe('client-redberry');
    const mi = fakeFetch(() => json(200, { access_token: 't', expires_on: '9999999999' }));
    const functions2 = azureEnv({ ...named, VERCEL: '', IDENTITY_ENDPOINT: 'http://localhost:8081/msi/token', IDENTITY_HEADER: 'h' });
    await storeFromEnv(functions2, undefined, undefined, mi).put('redberry/a.json.gz', new Uint8Array([1]), { agentId: AGENT, traceId: 't', sha256: 'ab', size: 1 }).catch(() => undefined);
    expect(new URL(mi.calls[0]!.url).searchParams.get('client_id')).toBe('client-redberry');
    const { REDBERRY_AZURE_TENANT_ID: _t, REDBERRY_AZURE_CLIENT_ID: _c, ...fallback } = named;
    const g = fakeFetch(() => json(200, { access_token: 't', expires_in: 3600 }));
    await storeFromEnv(productionEnv(fallback), undefined, undefined, g).put('redberry/a.json.gz', new Uint8Array([1]), { agentId: AGENT, traceId: 't', sha256: 'ab', size: 1 }).catch(() => undefined);
    expect(g.calls[0]!.url).toContain('/tenant-app/');
    expect(new URLSearchParams(new TextDecoder().decode(g.calls[0]!.body)).get('client_id')).toBe('client-app');

    // Misconfigured: off, with one warning saying why.
    for (const [env, why] of [
      [productionEnv({ ...azure, REDBERRY_AZURE_CONTAINER_URL: '' }), /containerUrl is required/],
      [productionEnv({ ...azure, REDBERRY_AZURE_CONTAINER_URL: 'https://acme.example.com/runs' }), /blob\.core\.windows\.net/],
      [productionEnv({ ...azure, AZURE_TENANT_ID: '' }), /REDBERRY_AZURE_TENANT_ID/],
      [azureEnv(azure), /no Azure credential/],
    ] as const) {
      const log = quiet();
      const c = resolveConfig({ logger: log }, env);
      expect(c.enabled).toBe(false);
      expect(c.disabledReason).toMatch(why);
      expect(log.warnings).toHaveLength(1);
    }
  });
});
