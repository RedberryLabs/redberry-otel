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

How each cloud authenticates:

- **GCP**: Vercel OIDC token, exchanged at Google STS (workload identity federation), then IAM Credentials `generateIdToken` for the service account with the ingest URL as audience. Sent as `Authorization: Bearer <ID token>`.
- **AWS**: credentials from `AssumeRoleWithWebIdentity` with the Vercel OIDC token, or the Lambda environment's own credentials. The POST is SigV4-signed for service `lambda` (a function URL with `AWS_IAM` auth).
- **Azure**: the Vercel OIDC token as a client assertion to Entra ID (client credentials grant). Sent as a Bearer token.

Tokens are cached until five minutes before they expire, with one refresh at a time.

### Failure behaviour

The exporter never throws into your application. An export that cannot be delivered resolves `FAILED`; 429, 5xx, 401 and 403 (IAM changes can take minutes to propagate) are retried with backoff within `timeoutMillis` (default 10 s). Each kind of failure is logged once through the OpenTelemetry `diag` logger, and `exporter.droppedSpans()` counts the spans that were not delivered.

## Deprecated: in-process hashing

`RedberryProcessor`, `withRedberry`, `registerRedberry` and the stores (`vercelBlob`, `gcs`, `azureBlob`, `s3`, `redberry`) still work but are deprecated: they hash, store and sign each run inside your function. New installations send traces to the ingest service instead (above). The rest of this section documents the deprecated API.

An OpenTelemetry span processor for AI agents on Vercel, Azure Functions and AWS Lambda (Node.js). For each agent run (one request or invocation, one trace), it:

1. collects the spans and works out when the run has finished
2. serialises the trace canonically and gzips it deterministically
3. stores the bytes (private Vercel Blob, the customer's GCS bucket, the customer's Azure Blob Storage container, the customer's Amazon S3 bucket, or Redberry's bucket)
4. signs a hash report with the project's Ed25519 key and sends it to VALP (`POST /v1/agents/{agent_id}/hashes`)

VALP keeps each report as a create-once leaf and seals the leaves into chained five-minute windows. A stored trace can later be checked against that leaf. The bytes and the report are pinned in [SPEC.md](SPEC.md).

### Install

On Vercel:

```sh
npm install @redberrylabs/otel @vercel/otel @vercel/functions @ai-sdk/otel
```

On Azure Functions or AWS Lambda:

```sh
npm install @redberrylabs/otel @ai-sdk/otel @opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/context-async-hooks @opentelemetry/resources
```

`redberry connect --platform vercel` (or `--platform azure-functions`) adds these dependencies, writes the instrumentation and sets the environment variables for you. Releases are published from GitHub Actions with npm provenance.

### Requirements

- Node.js 22 or later. AI SDK 7 requires it, and Vercel functions run Node 24.
- The **Node.js runtime only**. On Edge, the processor turns itself off: Edge is deprecated in Next 16, and AI Gateway OIDC failed there in the spike.
- AI SDK 7 with `@ai-sdk/otel` registered. Without it there are no AI spans.
- On Vercel, `@vercel/otel` (or any OpenTelemetry SDK that accepts span processors). On Azure Functions, the programming model v4 (`@azure/functions` 4.x) and `registerRedberry()` from `@redberrylabs/otel/node`. On AWS Lambda, the Node.js 22 (or later) managed runtime, async handlers, and `registerRedberry()`.
- For the `vercel-blob` store, a **private** Vercel Blob store connected to the project, which provides `BLOB_READ_WRITE_TOKEN`.
- For the `azure-blob` store, the container and managed identity that `redberry setup-azure` creates.
- For the `s3` store, the Object Lock bucket and the IAM role or policy that `redberry setup-aws` creates.

### Set-up (Next.js, AI SDK 7)

`redberry connect --platform vercel` writes this file and sets the environment variables. The snippet below is the CLI's template (`redberry_cli/vercel.py` `INSTRUMENTATION`), so keep the two the same shape:

```ts
// instrumentation.ts
import { registerOTel } from '@vercel/otel';

export async function register() {
  // AI SDK 7 and Redberry run on the Node.js runtime only.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { registerTelemetry } = await import('ai');
  const { OpenTelemetry } = await import('@ai-sdk/otel');
  const { RedberryProcessor } = await import('@redberrylabs/otel');
  registerOTel({
    serviceName: 'refund-agent',
    // 'auto' keeps @vercel/otel's own export path beside Redberry's processor.
    spanProcessors: ['auto', new RedberryProcessor()],
  });
  // AI SDK 7 emits no spans until an integration is registered.
  registerTelemetry(new OpenTelemetry({ runtimeContext: true }));
}
```

