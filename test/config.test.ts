import { describe, expect, it } from 'vitest';
import { matchRoute, resolveAgent, routeCandidates } from '../src/agents';
import { resolveConfig, type Logger } from '../src/config';
import { AGENT, AGENT_B, productionEnv, SIGNING_KEY, TOKEN } from './helpers';

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
});
