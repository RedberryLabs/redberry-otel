// init(): the simple entry point. Registers, once per process, a tracer provider whose batch span processor
// sends every span to the Redberry ingest service in the customer's cloud, with the resource attribute
// ``redberry.agent.name``. On Vercel with @vercel/otel, pass redberryExporter() to registerOTel instead
// (see the README).
import { context, diag, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { redberryExporter, type Cloud, type RedberryExporter, type RedberryExporterOptions } from './ingest/exporter';

export const AGENT_NAME_ATTRIBUTE = 'redberry.agent.name';

type Env = Record<string, string | undefined>;

/**
 * Check an agent name: a string of 1 to 64 printable characters with no leading or trailing whitespace.
 * Returns the name; throws a TypeError or RangeError otherwise.
 */
export function validateAgentName(name: unknown): string {
  if (typeof name !== 'string') throw new TypeError('agent name must be a string');
  if (name.length < 1 || [...name].length > 64) throw new RangeError('agent name must be 1 to 64 characters');
  if (/\p{C}/u.test(name)) throw new RangeError('agent name must contain printable characters only');
  if (name.trim() !== name) throw new RangeError('agent name must not start or end with whitespace');
  return name;
}

export interface InitOptions {
  /** The agent's name, sent as the resource attribute ``redberry.agent.name``. */
  agent: string;
  /** The ingest service's base URL. Env: REDBERRY_INGEST_URL. */
  endpoint?: string;
  /** Env: REDBERRY_CLOUD. */
  cloud?: Cloud;
  /** GCP. Env: REDBERRY_GCP_PROJECT_NUMBER, REDBERRY_GCP_POOL_ID, REDBERRY_GCP_PROVIDER_ID, REDBERRY_GCP_SERVICE_ACCOUNT. */
  projectNumber?: string | number;
  poolId?: string;
  providerId?: string;
  serviceAccount?: string;
  /** AWS. Env: REDBERRY_AWS_REGION (else AWS_REGION), REDBERRY_AWS_ROLE_ARN. */
  region?: string;
  roleArn?: string;
  /** Azure. Env: REDBERRY_AZURE_TENANT_ID, REDBERRY_AZURE_CLIENT_ID, REDBERRY_AZURE_SCOPE. */
  tenantId?: string;
  clientId?: string;
  scope?: string;
  /** ``service.name``. Default: OTEL_SERVICE_NAME, else the agent name. */
  serviceName?: string;
  /** Export time bound, milliseconds (default 10000). */
  timeoutMillis?: number;
  /** The batch processor's queue bound (default 2048); spans over it are dropped. */
  maxQueueSize?: number;
  /** More span processors to run beside Redberry's. */
  spanProcessors?: SpanProcessor[];
  /** Where the REDBERRY_* variables are read (default: process.env). */
  env?: Env;
  fetch?: RedberryExporterOptions['fetch'];
  getOidcToken?: () => Promise<string>;
}

export interface RedberryTracing {
  provider: BasicTracerProvider;
  exporter: RedberryExporter;
  /** Flush and stop. */
  shutdown(): Promise<void>;
}

/** The exporter options from ``options`` and the REDBERRY_* environment variables (options win). */
export function exporterOptionsFrom(o: Omit<InitOptions, 'agent'>, env: Env = process.env): RedberryExporterOptions {
  const endpoint = o.endpoint ?? env.REDBERRY_INGEST_URL ?? '';
  if (!endpoint) throw new Error('Redberry: the ingest URL is required (endpoint or REDBERRY_INGEST_URL)');
  const cloud = o.cloud ?? (env.REDBERRY_CLOUD as Cloud | undefined);
  const base = { endpoint, timeoutMillis: o.timeoutMillis, fetch: o.fetch, getOidcToken: o.getOidcToken };
  switch (cloud) {
    case 'gcp':
      return {
        ...base,
        cloud,
        projectNumber: o.projectNumber ?? env.REDBERRY_GCP_PROJECT_NUMBER ?? '',
        poolId: o.poolId ?? env.REDBERRY_GCP_POOL_ID ?? '',
        providerId: o.providerId ?? env.REDBERRY_GCP_PROVIDER_ID ?? '',
        serviceAccount: o.serviceAccount ?? env.REDBERRY_GCP_SERVICE_ACCOUNT ?? '',
      };
    case 'aws':
      return {
        ...base,
        cloud,
        region: o.region ?? env.REDBERRY_AWS_REGION ?? env.AWS_REGION ?? '',
        roleArn: o.roleArn ?? env.REDBERRY_AWS_ROLE_ARN,
        env,
      };
    case 'azure':
      return {
        ...base,
        cloud,
        tenantId: o.tenantId ?? env.REDBERRY_AZURE_TENANT_ID ?? '',
        clientId: o.clientId ?? env.REDBERRY_AZURE_CLIENT_ID ?? '',
        scope: o.scope ?? env.REDBERRY_AZURE_SCOPE ?? '',
      };
    default:
      throw new Error(`Redberry: cloud (REDBERRY_CLOUD) must be gcp, aws or azure, not ${String(cloud)}`);
  }
}

const KEY = Symbol.for('@redberrylabs/otel.init');

/**
 * Set up tracing to the Redberry ingest service. Idempotent: later calls return the first call's result.
 * Throws on an invalid agent name or incomplete configuration; never throws once spans flow.
 */
export function init(options: InitOptions): RedberryTracing {
  const g = globalThis as { [KEY]?: RedberryTracing };
  if (g[KEY]) return g[KEY];
  const agent = validateAgentName(options?.agent);
  const env = options.env ?? process.env;
  const exporter = redberryExporter(exporterOptionsFrom(options, env));
  const manager = new AsyncLocalStorageContextManager().enable();
  if (!context.setGlobalContextManager(manager)) manager.disable(); // one is registered already: keep it
  const provider = new BasicTracerProvider({
    resource: defaultResource().merge(
      resourceFromAttributes({ 'service.name': options.serviceName || env.OTEL_SERVICE_NAME || agent, [AGENT_NAME_ATTRIBUTE]: agent }),
    ),
    spanProcessors: [new BatchSpanProcessor(exporter, { maxQueueSize: options.maxQueueSize ?? 2048 }), ...(options.spanProcessors ?? [])],
  });
  if (!trace.setGlobalTracerProvider(provider)) {
    diag.warn('@redberrylabs/otel: another tracer provider is already registered; pass redberryExporter() to it instead');
  }
  const result: RedberryTracing = { provider, exporter, shutdown: () => provider.shutdown() };
  g[KEY] = result;
  return result;
}