`new RedberryProcessor()` takes no arguments: everything comes from the `REDBERRY_*` environment variables. Dependencies: `@redberrylabs/otel`, `@vercel/otel`, `@ai-sdk/otel`, `@vercel/functions`, and `@vercel/blob` if you use the Blob store.

Agent routes must run on Node (the default; do not set `runtime = 'edge'`):

```ts
// app/api/refund/route.ts
export const runtime = 'nodejs';
export const maxDuration = 300;
```

### Set-up (Azure Functions, Node.js, AI SDK 7)

Azure Functions has no `waitUntil`, so each handler is wrapped: `withRedberry` opens a root span for the invocation, runs the handler inside it, and once the handler has settled, stores and reports the run before it returns the handler's response. A slow store never holds the function past `flushTimeoutMs` (default 10 s). Register tracing once, in a module every function file imports first:

```ts
// src/redberry.ts
import { registerTelemetry } from 'ai';
import { OpenTelemetry } from '@ai-sdk/otel';
import { registerRedberry } from '@redberrylabs/otel/node';

// A tracer provider with RedberryProcessor, and the async context the AI SDK's spans need to join the
// invocation's trace. Everything comes from the REDBERRY_* app settings.
registerRedberry({ serviceName: 'refund-agent' });
// AI SDK 7 emits no spans until an integration is registered.
registerTelemetry(new OpenTelemetry({ runtimeContext: true }));
```

```ts
// src/functions/refund.ts
import '../redberry';
import { app, type HttpRequest, type InvocationContext } from '@azure/functions';
import { withRedberry } from '@redberrylabs/otel/node';
import { generateText } from 'ai';

async function refund(request: HttpRequest, context: InvocationContext) {
  const { text } = await generateText({ model: 'openai/gpt-4o-mini', prompt: await request.text() });
  return { jsonBody: { text } };
}

app.http('refund', { methods: ['POST'], handler: withRedberry(refund, { agentId: 'AGT-…' }) });
```

- `withRedberry(handler, { agentId?, name?, flushTimeoutMs? })` returns a handler with the same arguments. Its result is the handler's, unchanged, and an error the handler throws is rethrown after the flush. `agentId` wins over `REDBERRY_AGENTS` and `REDBERRY_AGENT_ID`. Without it, the route map is matched against the request's URL path (`/api/refund`), then `REDBERRY_AGENT_ID` applies.
- A streamed response is not held back: if AI spans are still open when the handler returns, the wrapper returns at once, and the run is stored and reported as soon as the stream ends.
- On Azure (`WEBSITE_SITE_NAME` set), the processor runs unless `REDBERRY_DISABLED=1`. Locally (`func start`), it stays off unless `REDBERRY_ALL_ENVS=1`, and the wrapper then simply runs the handler.
- `registerRedberry()` registers a global tracer provider. If the app already has one (the Azure Monitor OpenTelemetry distro, for example), add `new RedberryProcessor()` to that provider's span processors instead, and keep `withRedberry` on the handlers.
- `@ai-sdk/otel` is an ES module. Use an ESM function app (`"type": "module"`), or Node 22.12 or later, which can `require` it.

### Set-up (AWS Lambda, Node.js, AI SDK 7)

Lambda freezes the function as soon as the handler returns, so, as on Azure Functions, each handler is wrapped: `withRedberry` stores and reports the run before it hands back the handler's result. Only async handlers `async (event, context) => …` are supported.

```ts
// index.mjs (or handler.ts)
import { registerTelemetry, generateText } from 'ai';
import { OpenTelemetry } from '@ai-sdk/otel';
import { registerRedberry, withRedberry } from '@redberrylabs/otel/node';

// Once per execution environment, outside the handler. service.name defaults to the function name.
registerRedberry();
registerTelemetry(new OpenTelemetry({ runtimeContext: true }));

export const handler = withRedberry(
  async (event, context) => {
    const { text } = await generateText({ model: 'openai/gpt-4o-mini', prompt: event.body ?? '' });
    return { statusCode: 200, body: JSON.stringify({ text }) };
  },
  { agentId: 'AGT-…' },
);
```

Environment (Lambda function configuration): `REDBERRY_URL`, `REDBERRY_PROJECT_TOKEN`, `REDBERRY_SIGNING_KEY` (Lambda encrypts environment variables at rest with KMS), and for the customer's bucket `REDBERRY_STORE=s3`, `REDBERRY_S3_BUCKET` and `REDBERRY_S3_REGION`. The credentials are the execution role's, which Lambda provides; the role needs `s3:PutObject` on `arn:aws:s3:::<bucket>/redberry/*`, which `redberry setup-aws --function <name>` grants.

