// Finds the customer's Redberry ingest on AWS with nothing configured: the installation writes
// ``ingest.json`` to the bucket ``redberry-<account>-<region>``. The account comes from STS
// GetCallerIdentity, which needs no permission; the object is read with ``x-amz-expected-bucket-owner``
// set to that account, so a bucket of the same name owned by anyone else is refused (bucket names are
// global). Both requests are SigV4-signed with the runtime's own credentials.
import { EMPTY_SHA256, sha256Hex, sign, type AwsCredentials } from '../sigv4';
import { describe, type Fetch } from '../http';

const STS_VERSION = '2011-06-15';

export interface AwsDiscoveryOptions {
  region: string;
  credentials: () => Promise<AwsCredentials>;
  fetch?: Fetch;
  now?: () => number;
}

export interface DiscoveredIngest {
  url: string;
  account: string;
}

/** The account id from a GetCallerIdentity reply, or undefined. */
export function accountOf(xml: string): string | undefined {
  return /<Account>\s*(\d{12})\s*<\/Account>/.exec(xml)?.[1];
}

export function discoveryBucket(account: string, region: string): string {
  return `redberry-${account}-${region}`;
}

export async function discoverAwsIngest(o: AwsDiscoveryOptions): Promise<DiscoveredIngest> {
  const f: Fetch = o.fetch ?? ((...a) => fetch(...a));
  const now = o.now ?? Date.now;
  const creds = await o.credentials();

  const stsUrl = `https://sts.${o.region}.amazonaws.com/`;
  const body = new URLSearchParams({ Action: 'GetCallerIdentity', Version: STS_VERSION }).toString();
  const stsType = 'application/x-www-form-urlencoded; charset=utf-8';
  const sts = sign({
    method: 'POST',
    url: stsUrl,
    headers: { 'content-type': stsType },
    payloadHash: sha256Hex(body),
    region: o.region,
    service: 'sts',
    credentials: creds,
    date: new Date(now()),
  });
  delete sts.headers.host;
  const r1 = await f(stsUrl, { method: 'POST', headers: { ...sts.headers, accept: 'application/xml' }, body });
  if (!r1.ok) throw new Error(`aws: GetCallerIdentity failed: ${await describe(r1)}`);
  const account = accountOf(await r1.text());
  if (!account) throw new Error('aws: GetCallerIdentity reply has no account');

  const bucket = discoveryBucket(account, o.region);
  const objUrl = `https://${bucket}.s3.${o.region}.amazonaws.com/ingest.json`;
  const s3 = sign({
    method: 'GET',
    url: objUrl,
    headers: { 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-expected-bucket-owner': account },
    payloadHash: EMPTY_SHA256,
    region: o.region,
    service: 's3',
    credentials: creds,
    date: new Date(now()),
  });
  delete s3.headers.host;
  const r2 = await f(objUrl, { method: 'GET', headers: s3.headers });
  if (!r2.ok) {
    throw new Error(
      `aws: could not read s3://${bucket}/ingest.json (${await describe(r2)}): is Redberry installed in ` +
        `account ${account}, ${o.region}, with this agent's role chosen?`,
    );
  }
  const doc = (await r2.json().catch(() => undefined)) as { url?: unknown } | undefined;
  if (!doc || typeof doc.url !== 'string' || !/^https:\/\//.test(doc.url)) {
    throw new Error(`aws: s3://${bucket}/ingest.json has no https url`);
  }
  return { url: doc.url.replace(/\/+$/, ''), account };
}
