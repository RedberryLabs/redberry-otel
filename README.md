# @redberry/otel

An OpenTelemetry span processor for AI agents on Vercel. For each agent run (one request, one trace), it:

1. collects the spans and works out when the run has finished
2. serialises the trace canonically and gzips it deterministically
3. stores the bytes (private Vercel Blob, the customer's GCS bucket, or Redberry's bucket)
4. signs a hash report with the project's Ed25519 key and sends it to VALP (`POST /v1/agents/{agent_id}/hashes`)

VALP keeps each report as a create-once leaf and seals the leaves into chained five-minute windows. A stored trace can later be checked against that leaf. The bytes and the report are pinned in [SPEC.md](SPEC.md).

Private package. It is not published to npm. Install it from this repository or from a packed tarball (`npm pack`).

## Requirements

- Node.js 22 or later. AI SDK 7 requires it, and Vercel functions run Node 24.
- The **Node.js runtime only**. On Edge, the processor turns itself off: Edge is deprecated in Next 16, and AI Gateway OIDC failed there in the spike.
- AI SDK 7 with `@ai-sdk/otel` registered. Without it there are no AI spans.
- `@vercel/otel` (or any OpenTelemetry SDK that accepts span processors).
- For the `vercel-blob` store, a **private** Vercel Blob store connected to the project, which provides `BLOB_READ_WRITE_TOKEN`.

## Set-up (Next.js, AI SDK 7)

`redberry connect --platform vercel` writes this file and sets the environment variables. The snippet below is the CLI's template (`redberry_cli/vercel.py` `INSTRUMENTATION`), so keep the two the same shape:

```ts
// instrumentation.ts
import { registerOTel } from '@vercel/otel';

export async function register() {
  // AI SDK 7 and Redberry run on the Node.js runtime only.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { registerTelemetry } = await import('ai');
  const { OpenTelemetry } = await import('@ai-sdk/otel');
  const { RedberryProcessor } = await import('@redberry/otel');
  registerOTel({
    serviceName: 'refund-agent',
    // 'auto' keeps @vercel/otel's own export path beside Redberry's processor.
    spanProcessors: ['auto', new RedberryProcessor()],
  });
  // AI SDK 7 emits no spans until an integration is registered.
  registerTelemetry(new OpenTelemetry({ runtimeContext: true }));
}
```

`new RedberryProcessor()` takes no arguments: everything comes from the `REDBERRY_*` environment variables. Dependencies: `@redberry/otel`, `@vercel/otel`, `@ai-sdk/otel`, `@vercel/functions`, and `@vercel/blob` if you use the Blob store.

Agent routes must run on Node (the default; do not set `runtime = 'edge'`):

```ts
// app/api/refund/route.ts
export const runtime = 'nodejs';
export const maxDuration = 300;
```

You do not need `metadata: { agentId }` in AI SDK calls. AI SDK 7 drops `metadata`. The processor assigns each run to an agent from its own configuration (below). It records the agent in the stored trace and the report, and stamps it on every stored span as `redberry.agent_id`.

## Configuration

Every option can be set in the environment. An option passed to `new RedberryProcessor({...})` wins over the environment variable. If the configuration is incomplete, the processor logs one warning and does nothing. It never throws into your app.

| Option | Environment variable | Default | Meaning |
|---|---|---|---|
| `url` | `REDBERRY_URL` | (required) | VALP base URL |
| `token` | `REDBERRY_PROJECT_TOKEN` | (required) | Project token, 64 hex characters |
| `signingKey` | `REDBERRY_SIGNING_KEY` | (required) | Ed25519 private key as base64 PKCS8 DER (from the Redberry CLI). A PEM block or a base64 32-byte seed also works. |
| `keyId` | `REDBERRY_KEY_ID` | derived from the key | If set, it is checked against the key |
| `agentId` | `REDBERRY_AGENT_ID` | | The agent every trace belongs to, unless the route map matches |
| `agentsByRoute` | `REDBERRY_AGENTS` (JSON) | | Route path to agent id, for example `{"/api/refund":"AGT-…"}` (the CLI writes this). Matched against the root span's `http.route`, `next.route` or URL path. A key matches exactly, or as a prefix if it ends in `*`. |
| `store` | `REDBERRY_STORE` | `redberry` | `redberry`, `vercel-blob` or `gcs` (see Stores) |
| `allEnvs` | `REDBERRY_ALL_ENVS=1` | off | Also run outside production. By default the processor runs only when `VERCEL_ENV=production`. |
| `deadlineMs` | `REDBERRY_DEADLINE_MS` | unset | See Deadlines |
| `deadlineMarginMs` | `REDBERRY_DEADLINE_MARGIN_MS` | 5000 | See Deadlines |
| `graceMs` | | 2000 | Quiet time after the run before it is finalised |
| `hardStopMs` | | 60000 | Finalise as `cut_short` this long after the root ended, if spans are still open |
| `requireAiSpans` | | true | Only hash traces that contain an AI SDK span |
| `maxTraces`, `maxSpansPerTrace` | | 1000, 10000 | Memory caps. Traces or spans over a cap are dropped and counted. |
| `logger` | `REDBERRY_DEBUG=1` | `console` | `REDBERRY_DEBUG=1` adds one debug line per trace |
| `onResult` | | | Called once per finalised trace with its outcome |
| `fetch` | | global `fetch` | Used for VALP, GCS and the Redberry store. Not used for Blob. |

