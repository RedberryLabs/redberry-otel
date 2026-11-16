// The cloud identity calls the ingest credentials make: the function's Vercel OIDC token, Google STS token
// exchange, and AWS STS's AssumeRoleWithWebIdentity reply. No cloud SDK: plain HTTP through ``Fetch``.
import type { AwsCredentials } from '../sigv4';
import { DEFAULT_RETRY_DELAYS_MS, describe, readJson, withRetries, type Fetch } from '../http';

export const STS_URL = 'https://sts.googleapis.com/v1/token';
export const IAM_URL = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/';
export const LOGIN_URL = 'https://login.microsoftonline.com/';
export const STS_VERSION = '2011-06-15';
const SCOPE_CLOUD = 'https://www.googleapis.com/auth/cloud-platform';

/** The function's Vercel OIDC token. */
export async function vercelOidcToken(): Promise<string> {
  const m = await import('@vercel/functions/oidc');
  return m.getVercelOidcToken();
}

/** The workload identity pool provider, as Google STS names it in ``audience``. */
export function poolProviderAudience(projectNumber: string | number, poolId: string, providerId: string): string {
  return `//iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;
}

/** Google STS token exchange (RFC 8693): an external OIDC token for a federated access token. */
export async function googleStsExchange(
  f: Fetch,
  audience: string,
  subjectToken: string,
  delays: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
  label = 'gcp',
): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    audience,
    scope: SCOPE_CLOUD,
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    subject_token: subjectToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
  });
  const sts = await withRetries(
    () => f(STS_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }),
    delays,
  );
  if (!sts.response?.ok) throw new Error(`${label}: STS token exchange failed: ${sts.response ? await describe(sts.response) : String(sts.error)}`);
  const federated = (await readJson(sts.response)) as { access_token?: string } | undefined;
  if (!federated?.access_token) throw new Error(`${label}: STS reply has no access_token`);
  return federated.access_token;
}

export type AwsCredentialSource = 'vercel-oidc' | 'env';

/** Where AWS credentials come from when none is given: Vercel OIDC with a role, else the environment's keys. */
export function awsCredentialSource(env: Record<string, string | undefined>, roleArn?: string): AwsCredentialSource | undefined {
  const vercel = env.VERCEL || env.VERCEL_ENV || env.VERCEL_OIDC_TOKEN;
  if (roleArn && vercel) return 'vercel-oidc';
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return 'env';
  return undefined;
}

const unxml = (s: string): string =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) =>
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'" : String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)),
  );

const tag = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return m ? unxml(m[1]!.trim()) : undefined;
};

/** The credentials in an AssumeRoleWithWebIdentity reply (XML). */
export function parseAssumeRoleReply(xml: string): (AwsCredentials & { expiration?: number }) | undefined {
  const creds = /<Credentials>([\s\S]*?)<\/Credentials>/.exec(xml)?.[1];
  if (!creds) return undefined;
  const accessKeyId = tag(creds, 'AccessKeyId');
  const secretAccessKey = tag(creds, 'SecretAccessKey');
  const sessionToken = tag(creds, 'SessionToken');
  if (!accessKeyId || !secretAccessKey || !sessionToken) return undefined;
  const exp = Date.parse(tag(creds, 'Expiration') ?? '');
  return { accessKeyId, secretAccessKey, sessionToken, expiration: Number.isFinite(exp) ? exp : undefined };
}
