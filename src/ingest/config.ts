// Ingest configuration from options and REDBERRY_* environment variables, and the agent name check.
// Root-safe: imports no optional OpenTelemetry peers.
import type { Cloud, RedberryExporterOptions } from './exporter';

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

export interface IngestConfig {
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
  timeoutMillis?: number;
  fetch?: RedberryExporterOptions['fetch'];
  getOidcToken?: () => Promise<string>;
}

/** The exporter options from ``options`` and the REDBERRY_* environment variables (options win). */
export function exporterOptionsFrom(o: IngestConfig, env: Env = process.env): RedberryExporterOptions {
  const endpoint = o.endpoint ?? env.REDBERRY_INGEST_URL ?? '';
  const onLambda = !!(env.AWS_LAMBDA_FUNCTION_NAME || env.ECS_CONTAINER_METADATA_URI_V4);
  const cloud = o.cloud ?? (env.REDBERRY_CLOUD as Cloud | undefined) ?? (onLambda ? 'aws' : undefined);
  // On AWS the ingest URL can be discovered (discover-aws.ts); elsewhere it is required.
  if (!endpoint && cloud !== 'aws') throw new Error('Redberry: the ingest URL is required (endpoint or REDBERRY_INGEST_URL)');
  const base = { endpoint: endpoint || undefined, timeoutMillis: o.timeoutMillis, fetch: o.fetch, getOidcToken: o.getOidcToken };
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

