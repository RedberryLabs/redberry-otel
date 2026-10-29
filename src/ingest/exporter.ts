// redberryExporter: an OpenTelemetry SpanExporter that sends finished spans, as OTLP/HTTP JSON, to the
// Redberry ingest service installed in the customer's own cloud. The agent only emits; hashing, storage and
// scoring happen behind the ingest service.
//
// It never throws into the application: every failure resolves ExportResultCode.FAILED, is logged once per
// kind through the OpenTelemetry diag logger, and its spans are counted in droppedSpans().
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

export type Cloud = 'gcp' | 'aws' | 'azure';

interface Base {
  /** The ingest service's base URL; spans go to ``<endpoint>/v1/traces``. */
  endpoint: string;
  /** The whole export's time bound, retries included (default 10000). */
  timeoutMillis?: number;
  fetch?: Fetch;
  /** Default: getVercelOidcToken from @vercel/functions/oidc. */
  getOidcToken?: () => Promise<string>;
  now?: () => number;
  /** Waits before retries (default 250, 1000, 3000 ms), cut short by ``timeoutMillis``. */
  retryDelaysMs?: readonly number[];
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
  tenantId: string;
  clientId: string;
  scope: string;
}

export type RedberryExporterOptions = GcpExporterOptions | AwsExporterOptions | AzureExporterOptions;

export interface RedberryExporter extends SpanExporter {
  /** Spans whose export failed, saturating at ``Number.MAX_SAFE_INTEGER``. */
  droppedSpans(): number;
}

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
      return gcpCredential({ ...common, audience: trimBase(o.endpoint), projectNumber: o.projectNumber, poolId: o.poolId, providerId: o.providerId, serviceAccount: o.serviceAccount });
    case 'aws':
      return awsCredential({ ...common, region: o.region, roleArn: o.roleArn, env: o.env });
    case 'azure':
      return azureCredential({ ...common, tenantId: o.tenantId, clientId: o.clientId, scope: o.scope });
    default:
      throw new Error(`redberryExporter(): cloud must be gcp, aws or azure, not ${String((o as { cloud?: unknown }).cloud)}`);
  }
}

/** An OTLP/HTTP span exporter to a Redberry ingest service. Throws only on invalid options. */
export function redberryExporter(options: RedberryExporterOptions): RedberryExporter {
  if (!options?.endpoint) throw new Error('redberryExporter(): endpoint is required');
  const url = `${trimBase(options.endpoint)}/v1/traces`;
  const credential = credentialFor(options);
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
  };
}