Agent ids are `AGT-` followed by a ULID. Anything else turns the processor off with a warning, because VALP would refuse it (404).

`processor.stats()` returns counters: traces seen, `complete` and `cutShort`, skipped (no AI spans or no agent), dropped, late spans, stored or failed, and `recorded`, `duplicates`, `refused` and `reportFailed`, plus samples.

## Stores

```ts
import { RedberryProcessor, vercelBlob, gcs, redberry } from '@redberry/otel';

new RedberryProcessor({ store: redberry() });     // the default: "Store logs with Redberry", VALP signs an upload URL
new RedberryProcessor({ store: vercelBlob() });   // the project's private Blob store
new RedberryProcessor({
  store: gcs({ bucket, projectNumber, poolId, providerId, serviceAccount }),  // the customer's GCS bucket
});
```

- **`vercelBlob()`**: `put(path, bytes, { access: 'private', addRandomSuffix: false, allowOverwrite: false })`, the options the spike proved. A second write to the same path is refused. Anyone with the store's read-write token can still delete, so the tamper evidence is the signed hash VALP keeps.
- **`gcs()`**: uses the function's Vercel OIDC token, exchanges it at Google STS (workload identity pool and provider), then calls IAM Credentials `generateAccessToken` for the service account. It uploads with `ifGenerationMatch=0`, so GCS itself refuses an overwrite. Tokens are cached until a minute before they expire. Environment, as `redberry connect --store gcs` sets it from `redberry setup-gcs`: `REDBERRY_STORE=gcs` with `REDBERRY_GCS_BUCKET`, `GCP_PROJECT_NUMBER`, `GCP_WORKLOAD_POOL`, `GCP_WORKLOAD_PROVIDER` and `GCP_SERVICE_ACCOUNT`. *Unit-tested only so far.*
- **`redberry()`**: sends `POST {REDBERRY_URL}/v1/agents/{agent}/stored-logs/upload-url` with the project token and `{run_id, sha256, size}`, then PUTs the bytes with exactly the headers VALP returns. *Unit-tested only so far. VALP has to accept the project token on that route; see below.*

If the store fails, the hash is still reported, with `stored: false`.

## Deadlines

The `waitUntil` work counts against the function's `maxDuration`. In the spike, a run killed by the timeout lost its whole trace. When `deadlineMs` is set, a timer cuts a still-running trace short, finalises it as `finish: "cut_short", cut_reason: "deadline"`, and stores and reports it `deadlineMarginMs` before the earlier of these two times:

- the first span plus `deadlineMs`
- the invocation deadline that Vercel exposes (`getDeadline()` from `@vercel/functions`)

On Vercel, that per-invocation deadline is real. The live check confirmed it: a `maxDuration = 10` route was cut at about 7 s with a 3 s margin, then stored and reported before the kill, even though `REDBERRY_DEADLINE_MS` was 300000. So **set `REDBERRY_DEADLINE_MS` to your largest `maxDuration`** (in ms), and every route is cut at its own deadline. Keep the margin at a few seconds: store and report take about 0.5 s, but a retried report can take up to about 3 s.

**Limitation:** a hard kill still loses the run. That covers no deadline set, a margin too small, an out-of-memory crash, or a frozen instance. Nothing in-process survives that. Leave headroom in `maxDuration`.

## What is stored

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
- **The CLI's environment already matches** this package: `REDBERRY_PROJECT_TOKEN`, `REDBERRY_URL`, `REDBERRY_SIGNING_KEY` (base64 PKCS8 DER), `REDBERRY_KEY_ID` (checked against the key), `REDBERRY_STORE`, `REDBERRY_AGENTS`, and the GCS names above. It could also set `REDBERRY_DEADLINE_MS` to the app's largest `maxDuration` (see Deadlines).
- **The CLI's dependency `github:RedberryLabs/redberry-otel`** builds on install (the `prepare` script runs tsup). It needs the package merged to `main`, and Vercel's build must be able to read this private repository. Until the package is published, or the repository is made readable to builds, a Vercel build of a customer app cannot install it.
