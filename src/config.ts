// Options, with defaults from the environment. Nothing here throws: a misconfigured processor logs one
// warning and does nothing, rather than breaking the customer's app at start-up.
import { isAgentId } from './agents';
import type { Fetch } from './http';
import type { TraceResult } from './processor';
import { azureBlob } from './stores/azure-blob';
import { gcs } from './stores/gcs';
import { redberry } from './stores/redberry';
import type { Store } from './stores/types';
import { vercelBlob } from './stores/vercel-blob';

export interface Logger {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface RedberryOptions {
  /** The agent every trace belongs to, unless ``agentsByRoute`` matches. Env: REDBERRY_AGENT_ID. */
  agentId?: string;
  /** Route -> agent id, matched against the root span's http.route / next.route / URL path. Env: REDBERRY_AGENTS (JSON). */
  agentsByRoute?: Record<string, string>;
  /** Where the bytes go. Env: REDBERRY_STORE = redberry (default) | vercel-blob | gcs | azure-blob. */
  store?: Store;
  /** VALP base URL. Env: REDBERRY_URL. */
  url?: string;
  /** The project token (64 hex). Env: REDBERRY_PROJECT_TOKEN. */
  token?: string;
  /** base64 PKCS8 Ed25519 private key. Env: REDBERRY_SIGNING_KEY. */
  signingKey?: string;
  /** Checked against the key when given; derived from it otherwise. Env: REDBERRY_KEY_ID. */
  keyId?: string;
  /**
   * Run in every Vercel environment, not only production, and anywhere else that is neither Vercel nor
   * Azure App Service / Functions. Env: REDBERRY_ALL_ENVS=1.
   */
  allEnvs?: boolean;
  /** Quiet period after the root ends and nothing is open, before finalising (ms, default 2000). */
  graceMs?: number;
  /** Finalise as cut_short this long after the root ended even if spans are still open (ms, default 60000). */
  hardStopMs?: number;
  /**
   * The function's time budget (its maxDuration), ms. When set, a trace still open ``deadlineMarginMs``
   * before the deadline (or before Vercel's own invocation deadline, if earlier) is finalised as
   * cut_short. Env: REDBERRY_DEADLINE_MS. Default: unset (no deadline timer).
   */
  deadlineMs?: number;
  /** How long before the deadline to cut (ms, default 5000). Env: REDBERRY_DEADLINE_MARGIN_MS. */
  deadlineMarginMs?: number;
  /** Only hash traces with an AI SDK span (gen_ai or ai.*). Default true. */
  requireAiSpans?: boolean;
  /** Most traces open at once; more are ignored and counted (default 1000). */
  maxTraces?: number;
  /** Most spans kept per trace; more are dropped and counted (default 10000). */
  maxSpansPerTrace?: number;
  logger?: Logger;
  /** Called once per finalised trace, after store and report (tests, metrics). */
  onResult?: (r: TraceResult) => void;
  fetch?: Fetch;
  retryDelaysMs?: readonly number[];
}

/** Where the processor runs: decides the enablement rule and how background work is kept alive. */
export type Platform = 'vercel' | 'azure' | 'other';

export interface ResolvedConfig {
  enabled: boolean;
  disabledReason?: string;
  platform: Platform;
  agentId?: string;
  agentsByRoute?: Record<string, string>;
  store?: Store;
  url: string;
  token: string;
  signingKey: string;
  keyId?: string;
  graceMs: number;
  hardStopMs: number;
  deadlineMs?: number;
  deadlineMarginMs: number;
  requireAiSpans: boolean;
  maxTraces: number;
  maxSpansPerTrace: number;
  logger: Logger;
  onResult?: (r: TraceResult) => void;
  fetch?: Fetch;
  retryDelaysMs?: readonly number[];
}

type Env = Record<string, string | undefined>;

const TOKEN = /^[0-9a-f]{64}$/;

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export const defaultLogger: Logger = {
  debug: (...a) => (process.env.REDBERRY_DEBUG ? console.debug('[redberry]', ...a) : undefined),
  info: (...a) => console.info('[redberry]', ...a),
  warn: (...a) => console.warn('[redberry]', ...a),
  error: (...a) => console.error('[redberry]', ...a),
};

/** Vercel when VERCEL_ENV (or VERCEL) is set; Azure App Service / Functions when WEBSITE_SITE_NAME is. */
export function platformOf(env: Env): Platform {
  if (env.VERCEL_ENV || env.VERCEL) return 'vercel';
  if (env.WEBSITE_SITE_NAME) return 'azure';
  return 'other';
}

/**
 * The store named by REDBERRY_STORE: ``redberry`` (the default, as in the CLI), ``vercel-blob``, ``gcs``
 * (with REDBERRY_GCS_BUCKET, GCP_PROJECT_NUMBER, GCP_WORKLOAD_POOL, GCP_WORKLOAD_PROVIDER, GCP_SERVICE_ACCOUNT)
 * or ``azure-blob`` (with REDBERRY_AZURE_CONTAINER_URL, REDBERRY_AZURE_TENANT_ID and REDBERRY_AZURE_CLIENT_ID, or
 * AZURE_TENANT_ID and AZURE_CLIENT_ID as fallbacks).
 */
export function storeFromEnv(env: Env, url?: string, token?: string, fetchImpl?: Fetch): Store {
  const kind = (env.REDBERRY_STORE || 'redberry').trim();
  switch (kind) {
    case 'vercel-blob':
      return vercelBlob();
    case 'redberry':
      return redberry({ url, token, fetch: fetchImpl });
    case 'gcs':
      // The names `redberry connect --platform vercel --store gcs` sets (from `redberry setup-gcs`).
      return gcs({
        bucket: env.REDBERRY_GCS_BUCKET ?? '',
        projectNumber: env.GCP_PROJECT_NUMBER ?? '',
        poolId: env.GCP_WORKLOAD_POOL ?? '',
        providerId: env.GCP_WORKLOAD_PROVIDER ?? '',
        serviceAccount: env.GCP_SERVICE_ACCOUNT ?? '',
        fetch: fetchImpl,
      });
    case 'azure-blob':
      // The names `redberry connect --store azure-blob` sets (from `redberry setup-azure`).
      return azureBlob({
        containerUrl: env.REDBERRY_AZURE_CONTAINER_URL ?? '',
        // REDBERRY_AZURE_* first: AZURE_CLIENT_ID app-wide would also change which identity the app's own
        // DefaultAzureCredential uses.
        tenantId: env.REDBERRY_AZURE_TENANT_ID || env.AZURE_TENANT_ID || undefined,
        clientId: env.REDBERRY_AZURE_CLIENT_ID || env.AZURE_CLIENT_ID || undefined,
        env,
        fetch: fetchImpl,
      });
    default:
      throw new Error(`REDBERRY_STORE must be redberry, vercel-blob, gcs or azure-blob, not ${JSON.stringify(kind)}`);
  }
}

export function resolveConfig(o: RedberryOptions = {}, env: Env = process.env): ResolvedConfig {
  const logger = o.logger ?? defaultLogger;
  const url = o.url ?? env.REDBERRY_URL ?? '';
  const token = o.token ?? env.REDBERRY_PROJECT_TOKEN ?? '';
  const platform = platformOf(env);
  const base: ResolvedConfig = {
    enabled: false,
    platform,
    url,
    token,
    signingKey: o.signingKey ?? env.REDBERRY_SIGNING_KEY ?? '',
    keyId: o.keyId ?? env.REDBERRY_KEY_ID ?? undefined,
    agentId: o.agentId ?? env.REDBERRY_AGENT_ID ?? undefined,
    graceMs: o.graceMs ?? 2000,
    hardStopMs: o.hardStopMs ?? 60_000,
    deadlineMs: o.deadlineMs ?? num(env.REDBERRY_DEADLINE_MS),
    deadlineMarginMs: o.deadlineMarginMs ?? num(env.REDBERRY_DEADLINE_MARGIN_MS) ?? 5000,
    requireAiSpans: o.requireAiSpans ?? true,
    maxTraces: o.maxTraces ?? 1000,
    maxSpansPerTrace: o.maxSpansPerTrace ?? 10_000,
    logger,
    onResult: o.onResult,
    fetch: o.fetch,
    retryDelaysMs: o.retryDelaysMs,
  };
  const off = (reason: string, warn = true): ResolvedConfig => {
    if (warn) logger.warn(`disabled: ${reason}`);
    return { ...base, enabled: false, disabledReason: reason };
  };

  if (env.NEXT_RUNTIME === 'edge') return off('the Edge runtime is not supported; register RedberryProcessor in the Node.js runtime only');
  if (env.REDBERRY_DISABLED === '1') return off('REDBERRY_DISABLED=1', false);
  // Vercel: production only. Azure App Service / Functions: always (it has no preview environments of its
  // own). Anywhere else (local development, CI): off.
  const allEnvs = o.allEnvs ?? env.REDBERRY_ALL_ENVS === '1';
  if (!allEnvs && platform === 'vercel' && env.VERCEL_ENV !== 'production') {
    return off(`not production (VERCEL_ENV=${env.VERCEL_ENV ?? 'unset'}); set REDBERRY_ALL_ENVS=1 to run here`, false);
  }
  if (!allEnvs && platform === 'other') {
    return off('not on Vercel or Azure (VERCEL_ENV and WEBSITE_SITE_NAME unset); set REDBERRY_ALL_ENVS=1 to run here', false);
  }

  let agentsByRoute = o.agentsByRoute;
  if (!agentsByRoute && env.REDBERRY_AGENTS) {
    try {
      const parsed: unknown = JSON.parse(env.REDBERRY_AGENTS);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      agentsByRoute = parsed as Record<string, string>;
    } catch (e) {
      return off(`REDBERRY_AGENTS is not a JSON object of route -> agent id (${String(e)})`);
    }
  }
  const agents = [...Object.values(agentsByRoute ?? {}), ...(base.agentId ? [base.agentId] : [])];
  // Outside Vercel, withRedberry(handler, { agentId }) can name the agent on the invocation's root span instead.
  if (agents.length === 0 && platform === 'vercel') return off('no agent: set REDBERRY_AGENT_ID or REDBERRY_AGENTS (or agentId / agentsByRoute)');
  const bad = agents.filter((a) => !isAgentId(a));
  if (bad.length) return off(`not agent ids (AGT- and a ULID): ${bad.join(', ')}`);
  if (!url) return off('REDBERRY_URL is not set');
  try {
    new URL(url);
  } catch {
    return off(`REDBERRY_URL is not a URL: ${url}`);
  }
  if (!TOKEN.test(token)) return off('REDBERRY_PROJECT_TOKEN is not set or not 64 lowercase hex characters');
  if (!base.signingKey) return off('REDBERRY_SIGNING_KEY is not set');
  if (base.keyId !== undefined && !/^[0-9a-f]{32}$/.test(base.keyId)) return off('REDBERRY_KEY_ID is not 32 lowercase hex characters');

  let store = o.store;
  if (!store) {
    try {
      store = storeFromEnv(env, url, token, o.fetch);
    } catch (e) {
      return off(String((e as Error).message ?? e));
    }
  }
  return { ...base, agentsByRoute, store, enabled: true };
}