- On Lambda (`AWS_LAMBDA_FUNCTION_NAME` set), the processor runs unless `REDBERRY_DISABLED=1`. Elsewhere (a local test harness) it stays off unless `REDBERRY_ALL_ENVS=1`.
- The root span records `faas.name`, `faas.invocation_id` (`awsRequestId`), `faas.trigger` (`http` for API Gateway REST and HTTP APIs and function URLs, else `other`), `cloud.provider: aws`, `cloud.platform: aws_lambda` and `cloud.region`; for HTTP events, the method and the path without the query string.
- The store write and report count against the function's timeout: allow a few seconds for them, and set `REDBERRY_DEADLINE_MS` to the timeout (ms) so a run still going near the end is cut short and stored rather than lost.

You do not need `metadata: { agentId }` in AI SDK calls. AI SDK 7 drops `metadata`. The processor assigns each run to an agent from its own configuration (below). It records the agent in the stored trace and the report, and stamps it on every stored span as `redberry.agent_id`.

### Configuration

Every option can be set in the environment. An option passed to `new RedberryProcessor({...})` wins over the environment variable. If the configuration is incomplete, the processor logs one warning and does nothing. It never throws into your app.

| Option | Environment variable | Default | Meaning |
|---|---|---|---|
| `url` | `REDBERRY_URL` | (required) | VALP base URL |
| `token` | `REDBERRY_PROJECT_TOKEN` | (required) | Project token, 64 hex characters |
| `signingKey` | `REDBERRY_SIGNING_KEY` | (required) | Ed25519 private key as base64 PKCS8 DER (from the Redberry CLI). A PEM block or a base64 32-byte seed also works. |
| `keyId` | `REDBERRY_KEY_ID` | derived from the key | If set, it is checked against the key |
| `agentId` | `REDBERRY_AGENT_ID` | | The agent every trace belongs to, unless the route map matches |
| `agentsByRoute` | `REDBERRY_AGENTS` (JSON) | | Route path to agent id, for example `{"/api/refund":"AGT-…"}` (the CLI writes this). Matched against the root span's `http.route`, `next.route` or URL path. A key matches exactly, or as a prefix if it ends in `*`. |
| `store` | `REDBERRY_STORE` | `redberry` | `redberry`, `vercel-blob`, `gcs`, `azure-blob` or `s3` (see Stores) |
| `allEnvs` | `REDBERRY_ALL_ENVS=1` | off | Also run outside production. By default the processor runs on Vercel only when `VERCEL_ENV=production`, always on Azure App Service and Azure Functions (`WEBSITE_SITE_NAME` set) and on AWS Lambda (`AWS_LAMBDA_FUNCTION_NAME` set), and nowhere else. |
| | `REDBERRY_DISABLED=1` | off | Turn the processor off everywhere |
| `deadlineMs` | `REDBERRY_DEADLINE_MS` | unset | See Deadlines |
| `deadlineMarginMs` | `REDBERRY_DEADLINE_MARGIN_MS` | 5000 | See Deadlines |
| `graceMs` | | 2000 | Quiet time after the run before it is finalised |
| `hardStopMs` | | 60000 | Finalise as `cut_short` this long after the root ended, if spans are still open |
| `requireAiSpans` | | true | Only hash traces that contain an AI SDK span |
| `maxTraces`, `maxSpansPerTrace` | | 1000, 10000 | Memory caps. Traces or spans over a cap are dropped and counted. |
| `logger` | `REDBERRY_DEBUG=1` | `console` | `REDBERRY_DEBUG=1` adds one debug line per trace |
| `onResult` | | | Called once per finalised trace with its outcome |
| `fetch` | | global `fetch` | Used for VALP, GCS, Azure Blob Storage, S3 and STS, and the Redberry store. Not used for Vercel Blob. |

Agent ids are `AGT-` followed by a ULID. Anything else turns the processor off with a warning, because VALP would refuse it (404).

`processor.stats()` returns counters: traces seen, `complete` and `cutShort`, skipped (no AI spans or no agent), dropped, late spans, stored or failed, and `recorded`, `duplicates`, `refused` and `reportFailed`, plus samples.

### Stores

