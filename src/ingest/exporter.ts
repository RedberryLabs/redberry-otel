// redberryExporter: an OpenTelemetry SpanExporter that sends finished spans, as OTLP/HTTP JSON, to the
// Redberry ingest service installed in the customer's own cloud. The agent only emits; hashing, storage and
// scoring happen behind the ingest service.
//
// It never throws into the application: every failure resolves ExportResultCode.FAILED, is logged once per
// kind through the OpenTelemetry diag logger, and its spans are counted in droppedSpans().
//
// When the install cannot be found (discovery on AWS or Azure), that is said once, with a code, on the
// console as well (where Lambda, Azure and Vercel logs show it): RB-SDK-DISC-002 (AWS) or RB-SDK-DISC-003
// (Azure). Exports fail at once meanwhile, and discovery is tried again every ``discoveryRetryMs`` (default
// 300000; REDBERRY_DISCOVERY_RETRY_S). Once it succeeds the exporter sends there, and for an hour
// ``recentRecovery()`` reports the outage, which discoveryFailureMarker() stamps on new spans.
import { diag } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { sleep, trimBase, type Fetch } from '../http';
import {
  awsCredential,
  azureCredential,
  gcpCredential,
  type IngestCredential,
} from './credentials';
import { encodeOtlpJson } from './otlp';
import { discoverAwsIngest } from './discover-aws';
import { discoverAzureIngest } from './discover-azure';

export type Cloud = 'gcp' | 'aws' | 'azure';

interface Base {
  /** The ingest service's base URL; spans go to ``<endpoint>/v1/traces``. On AWS it may be left out: the
   * exporter reads it from the installation's ``s3://redberry-<account>-<region>/ingest.json``. */
  endpoint?: string;
  /** The whole export's time bound, retries included (default 10000). */
  timeoutMillis?: number;
  fetch?: Fetch;
  /** Default: getVercelOidcToken from @vercel/functions/oidc. */
  getOidcToken?: () => Promise<string>;
  now?: () => number;
  /** Waits before retries (default 250, 1000, 3000 ms), cut short by ``timeoutMillis``. */
  retryDelaysMs?: readonly number[];
  /** After a failed discovery, how long until it is tried again (default 300000). */
  discoveryRetryMs?: number;
  /** Where the coded discovery messages go besides ``diag`` (default: console). */
  logger?: Pick<Console, 'error' | 'warn'>;
}

export interface GcpExporterOptions extends Base {
  cloud: 'gcp';
  projectNumber: string | number;
  poolId: string;
  providerId: string;
  serviceAccount: string;
}

export interface AwsExporterOptions extends Base {
  cloud: 'aws';
  region: string;
  roleArn?: string;
  env?: Record<string, string | undefined>;
}

export interface AzureExporterOptions extends Base {
  cloud: 'azure';
  /** Vercel: the identity federated with the Vercel issuer. On Azure the managed identity is used instead. */
  tenantId?: string;
  clientId?: string;
  scope: string;
  /** Redberry's API, asked for the ingest URL when ``endpoint`` is left out (default: dev). */
  apiUrl?: string;
  env?: Record<string, string | undefined>;
}

export type RedberryExporterOptions = GcpExporterOptions | AwsExporterOptions | AzureExporterOptions;

export interface RedberryExporter extends SpanExporter {
  /** Spans whose export failed, saturating at ``Number.MAX_SAFE_INTEGER``. */
  droppedSpans(): number;
  /** A discovery failure that ended within the last hour: its code and how many minutes it lasted. */
  recentRecovery(): { code: string; minutes: number } | undefined;
}

export const DEFAULT_DISCOVERY_RETRY_MS = 300_000;
/** How long after recovering the outage is reported on new spans. */
export const RECOVERY_SHOWN_MS = 3_600_000;
export const DISCOVERY_FAILURE_ATTRIBUTE = 'redberry.sdk.discovery_failure';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_EXPORT_RETRY_DELAYS_MS = [250, 1000, 3000] as const;
const CONTENT_TYPE = 'application/json';
// ExportResultCode of @opentelemetry/core (a dependency of sdk-trace-base), without a runtime import of it.
export const ExportResultCode = { SUCCESS: 0, FAILED: 1 } as const;

