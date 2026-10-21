// Google Cloud Storage via Workload Identity Federation, with no Google key in the Vercel project:
//
//   1. the function's Vercel OIDC token (@vercel/functions/oidc getVercelOidcToken)
//   2. Google STS token exchange (RFC 8693) for a federated access token, audience = the pool provider
//   3. IAM Credentials generateAccessToken: a short-lived token for the service account
//   4. JSON API multipart upload with ifGenerationMatch=0: GCS itself refuses an overwrite (412)
//
// The service-account token is cached until a minute before it expires. Not live-tested yet (needs the
// pool, provider and bucket of GCP-BOOTSTRAP); covered by unit tests with a mocked fetch.
import { DEFAULT_RETRY_DELAYS_MS, describe, readJson, withRetries, type Fetch } from '../http';
import { concat, utf8 } from '../encoding';
import { StoreConflictError, type Store } from './types';

export interface GcsOptions {
  bucket: string;
  /** The Google Cloud project *number* that holds the workload identity pool. */
  projectNumber: string | number;
  poolId: string;
  providerId: string;
  /** Service account email with roles/storage.objectCreator on the bucket. */
  serviceAccount: string;
  /** Token lifetime asked of IAM Credentials, seconds (default 3600). */
  lifetimeSeconds?: number;
  fetch?: Fetch;
  /** Default: getVercelOidcToken from @vercel/functions/oidc. */
  getOidcToken?: () => Promise<string>;
  now?: () => number;
  retryDelaysMs?: readonly number[];
}

export const STS_URL = 'https://sts.googleapis.com/v1/token';
export const IAM_URL = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/';
export const UPLOAD_URL = 'https://storage.googleapis.com/upload/storage/v1/b/';
const SCOPE_CLOUD = 'https://www.googleapis.com/auth/cloud-platform';
const SCOPE_STORAGE = 'https://www.googleapis.com/auth/devstorage.read_write';

async function vercelOidcToken(): Promise<string> {
  const m = await import('@vercel/functions/oidc');
  return m.getVercelOidcToken();
}

export function gcs(options: GcsOptions): Store {
  for (const k of ['bucket', 'projectNumber', 'poolId', 'providerId', 'serviceAccount'] as const) {
    if (!options[k]) throw new Error(`gcs(): ${k} is required`);
  }
  const f: Fetch = options.fetch ?? ((...a) => fetch(...a));
  const now = options.now ?? Date.now;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const audience =
    `//iam.googleapis.com/projects/${options.projectNumber}/locations/global/` +
    `workloadIdentityPools/${options.poolId}/providers/${options.providerId}`;
  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;

  async function mint(): Promise<string> {
    const subject = await (options.getOidcToken ?? vercelOidcToken)();
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience,
      scope: SCOPE_CLOUD,
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: subject,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    });
    const sts = await withRetries(
      () => f(STS_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }),
      delays,
    );
    if (!sts.response?.ok) throw new Error(`gcs: STS token exchange failed: ${sts.response ? await describe(sts.response) : String(sts.error)}`);
    const federated = (await readJson(sts.response)) as { access_token?: string } | undefined;
    if (!federated?.access_token) throw new Error('gcs: STS reply has no access_token');

    const iam = await withRetries(
      () =>
        f(`${IAM_URL}${encodeURIComponent(options.serviceAccount)}:generateAccessToken`, {
          method: 'POST',
          headers: { authorization: `Bearer ${federated.access_token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ scope: [SCOPE_STORAGE], lifetime: `${options.lifetimeSeconds ?? 3600}s` }),
        }),
      delays,
    );
    if (!iam.response?.ok) throw new Error(`gcs: generateAccessToken failed: ${iam.response ? await describe(iam.response) : String(iam.error)}`);
    const sa = (await readJson(iam.response)) as { accessToken?: string; expireTime?: string } | undefined;
    if (!sa?.accessToken) throw new Error('gcs: generateAccessToken reply has no accessToken');
    const expires = sa.expireTime ? Date.parse(sa.expireTime) : now() + 3_600_000;
    cached = { token: sa.accessToken, expiresAt: Number.isFinite(expires) ? expires : now() + 3_600_000 };
    return sa.accessToken;
  }

  function token(): Promise<string> {
    if (cached && cached.expiresAt - 60_000 > now()) return Promise.resolve(cached.token);
    return (pending ??= mint().finally(() => (pending = undefined)));
  }

  return {
    kind: 'gcs',
    async put(path, bytes, meta) {
      const access = await token();
      const boundary = `redberry-${meta.sha256.slice(0, 16)}`;
      const metadata = { name: path, contentType: 'application/gzip', metadata: { sha256: meta.sha256 } };
      const body = concat(
        utf8(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
        utf8(`--${boundary}\r\ncontent-type: application/gzip\r\n\r\n`),
        bytes,
        utf8(`\r\n--${boundary}--\r\n`),
      );
      const url = `${UPLOAD_URL}${encodeURIComponent(options.bucket)}/o?uploadType=multipart&ifGenerationMatch=0`;
      const r = await withRetries(
        () =>
          f(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${access}`, 'content-type': `multipart/related; boundary=${boundary}` },
            body: body.slice().buffer as ArrayBuffer,
          }),
        delays,
      );
      if (!r.response) throw new Error(`gcs: upload failed: ${String(r.error)}`);
      if (r.response.status === 412) throw new StoreConflictError(path, 'gcs ifGenerationMatch=0');
      if (r.response.status === 401) cached = undefined;
      if (!r.response.ok) throw new Error(`gcs: upload failed: ${await describe(r.response)}`);
      return { url: `gs://${options.bucket}/${path}` };
    },
  };
}