```ts
import { RedberryProcessor, vercelBlob, gcs, azureBlob, s3, redberry } from '@redberrylabs/otel';

new RedberryProcessor({ store: redberry() });     // the default: "Store logs with Redberry", VALP signs an upload URL
new RedberryProcessor({ store: vercelBlob() });   // the project's private Blob store
new RedberryProcessor({
  store: gcs({ bucket, projectNumber, poolId, providerId, serviceAccount }),  // the customer's GCS bucket
});
new RedberryProcessor({
  store: azureBlob({ containerUrl, tenantId, clientId }),  // the customer's Azure Blob Storage container
});
new RedberryProcessor({
  store: s3({ bucket, region, roleArn }),  // the customer's S3 bucket (roleArn on Vercel only)
});
```

- **`vercelBlob()`**: `put(path, bytes, { access: 'private', addRandomSuffix: false, allowOverwrite: false })`, the options the spike proved. A second write to the same path is refused. Anyone with the store's read-write token can still delete, so the tamper evidence is the signed hash VALP keeps.
- **`gcs()`**: uses the function's Vercel OIDC token, exchanges it at Google STS (workload identity pool and provider), then calls IAM Credentials `generateAccessToken` for the service account. It uploads with `ifGenerationMatch=0`, so GCS itself refuses an overwrite. Tokens are cached until a minute before they expire. Environment, as `redberry connect --store gcs` sets it from `redberry setup-gcs`: `REDBERRY_STORE=gcs` with `REDBERRY_GCS_BUCKET`, `GCP_PROJECT_NUMBER`, `GCP_WORKLOAD_POOL`, `GCP_WORKLOAD_PROVIDER` and `GCP_SERVICE_ACCOUNT`. *Unit-tested only so far.*
- **`azureBlob()`**: writes to the customer's container with Put Blob and `If-None-Match: *`, so Azure itself refuses an overwrite (409). The container's time-based immutability policy makes each stored run write-once until the retention period ends, which Vercel Blob does not offer. There is no storage key or SAS. The token is cached until a minute before it expires, and a 401 fetches a new one. The credential follows where the code runs:
  - **On Vercel**: the function's Vercel OIDC token is exchanged at Entra ID (`client_credentials` with a client assertion) for a token of the user-assigned managed identity, through the federated credential `redberry setup-azure` adds. Environment: `REDBERRY_STORE=azure-blob` with `REDBERRY_AZURE_CONTAINER_URL` (`https://<account>.blob.core.windows.net/<container>`), `REDBERRY_AZURE_TENANT_ID` and `REDBERRY_AZURE_CLIENT_ID`. The processor stays in `instrumentation.ts` as above; only the environment changes.
  - **On Azure Functions or App Service**: the platform's managed-identity endpoint (`IDENTITY_ENDPOINT`, `IDENTITY_HEADER`, set by Azure). Environment: `REDBERRY_STORE=azure-blob`, `REDBERRY_AZURE_CONTAINER_URL` and `REDBERRY_AZURE_CLIENT_ID` (the identity assigned to the app; omit it to use the app's system-assigned identity).
  - `AZURE_TENANT_ID` and `AZURE_CLIENT_ID` are read as fallbacks when the `REDBERRY_AZURE_*` names are unset. Prefer the `REDBERRY_AZURE_*` names: `AZURE_CLIENT_ID` set for the whole app also changes which identity the app's own `DefaultAzureCredential` (`@azure/identity`) uses.
  *Unit-tested only so far.*
