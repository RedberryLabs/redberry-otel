// Azure Blob Storage, in the customer's own container, with no storage key or SAS anywhere. The access
// token comes from one of two places, chosen by where the code runs:
//
//   Vercel                     the function's Vercel OIDC token, used as a client assertion for the
//                              user-assigned managed identity (federated credential), exchanged at Entra ID
//                              (client_credentials) for a token for https://storage.azure.com
//   Azure Functions / App Service  the platform's managed-identity endpoint (IDENTITY_ENDPOINT, IDENTITY_HEADER)
//
// Then Put Blob with If-None-Match: *, so Azure itself refuses an overwrite (409 BlobAlreadyExists). The
// container carries a time-based immutability policy, so a stored run can't be changed or deleted until it
// expires. The token is cached until a minute before it expires.
import { DEFAULT_RETRY_DELAYS_MS, describe, readJson, withRetries, type Fetch } from '../http';
import { vercelOidcToken } from './gcs';
import { StoreConflictError, type Store } from './types';

export type AzureCredential = 'vercel-oidc' | 'managed-identity';

export interface AzureBlobOptions {
  /** ``https://<account>.blob.core.windows.net/<container>``: no SAS, no trailing slash. Env: REDBERRY_AZURE_CONTAINER_URL. */
  containerUrl: string;
  /** The Entra ID tenant; required with Vercel OIDC. Env: REDBERRY_AZURE_TENANT_ID, else AZURE_TENANT_ID. */
  tenantId?: string;
  /**
   * The user-assigned managed identity's client id. Required with Vercel OIDC; with a managed identity,
   * omit it to use the app's system-assigned identity. Env: REDBERRY_AZURE_CLIENT_ID, else AZURE_CLIENT_ID.
   */
  clientId?: string;
  /**
   * Where the token comes from. Default: ``managed-identity`` when IDENTITY_ENDPOINT and IDENTITY_HEADER are
   * set (Azure Functions, App Service), else ``vercel-oidc`` on Vercel.
   */
  credential?: AzureCredential;
  /** A host accepted instead of ``<account>.blob.core.windows.net`` (a storage emulator or a test double). */
  allowHost?: string;
  fetch?: Fetch;
  /** Default: getVercelOidcToken from @vercel/functions/oidc. */
  getOidcToken?: () => Promise<string>;
  /** Where VERCEL, IDENTITY_ENDPOINT and IDENTITY_HEADER are read (default: process.env). */
  env?: Record<string, string | undefined>;
  now?: () => number;
  retryDelaysMs?: readonly number[];
}

export const LOGIN_URL = 'https://login.microsoftonline.com/';
export const STORAGE_SCOPE = 'https://storage.azure.com/.default';
export const STORAGE_RESOURCE = 'https://storage.azure.com/';
export const MSI_API_VERSION = '2019-08-01';
export const BLOB_API_VERSION = '2023-11-03';

const ACCOUNT_HOST = /^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/;
// Container names: 3 to 63 lowercase letters, digits and single hyphens, starting with a letter or digit.
const CONTAINER = '[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}';

/**
 * The container URL, normalised (no trailing slash). Throws on anything but
 * ``https://<account>.blob.core.windows.net/<container>``, or ``allowHost`` with ``/<container>`` or the
 * path-style ``/<account>/<container>``. The URL is never echoed back, in case it carries a SAS token.
 */
export function containerUrlOf(raw: string, allowHost?: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('azureBlob(): containerUrl is not a URL (expected https://<account>.blob.core.windows.net/<container>)');
  }
  if (u.search || u.hash || u.username || u.password) {
    throw new Error('azureBlob(): containerUrl must not carry a query, fragment or credentials (no SAS token: access is keyless)');
  }
  const path = u.pathname.replace(/\/$/, '');
  if (allowHost && u.host === allowHost) {
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('azureBlob(): containerUrl must be https');
    if (!new RegExp(`^(?:/[a-z0-9]{3,24})?/${CONTAINER}$`).test(path)) throw new Error('azureBlob(): containerUrl must end in /<container>');
    return `${u.origin}${path}`;
  }
  if (u.protocol !== 'https:') throw new Error('azureBlob(): containerUrl must be https');
  if (!ACCOUNT_HOST.test(u.hostname) || u.port) throw new Error('azureBlob(): containerUrl must be on <account>.blob.core.windows.net');
  if (!new RegExp(`^/${CONTAINER}$`).test(path)) throw new Error('azureBlob(): containerUrl must be https://<account>.blob.core.windows.net/<container>');
  return `${u.origin}${path}`;
}

/** The credential ``azureBlob`` uses when none is given, from the environment it runs in. */
export function azureCredentialFor(env: Record<string, string | undefined>): AzureCredential | undefined {
  if (env.IDENTITY_ENDPOINT && env.IDENTITY_HEADER) return 'managed-identity';
  if (env.VERCEL || env.VERCEL_ENV || env.VERCEL_OIDC_TOKEN) return 'vercel-oidc';
  return undefined;
}

interface TokenReply {
  access_token?: string;
  expires_in?: number | string;
  expires_on?: number | string;
}

