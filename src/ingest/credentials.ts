// How the exporter authenticates to the ingest service in the customer's cloud. Each credential turns a
// request (URL and body) into the headers that authorise it; tokens are cached until five minutes before
// they expire, with a single refresh in flight.
//
//   gcp    Vercel OIDC -> Google STS token exchange -> IAM Credentials generateIdToken (audience = the ingest
//          URL) for a service account allowed to invoke the Cloud Run service. Bearer ID token.
//   aws    Vercel OIDC -> AWS STS AssumeRoleWithWebIdentity, or the Lambda environment's own credentials;
//          the POST is SigV4-signed for service ``lambda`` (a function URL with AWS_IAM auth).
//   azure  Vercel OIDC as a client assertion to Microsoft Entra ID (client credentials grant). Bearer token.
import type { Fetch } from '../http';
import { describe, readJson } from '../http';
import { sha256Hex, sign, type AwsCredentials } from '../sigv4';
import { LOGIN_URL } from '../stores/azure-blob';
import { googleStsExchange, IAM_URL, poolProviderAudience, vercelOidcToken } from '../stores/gcs';
import { parseAssumeRoleReply, s3CredentialFor, STS_VERSION } from '../stores/s3';

export const REFRESH_MARGIN_MS = 5 * 60_000;
const DEFAULT_LIFETIME_MS = 3_600_000;

export interface IngestCredential {
  /** Headers authorising ``POST url`` with ``body`` (``authorization`` and, for SigV4, its companions). */
  headers(url: string, body: string, contentType: string): Promise<Record<string, string>>;
  /** Forget the cached token, after the ingest service refused it (401/403). */
  invalidate(): void;
  /** AWS only: the credentials the requests are signed with (ingest discovery signs with them too). */
  awsCredentials?: () => Promise<AwsCredentials>;
}

interface Common {
  fetch?: Fetch;
  /** Default: getVercelOidcToken from @vercel/functions/oidc. */
  getOidcToken?: () => Promise<string>;
  now?: () => number;
}

export interface GcpCredentialOptions extends Common {
  /** The ingest service's base URL; the ID token's audience. */
  audience: string;
  projectNumber: string | number;
  poolId: string;
  providerId: string;
  /** Service account email with roles/run.invoker on the ingest service. */
  serviceAccount: string;
}

export interface AwsCredentialOptions extends Common {
  region: string;
  /** The IAM role to assume with the Vercel OIDC token. Without it, the environment's credentials are used. */
  roleArn?: string;
  sessionName?: string;
  /** An STS endpoint used instead of ``https://sts.<region>.amazonaws.com/``. */
  stsEndpoint?: string;
  env?: Record<string, string | undefined>;
}

export interface AzureCredentialOptions extends Common {
  tenantId: string;
  /** The app registration or user-assigned managed identity with a federated credential for the Vercel issuer. */
  clientId: string;
  /** The ingest app's scope, ``<application id URI>/.default``. */
  scope: string;
}

/** A cache of one token, refreshed ``REFRESH_MARGIN_MS`` before it expires, with one refresh in flight. */
function cachedToken<T>(now: () => number, mint: () => Promise<{ value: T; expiresAt: number }>) {
  let cached: { value: T; expiresAt: number } | undefined;
  let pending: Promise<T> | undefined;
  return {
    get(): Promise<T> {
      if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) return Promise.resolve(cached.value);
      return (pending ??= mint()
        .then((c) => {
          cached = c;
          return c.value;
        })
        .finally(() => (pending = undefined)));
    },
    clear(): void {
      cached = undefined;
    },
  };
}

