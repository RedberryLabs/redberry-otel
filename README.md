# @redberrylabs/otel

Send your AI agents' OpenTelemetry traces to your Redberry installation. The agent only emits spans: `redberryExporter()` posts them as OTLP over HTTP to the Redberry ingest service that runs in your own cloud (Google Cloud Run today; AWS Lambda and Azure next), which stores, hashes and scores them there. No signing key, bucket or hashing runs inside your functions.

## Send traces to your Redberry installation

```sh
npm install @redberrylabs/otel @opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/context-async-hooks @opentelemetry/resources
```

On Vercel, `@vercel/functions` (a dependency of this package) provides the OIDC token the exporter exchanges for a short-lived credential. There is no long-lived secret in the project.

### Vercel (Next.js, `@vercel/otel`, AI SDK telemetry)

```ts
// instrumentation.ts
import { registerOTel } from '@vercel/otel';

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { redberryExporter, exporterOptionsFrom, validateAgentName } = await import('@redberrylabs/otel');
  registerOTel({
    serviceName: 'refund-agent',
    // The resource attribute the ingest service files the spans under.
    attributes: { 'redberry.agent.name': validateAgentName('refund-agent') },
    // Endpoint and credentials from the REDBERRY_* variables below.
    traceExporter: redberryExporter(exporterOptionsFrom({})),
  });
}
```

Or pass the options directly: `redberryExporter({ cloud: 'gcp', endpoint, projectNumber, poolId, providerId, serviceAccount })`. AI SDK spans need the SDK's telemetry enabled (`experimental_telemetry: { isEnabled: true }`, or `registerTelemetry` with `@ai-sdk/otel` on AI SDK 7).

### Anywhere else (AWS Lambda, Azure Functions, Node.js)

```ts
import { init } from '@redberrylabs/otel/init';

init({ agent: 'refund-agent' }); // once, at start-up; later calls return the same set-up
```

`init()` registers a tracer provider with a bounded batch span processor, an AsyncLocalStorage context manager and the resource attribute `redberry.agent.name`. The agent name must be 1 to 64 printable characters with no leading or trailing whitespace. If another tracer provider is already registered, pass `redberryExporter()` to it instead.

### AWS Lambda

On Lambda nothing needs configuring: `init({ agent })` finds the installation itself. It reads `ingest.json` from the installation's bucket `redberry-<account>-<region>` (the account from STS `GetCallerIdentity`, the read made with `x-amz-expected-bucket-owner`, so a bucket of that name owned by anyone else is refused) and signs each export with the function's own credentials. The function's role needs no policy: the installation grants it access on Redberry's resources. `REDBERRY_INGEST_URL` overrides the discovery.

### Azure Functions and Container Apps

On Azure nothing needs configuring either: `init({ agent })` takes a token for Redberry's application from the function's (or container app's) managed identity, asks Redberry for the ingest URL of the installation that registered that identity, and sends with the same token. The function needs a managed identity, chosen when Redberry is installed; the tenant's administrator consents to Redberry's application once. `REDBERRY_INGEST_URL` overrides the discovery; `REDBERRY_AZURE_APP_ID_URI` and `REDBERRY_API_URL` select another Redberry environment.

On AWS Lambda and Azure, `init()` also records where the agent runs (`faas.name`, `cloud.region`, `cloud.platform`), which Redberry's scoring uses to read the agent's code.

### Environment variables

| Variable | Option | Meaning |
|---|---|---|
| `REDBERRY_INGEST_URL` | `endpoint` | The ingest service's base URL; spans go to `<url>/v1/traces` |
| `REDBERRY_CLOUD` | `cloud` | `gcp`, `aws` or `azure` |
| `REDBERRY_GCP_PROJECT_NUMBER` | `projectNumber` | GCP: project number of the workload identity pool |
| `REDBERRY_GCP_POOL_ID` | `poolId` | GCP: workload identity pool |
| `REDBERRY_GCP_PROVIDER_ID` | `providerId` | GCP: the pool's Vercel OIDC provider |
| `REDBERRY_GCP_SERVICE_ACCOUNT` | `serviceAccount` | GCP: service account allowed to invoke the ingest service |
| `REDBERRY_AWS_REGION` | `region` | AWS: the function URL's region (default `AWS_REGION`) |
| `REDBERRY_AWS_ROLE_ARN` | `roleArn` | AWS: role assumed with the Vercel OIDC token; omit on Lambda to use the execution role |
| `REDBERRY_AZURE_TENANT_ID` | `tenantId` | Azure: Entra ID tenant |
| `REDBERRY_AZURE_CLIENT_ID` | `clientId` | Azure: app or managed identity with a federated credential for the Vercel issuer |
| `REDBERRY_AZURE_SCOPE` | `scope` | Azure: `<ingest application ID URI>/.default` |
| `REDBERRY_DISCOVERY_RETRY_S` | `discoveryRetryMs` | AWS, Azure: after the install could not be found, seconds until it is tried again (default 300) |

How each cloud authenticates:

- **GCP**: Vercel OIDC token, exchanged at Google STS (workload identity federation), then IAM Credentials `generateIdToken` for the service account with the ingest URL as audience. Sent as `Authorization: Bearer <ID token>`.
- **AWS**: credentials from `AssumeRoleWithWebIdentity` with the Vercel OIDC token, or the Lambda environment's own credentials. The POST is SigV4-signed for service `lambda` (a function URL with `AWS_IAM` auth).
- **Azure**: the Vercel OIDC token as a client assertion to Entra ID (client credentials grant). Sent as a Bearer token.

Tokens are cached until five minutes before they expire, with one refresh at a time.

### Failure behaviour

The exporter never throws into your application. An export that cannot be delivered resolves `FAILED`; 429, 5xx, 401 and 403 (IAM changes can take minutes to propagate) are retried with backoff within `timeoutMillis` (default 10 s). Each kind of failure is logged once through the OpenTelemetry `diag` logger, and `exporter.droppedSpans()` counts the spans that were not delivered.

When the install cannot be found (AWS and Azure discover it), the exporter logs an error with a code and the fix, on the console as well, so it shows in your function's logs. It keeps trying every 5 minutes and starts sending as soon as the cause is fixed, with no redeploy:

| Code | Cause | Fix |
|---|---|---|
| `RB-SDK-DISC-002` | AWS: the install's `ingest.json` could not be read | Check that the install ran in this account and region, and that this function was chosen as an agent (run the install again and select it) |
| `RB-SDK-DISC-003` | Azure: the install could not be found | Check that the app has a managed identity and was chosen as an agent (run the install again and select it) |

For an hour after recovering, new spans carry `redberry.sdk.discovery_failure` (the code and how many minutes it lasted), so the install can show the outage. `init()` sets this up; with `@vercel/otel`, add `discoveryFailureMarker(exporter)` to its span processors.

## Development

```sh
npm install
npm test          # vitest: the exporter, credentials, discovery, init and SigV4
npm run lint      # eslint + tsc --noEmit
npm run build     # tsup: ESM + CJS + .d.ts in dist/
```

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
