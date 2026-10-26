// Amazon S3, in the customer's own bucket, with no long-lived AWS key in the deployment. The credentials
// come from one of two places, chosen by where the code runs:
//
//   Vercel        the function's Vercel OIDC token, exchanged at AWS STS (AssumeRoleWithWebIdentity, an
//                 unsigned call) for temporary credentials of the role REDBERRY_AWS_ROLE_ARN, cached until five
//                 minutes before they expire
//   AWS Lambda    the execution role's credentials, which Lambda puts in the environment
//   (anywhere)    (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN)
//
// Then a SigV4-signed PUT with If-None-Match: *, so S3 itself refuses an overwrite (412 PreconditionFailed, or
// 409 ConditionalRequestConflict while a concurrent write is in flight). The bucket has S3 Object Lock with a
// default retention period, so a stored run can't be changed or deleted until the retention ends.
import { DEFAULT_RETRY_DELAYS_MS, describe, withRetries, type Fetch } from '../http';
import { sha256Hex, sign, uriEncode, type AwsCredentials } from '../sigv4';
import { vercelOidcToken } from './gcs';
import { StoreConflictError, type Store } from './types';

export type S3Credential = 'vercel-oidc' | 'env';

export interface S3Options {
  /** The bucket name, or ``s3://<bucket>``. Env: REDBERRY_S3_BUCKET. */
  bucket: string;
  /** The bucket's region, e.g. ``eu-west-1``. Env: REDBERRY_S3_REGION, else AWS_REGION. */
  region: string;
  /** The IAM role to assume with the Vercel OIDC token; required on Vercel. Env: REDBERRY_AWS_ROLE_ARN. */
  roleArn?: string;
  /**
   * Where the credentials come from. Default: ``vercel-oidc`` when ``roleArn`` is given on Vercel, else
   * ``env`` when AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set (AWS Lambda and elsewhere).
   */
  credential?: S3Credential;
  /** The STS role session name (default ``redberry-otel``). */
  sessionName?: string;
  /**
   * An S3-compatible endpoint used instead of ``https://<bucket>.s3.<region>.amazonaws.com`` (a local test
   * double), addressed path-style: ``<endpoint>/<bucket>/<key>``.
   */
  endpoint?: string;
  /** An STS endpoint used instead of ``https://sts.<region>.amazonaws.com/``. */
  stsEndpoint?: string;
  fetch?: Fetch;
  /** Default: getVercelOidcToken from @vercel/functions/oidc. */
  getOidcToken?: () => Promise<string>;
  /** Where VERCEL and the AWS_* credentials are read (default: process.env). */
  env?: Record<string, string | undefined>;
  now?: () => number;
  retryDelaysMs?: readonly number[];
}