/** The ``exp`` claim of a JWT, in milliseconds, if it can be read. */
export function jwtExpiry(jwt: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

const fetchOf = (o: Common): Fetch => o.fetch ?? ((...a) => fetch(...a));

export function gcpCredential(o: GcpCredentialOptions): IngestCredential {
  for (const k of ['audience', 'projectNumber', 'poolId', 'providerId', 'serviceAccount'] as const) {
    if (!o[k]) throw new Error(`redberryExporter(gcp): ${k} is required`);
  }
  const f = fetchOf(o);
  const now = o.now ?? Date.now;
  const provider = poolProviderAudience(o.projectNumber, o.poolId, o.providerId);
  const token = cachedToken(now, async () => {
    const subject = await (o.getOidcToken ?? vercelOidcToken)();
    const federated = await googleStsExchange(f, provider, subject, [], 'gcp');
    const r = await f(`${IAM_URL}${encodeURIComponent(o.serviceAccount)}:generateIdToken`, {
      method: 'POST',
      headers: { authorization: `Bearer ${federated}`, 'content-type': 'application/json' },
      body: JSON.stringify({ audience: o.audience, includeEmail: true }),
    });
    if (!r.ok) throw new Error(`gcp: generateIdToken failed: ${await describe(r)}`);
    const reply = (await readJson(r)) as { token?: string } | undefined;
    if (!reply?.token) throw new Error('gcp: generateIdToken reply has no token');
    return { value: reply.token, expiresAt: jwtExpiry(reply.token) ?? now() + DEFAULT_LIFETIME_MS };
  });
  return {
    async headers() {
      return { authorization: `Bearer ${await token.get()}` };
    },
    invalidate: token.clear,
  };
}

export function awsCredential(o: AwsCredentialOptions): IngestCredential {
  if (!o.region) throw new Error('redberryExporter(aws): region is required');
  const env = o.env ?? process.env;
  const kind = s3CredentialFor(env, o.roleArn) ?? (o.roleArn && o.getOidcToken ? 'vercel-oidc' : undefined);
  if (!kind) {
    throw new Error('redberryExporter(aws): no AWS credentials: needs Vercel (OIDC) with roleArn, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY');
  }
  const f = fetchOf(o);
  const now = o.now ?? Date.now;
  const stsUrl = o.stsEndpoint ?? `https://sts.${o.region}.amazonaws.com/`;
  const assumed = cachedToken<AwsCredentials>(now, async () => {
    const token = await (o.getOidcToken ?? vercelOidcToken)();
    const form = new URLSearchParams({
      Action: 'AssumeRoleWithWebIdentity',
      Version: STS_VERSION,
      RoleArn: o.roleArn!,
      RoleSessionName: o.sessionName ?? 'redberry-otel',
      WebIdentityToken: token,
    });
    const r = await f(stsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', accept: 'application/xml' },
      body: form.toString(),
    });
    if (!r.ok) throw new Error(`aws: STS AssumeRoleWithWebIdentity failed: ${await describe(r)}`);
    const reply = parseAssumeRoleReply(await r.text());
    if (!reply) throw new Error('aws: the AssumeRoleWithWebIdentity reply has no credentials');
    const { expiration, ...creds } = reply;
    return { value: creds, expiresAt: expiration ?? now() + DEFAULT_LIFETIME_MS };
  });
  const credentials = (): Promise<AwsCredentials> =>
    kind === 'env'
      ? Promise.resolve({
          accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
          sessionToken: env.AWS_SESSION_TOKEN || undefined,
        })
      : assumed.get();
  return {
    async headers(url, body, contentType) {
      const payloadHash = sha256Hex(body);
      const { headers } = sign({
        method: 'POST',
        url,
        headers: { 'content-type': contentType, 'x-amz-content-sha256': payloadHash },
        payloadHash,
        region: o.region,
        service: 'lambda',
        credentials: await credentials(),
        date: new Date(now()),
      });
      delete headers.host; // set by fetch
      return headers;
    },
    invalidate: assumed.clear,
    awsCredentials: credentials,
  };
}

export function azureCredential(o: AzureCredentialOptions): IngestCredential {
  for (const k of ['tenantId', 'clientId', 'scope'] as const) {
    if (!o[k]) throw new Error(`redberryExporter(azure): ${k} is required`);
  }
  const f = fetchOf(o);
  const now = o.now ?? Date.now;
  const token = cachedToken(now, async () => {
    const assertion = await (o.getOidcToken ?? vercelOidcToken)();
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: o.clientId,
      scope: o.scope,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    });
    const r = await f(`${LOGIN_URL}${encodeURIComponent(o.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!r.ok) throw new Error(`azure: token request failed: ${await describe(r)}`);
    const reply = (await readJson(r)) as { access_token?: string; expires_in?: number | string } | undefined;
    if (!reply?.access_token) throw new Error('azure: token reply has no access_token');
    const seconds = Number(reply.expires_in);
    return { value: reply.access_token, expiresAt: now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_LIFETIME_MS) };
  });
  return {
    async headers() {
      return { authorization: `Bearer ${await token.get()}` };
    },
    invalidate: token.clear,
  };
}