const retryStatus = (s: number): boolean => s === 429 || s >= 500 || s === 401 || s === 403;

function credentialFor(o: RedberryExporterOptions): IngestCredential {
  const common = { fetch: o.fetch, getOidcToken: o.getOidcToken, now: o.now };
  switch (o.cloud) {
    case 'gcp':
      return gcpCredential({ ...common, audience: trimBase(o.endpoint ?? ""), projectNumber: o.projectNumber, poolId: o.poolId, providerId: o.providerId, serviceAccount: o.serviceAccount });
    case 'aws':
      return awsCredential({ ...common, region: o.region, roleArn: o.roleArn, env: o.env });
    case 'azure':
      return azureCredential({ ...common, tenantId: o.tenantId, clientId: o.clientId, scope: o.scope, env: o.env });
    default:
      throw new Error(`redberryExporter(): cloud must be gcp, aws or azure, not ${String((o as { cloud?: unknown }).cloud)}`);
  }
}

/** An OTLP/HTTP span exporter to a Redberry ingest service. Throws only on invalid options. */
export function redberryExporter(options: RedberryExporterOptions): RedberryExporter {
  if (!options?.endpoint && options?.cloud !== 'aws' && options?.cloud !== 'azure') {
    throw new Error('redberryExporter(): endpoint is required');
  }
  const credential = credentialFor(options);
  const now = options.now ?? Date.now;
  const log = options.logger ?? console;
  const retryMs = Math.max(5_000, options.discoveryRetryMs ?? DEFAULT_DISCOVERY_RETRY_MS);
  // Discovery state: the current failure (code, since, next attempt) and the last recovery.
  let failure: { code: string; since: number; next: number } | undefined;
  let recovered: { code: string; minutes: number; at: number } | undefined;
  const say = (level: 'error' | 'warn', message: string) => {
    try {
      log[level](message);
      diag[level](message);
    } catch {
      // never let logging escape
    }
  };
  const discover = (): Promise<string> => {
    if (options.cloud === 'azure' && credential.azureToken) {
      return discoverAzureIngest({ token: credential.azureToken, apiUrl: options.apiUrl, fetch: options.fetch }).then((u) => `${u}/v1/traces`);
    }
    const creds = credential.awsCredentials;
    if (!creds || options.cloud !== 'aws') return Promise.reject(new Error('no endpoint'));
    return discoverAwsIngest({ region: options.region, credentials: creds, fetch: options.fetch, now: options.now }).then((d) => `${d.url}/v1/traces`);
  };
  // The traces URL: fixed, or (AWS, Azure; no endpoint) discovered once and cached. A failed discovery is
  // said once, with its code, and tried again only every retryMs; exports fail at once in between.
  let discovered: Promise<string> | undefined;
  const urlOf = (): Promise<string> => {
    if (options.endpoint) return Promise.resolve(`${trimBase(options.endpoint)}/v1/traces`);
    if (discovered) return discovered;
    if (failure && now() < failure.next) {
      return Promise.reject(new Error(`${failure.code}: the install has not been found yet; tried again in ${Math.ceil((failure.next - now()) / 1000)} s`));
    }
    discovered = discover().then(
      (url) => {
        if (failure) {
          const minutes = Math.max(1, Math.round((now() - failure.since) / 60_000));
          recovered = { code: failure.code, minutes, at: now() };
          say('warn', `@redberrylabs/otel: ${failure.code} resolved: the Redberry install was found after about ${minutes} min; sending spans to ${url}. Spans from before were not delivered (droppedSpans()).`);
          failure = undefined;
        }
        return url;
      },
      (e: unknown) => {
        discovered = undefined;
        const code = options.cloud === 'azure' ? 'RB-SDK-DISC-003' : 'RB-SDK-DISC-002';
        const first = !failure;
        failure = { code, since: failure?.since ?? now(), next: now() + retryMs };
        if (first) {
          const detail = e instanceof Error ? e.message : String(e);
          const fix =
            options.cloud === 'azure'
              ? 'check that the app has a managed identity and was chosen as an agent (re-run the install and select it), or set REDBERRY_INGEST_URL'
              : 'check that the install ran in this account and region and that this function was chosen as an agent (re-run the install and select it), or set REDBERRY_INGEST_URL';
          say('error', `@redberrylabs/otel: ${code}: the Redberry install could not be found (${detail}): ${fix}. Spans are not delivered until this is fixed; discovery is tried again every ${Math.round(retryMs / 1000)} s.`);
        }
        throw e;
      },
    );
    return discovered;
  };
  const f: Fetch = options.fetch ?? ((...a) => fetch(...a));
  const timeout = options.timeoutMillis ?? DEFAULT_TIMEOUT_MS;
  const delays = options.retryDelaysMs ?? DEFAULT_EXPORT_RETRY_DELAYS_MS;
  const logged = new Set<string>();
  const inFlight = new Set<Promise<unknown>>();
  let dropped = 0;
  let stopped = false;

  const fail = (kind: string, detail: string, count: number): ExportResult => {
    dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + count);
    if (!logged.has(kind)) {
      logged.add(kind);
      diag.warn(`@redberrylabs/otel: export failed (${kind}): ${detail}`);
    }
    return { code: ExportResultCode.FAILED as ExportResult['code'], error: new Error(`${kind}: ${detail}`) };
  };

  async function send(spans: ReadableSpan[]): Promise<ExportResult> {
    let body: string;
    try {
      body = encodeOtlpJson(spans);
    } catch (e) {
      return fail('encode', String(e), spans.length);
    }
    const deadline = Date.now() + timeout;
    let url: string;
    try {
      url = await urlOf();
    } catch (e) {
      return fail('discovery', e instanceof Error ? e.message : String(e), spans.length);
    }
    let last = { kind: 'unknown', detail: '' };
    for (let attempt = 0; ; attempt++) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      try {
        const headers = await credential.headers(url, body, CONTENT_TYPE);
        const r = await f(url, {
          method: 'POST',
          headers: { 'content-type': CONTENT_TYPE, ...headers },
          body,
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        await r.body?.cancel().catch(() => undefined);
        if (r.ok) return { code: ExportResultCode.SUCCESS as ExportResult['code'] };
        last = { kind: `http-${r.status}`, detail: `HTTP ${r.status} from ${url}` };
        if (r.status === 401 || r.status === 403) credential.invalidate();
        if (!retryStatus(r.status)) break;
      } catch (e) {
        last = { kind: 'error', detail: e instanceof Error ? e.message : String(e) };
      }
      const wait = delays[attempt];
      if (wait === undefined || Date.now() + wait >= deadline) break;
      await sleep(wait);
    }
    return fail(last.kind, last.detail, spans.length);
  }

  return {
    export(spans, resultCallback) {
      if (stopped) {
        resultCallback(fail('shutdown', 'exporter is shut down', spans.length));
        return;
      }
      const p = send(spans)
        .catch((e) => fail('error', String(e), spans.length))
        .then((r) => {
          try {
            resultCallback(r);
          } catch {
            // never let a callback error escape
          }
        });
      inFlight.add(p);
      void p.finally(() => inFlight.delete(p));
    },
    async forceFlush() {
      await Promise.all([...inFlight]);
    },
    async shutdown() {
      stopped = true;
      await Promise.all([...inFlight]);
    },
    droppedSpans: () => dropped,
    recentRecovery: () =>
      recovered && now() - recovered.at < RECOVERY_SHOWN_MS ? { code: recovered.code, minutes: recovered.minutes } : undefined,
  };
}