export const STS_VERSION = '2011-06-15';
/** Temporary credentials are renewed this long before they expire. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

// General purpose bucket names: 3 to 63 lowercase letters, digits, dots and hyphens, starting and ending with a
// letter or digit, no two adjacent dots, not shaped like an IP address.
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const ROLE_ARN = /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
const SESSION_NAME = /^[\w+=,.@-]{2,64}$/;

/** The bare bucket name from ``<bucket>`` or ``s3://<bucket>``; throws on an invalid name. */
export function bucketOf(raw: string): string {
  const name = raw.trim().replace(/^s3:\/\//, '').replace(/\/$/, '');
  if (!BUCKET.test(name) || name.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(name) || name.startsWith('xn--') || name.endsWith('-s3alias')) {
    throw new Error('s3(): bucket must be a valid S3 bucket name (3-63 lowercase letters, digits, dots and hyphens), or s3://<bucket>');
  }
  return name;
}

/** The region, checked (``us-east-1``, ``eu-central-2``, ``us-gov-west-1``…). */
export function regionOf(raw: string): string {
  const r = raw.trim();
  if (!REGION.test(r)) throw new Error('s3(): region must be an AWS region such as eu-west-1');
  return r;
}

/** The credential ``s3`` uses when none is given, from the environment it runs in. */
export function s3CredentialFor(env: Record<string, string | undefined>, roleArn?: string): S3Credential | undefined {
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

export function s3(options: S3Options): Store {
  if (!options.bucket) throw new Error('s3(): bucket (REDBERRY_S3_BUCKET) is required');
  if (!options.region) throw new Error('s3(): region (REDBERRY_S3_REGION) is required');
  const bucket = bucketOf(options.bucket);
  const region = regionOf(options.region);
  const env = options.env ?? process.env;
  const credential = options.credential ?? s3CredentialFor(env, options.roleArn) ?? (options.roleArn && options.getOidcToken ? 'vercel-oidc' : undefined);
  if (!credential) {
    throw new Error(
      's3(): no AWS credentials here: needs Vercel (OIDC) with roleArn (REDBERRY_AWS_ROLE_ARN), or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (AWS Lambda)',
    );
  }
  if (credential === 'vercel-oidc' && !options.roleArn) throw new Error('s3(): roleArn (REDBERRY_AWS_ROLE_ARN) is required with Vercel OIDC');
  if (options.roleArn && !ROLE_ARN.test(options.roleArn)) throw new Error('s3(): roleArn must be an IAM role ARN (arn:aws:iam::<account>:role/<name>)');
  const sessionName = options.sessionName ?? 'redberry-otel';
  if (!SESSION_NAME.test(sessionName)) throw new Error('s3(): sessionName must be 2-64 characters of [A-Za-z0-9_+=,.@-]');
  if (credential === 'env' && !(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)) {
    throw new Error('s3(): AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set');
  }

  let base: string;
  if (options.endpoint) {
    const u = new URL(options.endpoint);
    base = `${u.origin}${u.pathname.replace(/\/$/, '')}/${bucket}`;
  } else {
    // Virtual-hosted style; a dotted name would not match the *.s3 TLS certificate, so it goes path-style.
    base = bucket.includes('.') ? `https://s3.${region}.amazonaws.com/${bucket}` : `https://${bucket}.s3.${region}.amazonaws.com`;
  }
  const stsUrl = options.stsEndpoint ?? `https://sts.${region}.amazonaws.com/`;
  const f: Fetch = options.fetch ?? ((...a) => fetch(...a));
  const now = options.now ?? Date.now;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let cached: { creds: AwsCredentials; expiresAt: number } | undefined;
  let pending: Promise<AwsCredentials> | undefined;

  async function assumeRole(): Promise<AwsCredentials> {
    const token = await (options.getOidcToken ?? vercelOidcToken)();
    // Unsigned: the web identity token is the authentication. Sent in the body, not the URL.
    const form = new URLSearchParams({
      Action: 'AssumeRoleWithWebIdentity',
      Version: STS_VERSION,
      RoleArn: options.roleArn!,
      RoleSessionName: sessionName,
      WebIdentityToken: token,
    });
    const r = await withRetries(
      () => f(stsUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', accept: 'application/xml' }, body: form.toString() }),
      delays,
    );
    if (!r.response?.ok) throw new Error(`s3: STS AssumeRoleWithWebIdentity failed: ${r.response ? await describe(r.response) : String(r.error)}`);
    const reply = parseAssumeRoleReply(await r.response.text());
    if (!reply) throw new Error('s3: the AssumeRoleWithWebIdentity reply has no credentials');
    const { expiration, ...creds } = reply;
    cached = { creds, expiresAt: expiration ?? now() + 3_600_000 };
    return creds;
  }

  function credentials(): Promise<AwsCredentials> {
    if (credential === 'env') {
      return Promise.resolve({
        accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
        sessionToken: env.AWS_SESSION_TOKEN || undefined,
      });
    }
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) return Promise.resolve(cached.creds);
    return (pending ??= assumeRole().finally(() => (pending = undefined)));
  }

  return {
    kind: 's3',
    async put(path, bytes, meta) {
      const url = `${base}/${uriEncode(path, true)}`;
      const payloadHash = sha256Hex(bytes);
      // Object Lock buckets refuse a PUT without an integrity checksum (Content-MD5 or x-amz-checksum-*).
      const checksum = Buffer.from(payloadHash, 'hex').toString('base64');
      const send = (creds: AwsCredentials) =>
        withRetries(() => {
          // Signed per attempt: the signature carries the time.
          const { headers } = sign({
            method: 'PUT',
            url,
            headers: {
              'content-type': 'application/gzip',
              'if-none-match': '*',
              'x-amz-checksum-sha256': checksum,
              'x-amz-content-sha256': payloadHash,
              'x-amz-meta-sha256': meta.sha256,
            },
            payloadHash,
            region,
            service: 's3',
            credentials: creds,
            date: new Date(now()),
          });
          delete headers.host; // set by fetch
          return f(url, { method: 'PUT', headers, body: bytes.slice().buffer as ArrayBuffer });
        }, delays);
      let r = await send(await credentials());
      if (credential === 'vercel-oidc' && (r.response?.status === 401 || r.response?.status === 403)) {
        // The cached credentials were revoked or expired early: assume the role again and try once more.
        cached = undefined;
        await r.response.body?.cancel().catch(() => undefined);
        r = await send(await credentials());
        if (r.response?.status === 401 || r.response?.status === 403) cached = undefined;
      }
      if (!r.response) throw new Error(`s3: upload failed: ${String(r.error)}`);
      const { status } = r.response;
      if (status === 409 || status === 412) {
        const text = await r.response.text().catch(() => '');
        const code = tag(text, 'Code');
        throw new StoreConflictError(path, `s3 If-None-Match: *${code ? `, ${code}` : ''}`);
      }
      if (!r.response.ok) throw new Error(`s3: upload failed: ${await describe(r.response)}`);
      await r.response.body?.cancel().catch(() => undefined);
      return { url: `s3://${bucket}/${path}` };
    },
  };
}