/** @deprecated In-process hashing is replaced by sending spans to the Redberry ingest service in your cloud: use redberryExporter() or init(). */
export function azureBlob(options: AzureBlobOptions): Store {
  if (!options.containerUrl) throw new Error('azureBlob(): containerUrl is required');
  const container = containerUrlOf(options.containerUrl, options.allowHost);
  const env = options.env ?? process.env;
  const credential = options.credential ?? azureCredentialFor(env) ?? (options.getOidcToken ? 'vercel-oidc' : undefined);
  if (!credential) {
    throw new Error('azureBlob(): no Azure credential here: needs Vercel (OIDC) or a managed identity (IDENTITY_ENDPOINT and IDENTITY_HEADER)');
  }
  if (credential === 'vercel-oidc') {
    if (!options.tenantId) throw new Error('azureBlob(): tenantId (REDBERRY_AZURE_TENANT_ID) is required with Vercel OIDC');
    if (!options.clientId) throw new Error('azureBlob(): clientId (REDBERRY_AZURE_CLIENT_ID) is required with Vercel OIDC');
  }
  const identityEndpoint = env.IDENTITY_ENDPOINT;
  const identityHeader = env.IDENTITY_HEADER;
  if (credential === 'managed-identity' && (!identityEndpoint || !identityHeader)) {
    throw new Error('azureBlob(): a managed identity needs IDENTITY_ENDPOINT and IDENTITY_HEADER (Azure Functions, App Service)');
  }
  const f: Fetch = options.fetch ?? ((...a) => fetch(...a));
  const now = options.now ?? Date.now;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;

  async function entra(): Promise<TokenReply | undefined> {
    const assertion = await (options.getOidcToken ?? vercelOidcToken)();
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: options.clientId!,
      scope: STORAGE_SCOPE,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    });
    const r = await withRetries(
      () =>
        f(`${LOGIN_URL}${encodeURIComponent(options.tenantId!)}/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        }),
      delays,
    );
    if (!r.response?.ok) throw new Error(`azure-blob: Entra ID token request failed: ${r.response ? await describe(r.response) : String(r.error)}`);
    return (await readJson(r.response)) as TokenReply | undefined;
  }

  async function managedIdentity(): Promise<TokenReply | undefined> {
    const url = new URL(identityEndpoint!);
    url.searchParams.set('resource', STORAGE_RESOURCE);
    url.searchParams.set('api-version', MSI_API_VERSION);
    if (options.clientId) url.searchParams.set('client_id', options.clientId);
    const r = await withRetries(() => f(url.toString(), { method: 'GET', headers: { 'x-identity-header': identityHeader! } }), delays);
    if (!r.response?.ok) throw new Error(`azure-blob: managed identity token request failed: ${r.response ? await describe(r.response) : String(r.error)}`);
    return (await readJson(r.response)) as TokenReply | undefined;
  }

  async function mint(): Promise<string> {
    const reply = credential === 'vercel-oidc' ? await entra() : await managedIdentity();
    if (!reply?.access_token) throw new Error('azure-blob: the token reply has no access_token');
    // Entra ID answers expires_in (seconds from now); the managed-identity endpoint, expires_on (epoch seconds).
    const on = Number(reply.expires_on);
    const inSeconds = Number(reply.expires_in);
    const expiresAt = Number.isFinite(on) && on > 0 ? on * 1000 : Number.isFinite(inSeconds) && inSeconds > 0 ? now() + inSeconds * 1000 : now() + 3_600_000;
    cached = { token: reply.access_token, expiresAt };
    return reply.access_token;
  }

  function token(): Promise<string> {
    if (cached && cached.expiresAt - 60_000 > now()) return Promise.resolve(cached.token);
    return (pending ??= mint().finally(() => (pending = undefined)));
  }

  return {
    kind: 'azure-blob',
    async put(path, bytes, meta) {
      const url = `${container}/${path.split('/').map(encodeURIComponent).join('/')}`;
      const send = (access: string) =>
        withRetries(
          () =>
            f(url, {
              method: 'PUT',
              headers: {
                authorization: `Bearer ${access}`,
                'x-ms-version': BLOB_API_VERSION,
                'x-ms-blob-type': 'BlockBlob',
                'if-none-match': '*',
                'content-type': 'application/gzip',
                'x-ms-meta-sha256': meta.sha256,
              },
              body: bytes.slice().buffer as ArrayBuffer,
            }),
          delays,
        );
      let r = await send(await token());
      if (r.response?.status === 401) {
        // The cached token was revoked or expired early: mint a new one and try once more.
        cached = undefined;
        await r.response.body?.cancel().catch(() => undefined);
        r = await send(await token());
        if (r.response?.status === 401) cached = undefined;
      }
      if (!r.response) throw new Error(`azure-blob: upload failed: ${String(r.error)}`);
      const { status } = r.response;
      if (status === 409 || status === 412) {
        const code = r.response.headers.get('x-ms-error-code');
        await r.response.body?.cancel().catch(() => undefined);
        throw new StoreConflictError(path, `azure-blob If-None-Match: *${code ? `, ${code}` : ''}`);
      }
      if (!r.response.ok) throw new Error(`azure-blob: upload failed: ${await describe(r.response)}`);
      await r.response.body?.cancel().catch(() => undefined);
      return { url };
    },
  };
}
