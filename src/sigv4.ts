// AWS Signature Version 4 (header-based), the part of it the s3 store needs: a canonical request, the string
// to sign, the derived signing key and the Authorization header. Checked against AWS's published examples
// (test/sigv4.test.ts). Reference: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials only (STS, a Lambda execution role). Sent as x-amz-security-token. */
  sessionToken?: string;
}

export interface SignInput {
  method: string;
  /** The full request URL; its host and query string are signed. */
  url: string;
  /** Headers to sign besides host, x-amz-date and x-amz-security-token (which are added). */
  headers?: Record<string, string>;
  /** Lowercase hex SHA-256 of the body, or ``UNSIGNED-PAYLOAD``. */
  payloadHash: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  date: Date;
}

export interface Signed {
  /** Every header to send, the signed ones and ``authorization``, with lowercase names. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

const hmac = (key: string | Uint8Array, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 percent-encoding: everything but A-Z a-z 0-9 - . _ ~ (``/`` too, unless ``keepSlash``). */
export function uriEncode(s: string, keepSlash = false): string {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? e.replace(/%2F/g, '/') : e;
}

/** ``YYYYMMDDTHHMMSSZ`` */
export const amzDate = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * The canonical URI. S3 signs the path as sent (each segment encoded once); every other service encodes the
 * already-encoded path a second time.
 */
function canonicalUri(pathname: string, service: string): string {
  if (!pathname) return '/';
  const segments = pathname.split('/').map((p) => uriEncode(decodeURIComponent(p)));
  const once = segments.join('/');
  return service === 's3' ? once : segments.map((p) => uriEncode(p)).join('/');
}

function canonicalQuery(search: string): string {
  if (!search || search === '?') return '';
  const pairs = search
    .slice(1)
    .split('&')
    .filter(Boolean)
    .map((kv) => {
      const i = kv.indexOf('=');
      const k = i < 0 ? kv : kv.slice(0, i);
      const v = i < 0 ? '' : kv.slice(i + 1);
      const dec = (x: string) => decodeURIComponent(x.replace(/\+/g, '%20'));
      return [uriEncode(dec(k)), uriEncode(dec(v))] as const;
    });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/** The derived key: HMAC chain over the date, region, service and ``aws4_request``. */
export function signingKey(secretAccessKey: string, day: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
}

/** Sign a request: returns the headers to send (with ``authorization``) and the intermediate strings. */
export function sign(input: SignInput): Signed {
  const u = new URL(input.url);
  const when = amzDate(input.date);
  const day = when.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v;
  headers.host ??= u.host;
  headers['x-amz-date'] = when;
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(u.pathname, input.service),
    canonicalQuery(u.search),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', when, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(input.credentials.secretAccessKey, day, input.region, input.service))
    .update(stringToSign, 'utf8')
    .digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign, signature };
}