- **`s3()`**: a SigV4-signed `PUT` with `If-None-Match: *` to the customer's bucket, so S3 itself refuses an overwrite (412, or 409 during a concurrent write). The bucket is created with S3 Object Lock and a default retention period, so each stored run is write-once until the retention ends. No AWS SDK is used, and there is no long-lived AWS key. The credentials follow where the code runs:
  - **On Vercel**: the function's Vercel OIDC token is exchanged at AWS STS (`AssumeRoleWithWebIdentity`) for temporary credentials of the role `redberry setup-aws --vercel-team … --vercel-project …` creates, which trusts Vercel's OIDC provider for that project's production environment only. The credentials are cached until five minutes before they expire, and a 401 or 403 assumes the role again. Environment: `REDBERRY_STORE=s3` with `REDBERRY_S3_BUCKET` (`<bucket>` or `s3://<bucket>`), `REDBERRY_S3_REGION` and `REDBERRY_AWS_ROLE_ARN`. The processor stays in `instrumentation.ts` as above; only the environment changes.
  - **On AWS Lambda (or anywhere with AWS credentials in the environment)**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`, which Lambda sets from the execution role. Environment: `REDBERRY_STORE=s3`, `REDBERRY_S3_BUCKET` and `REDBERRY_S3_REGION` (defaults to `AWS_REGION`).
  *Unit-tested only so far (SigV4 is checked against AWS's published examples).*
- **`redberry()`**: sends `POST {REDBERRY_URL}/v1/agents/{agent}/stored-logs/upload-url` with the project token and `{run_id, sha256, size}`, then PUTs the bytes with exactly the headers VALP returns. *Unit-tested only so far. VALP has to accept the project token on that route; see below.*

If the store fails, the hash is still reported, with `stored: false`.

### Deadlines

The `waitUntil` work counts against the function's `maxDuration`. In the spike, a run killed by the timeout lost its whole trace. When `deadlineMs` is set, a timer cuts a still-running trace short, finalises it as `finish: "cut_short", cut_reason: "deadline"`, and stores and reports it `deadlineMarginMs` before the earlier of these two times:

- the first span plus `deadlineMs`
- the invocation deadline that Vercel exposes (`getDeadline()` from `@vercel/functions`)

On Vercel, that per-invocation deadline is real. The live check confirmed it: a `maxDuration = 10` route was cut at about 7 s with a 3 s margin, then stored and reported before the kill, even though `REDBERRY_DEADLINE_MS` was 300000. So **set `REDBERRY_DEADLINE_MS` to your largest `maxDuration`** (in ms), and every route is cut at its own deadline. Keep the margin at a few seconds: store and report take about 0.5 s, but a retried report can take up to about 3 s.

On Azure Functions and AWS Lambda the package reads no per-invocation deadline, so the first span plus `deadlineMs` is the only one: set `REDBERRY_DEADLINE_MS` to the app's `functionTimeout` (`host.json`) or the Lambda function's timeout, in ms. `withRedberry` stores and reports inside the invocation, so that time also counts against the timeout.

**Limitation:** a hard kill still loses the run. That covers no deadline set, a margin too small, an out-of-memory crash, or a frozen instance. Nothing in-process survives that. Leave headroom in `maxDuration`.

### What is stored

The stored trace is a JSON document (`schema: "redberry.trace.v1"`) holding every span of the request, including the Next.js and fetch spans for timing context, with all attributes as emitted. For AI SDK 7 runs, that includes the full input messages, the system prompt, each tool call's name, arguments and result, the tool definitions, model ids, temperature and token usage. A typical run is about 5 KB gzipped. See [SPEC.md](SPEC.md) for the exact bytes.

## Development

```sh
npm install
npm test          # vitest: golden vectors, Python signature vector, finish rules, filters, stores, replies, deadline
npm run lint      # eslint + tsc --noEmit
npm run build     # tsup: ESM + CJS + .d.ts in dist/
```

- `test/vectors/v1-*.json` are the golden serialisation vectors. They are append-only. `npm run vectors -- <name>` writes only vectors that do not exist yet.
- `test/vectors/signature.json` comes from VALP's Python code: `PYTHONPATH=<VALP>/src <VALP>/.venv/bin/python scripts/python/make_signature_vector.py`.
- **Contract test against VALP's real hashes route.** `VALP_SRC=<VALP checkout with PR #53/#54> VALP_PYTHON=<venv python> npm test` runs `scripts/python/valp_local_server.py`, which starts VALP's public app in memory. The test then checks 201 with a pricing sample, 200, 409, 403 for a bad token and 403 for an unknown key, and runs a full processor pass against it.

## What VALP and the CLI need, to match

- **VALP `stored-logs/upload-url`** accepts only the agent's sink token (`X-VALP-Sink-Token`) today. The `redberry()` store sends `Authorization: Bearer <project token>`, so the route must accept a live project token for an agent in that project. VALP also names the object `….ndjson.gz`, but these bytes are one gzipped JSON document (SPEC §1), so `….json.gz` would be accurate.
- **The CLI's environment already matches** this package: `REDBERRY_PROJECT_TOKEN`, `REDBERRY_URL`, `REDBERRY_SIGNING_KEY` (base64 PKCS8 DER), `REDBERRY_KEY_ID` (checked against the key), `REDBERRY_STORE`, `REDBERRY_AGENTS`, and the GCS, Azure and S3 names above. It could also set `REDBERRY_DEADLINE_MS` to the app's largest `maxDuration` (see Deadlines).
- **The CLI's dependency `github:RedberryLabs/redberry-otel`** builds on install (the `prepare` script runs tsup). It needs the package merged to `main`, and Vercel's build must be able to read this private repository. Until the package is published, or the repository is made readable to builds, a Vercel build of a customer app cannot install it.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
