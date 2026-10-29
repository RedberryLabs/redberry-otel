// Finds the customer's Redberry ingest on Azure with nothing configured. Container Apps hostnames are random,
// so the installation registers its ingest URL and each agent identity with Redberry; the agent asks
// Redberry, authenticated with the same Entra token it then sends spans with. Redberry checks the token
// (signature, audience, tenant) and answers with the ingest of the installation that registered the
// identity's object id.
import { describe, readJson, type Fetch } from '../http';

export const DEFAULT_REDBERRY_API_URL = 'https://api-dev.redberry.sbs';

export interface AzureDiscoveryOptions {
  token: () => Promise<string>;
  apiUrl?: string;
  fetch?: Fetch;
}

export async function discoverAzureIngest(o: AzureDiscoveryOptions): Promise<string> {
  const f: Fetch = o.fetch ?? ((...a) => fetch(...a));
  const base = (o.apiUrl || DEFAULT_REDBERRY_API_URL).replace(/\/+$/, '');
  const r = await f(`${base}/api/discover/azure`, { headers: { authorization: `Bearer ${await o.token()}` } });
  if (!r.ok) {
    throw new Error(
      `azure: Redberry could not find this agent's installation (${await describe(r)}): was its managed identity ` +
        'chosen when Redberry was installed?',
    );
  }
  const doc = (await readJson(r)) as { ingest_url?: unknown } | undefined;
  if (!doc || typeof doc.ingest_url !== 'string' || !/^https:\/\//.test(doc.ingest_url)) {
    throw new Error('azure: the discovery reply has no https ingest_url');
  }
  return doc.ingest_url.replace(/\/+$/, '');
}
