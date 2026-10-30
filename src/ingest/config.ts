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

/** Redberry's ingest application (dev): the audience of the Entra tokens agents send with on Azure. */
export const DEFAULT_AZURE_APP_ID_URI = 'api://c1b7f6d8-a898-4679-8343-9223a5f832d7';

/** The exporter options from ``options`` and the REDBERRY_* environment variables (options win). */
export function exporterOptionsFrom(o: IngestConfig, env: Env = process.env): RedberryExporterOptions {
  const endpoint = o.endpoint ?? env.REDBERRY_INGEST_URL ?? '';
  const onLambda = !!(env.AWS_LAMBDA_FUNCTION_NAME || env.ECS_CONTAINER_METADATA_URI_V4);
  const onAzure = !!(env.IDENTITY_ENDPOINT && env.IDENTITY_HEADER);
  const cloud =
    o.cloud ?? (env.REDBERRY_CLOUD as Cloud | undefined) ?? (onLambda ? 'aws' : onAzure ? 'azure' : undefined);
  // On AWS and Azure the ingest URL can be discovered (discover-aws.ts, discover-azure.ts); elsewhere it is required.
  if (!endpoint && cloud !== 'aws' && cloud !== 'azure') {
    throw new Error('Redberry: the ingest URL is required (endpoint or REDBERRY_INGEST_URL)');
  }
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
        tenantId: o.tenantId ?? env.REDBERRY_AZURE_TENANT_ID,
        clientId: o.clientId ?? env.REDBERRY_AZURE_CLIENT_ID ?? env.AZURE_CLIENT_ID,
        scope: o.scope ?? env.REDBERRY_AZURE_SCOPE ?? `${env.REDBERRY_AZURE_APP_ID_URI ?? DEFAULT_AZURE_APP_ID_URI}/.default`,
        apiUrl: env.REDBERRY_API_URL,
        env,
      };
    default:
      throw new Error(`Redberry: cloud (REDBERRY_CLOUD) must be gcp, aws or azure, not ${String(cloud)}`);
  }
}


/**
 * Where the agent runs, as OpenTelemetry resource attributes: the scoring job reads the agent's code from
 * these (a Lambda function by name and region; an Azure Function or Container App by name). Empty elsewhere.
 */
export function platformResourceAttributes(env: Env = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (k: string, v: string | undefined) => {
    if (v && v.trim()) out[k] = v.trim();
  };
  if (env.AWS_LAMBDA_FUNCTION_NAME) {
    set('cloud.provider', 'aws');
    set('cloud.platform', 'aws_lambda');
    set('faas.name', env.AWS_LAMBDA_FUNCTION_NAME);
    set('faas.version', env.AWS_LAMBDA_FUNCTION_VERSION);
    set('cloud.region', env.AWS_REGION);
  } else if (env.CONTAINER_APP_NAME || env.WEBSITE_SITE_NAME) {
    set('cloud.provider', 'azure');
    set('cloud.platform', env.CONTAINER_APP_NAME ? 'azure_container_apps' : env.FUNCTIONS_WORKER_RUNTIME ? 'azure_functions' : 'azure_app_service');
    set('faas.name', env.CONTAINER_APP_NAME || env.WEBSITE_SITE_NAME);
    set('cloud.region', env.REGION_NAME);
  }
  return out;
}
