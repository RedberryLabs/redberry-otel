# @redberrylabs/otel: stored trace and hash report, v1

This document pins the bytes that `@redberrylabs/otel` stores for each AI agent run and the report it signs and sends to VALP. Anyone holding a stored trace and its VALP leaf must be able to check one against the other years from now, without this package. Where this document and the code disagree, the golden vectors in `test/vectors/` decide, and the disagreement is a bug.

**Versioning.** The stored document carries `schema: "redberry.trace.v1"`. Any change to the bytes described here needs a new schema value and new golden vectors. That includes field names, ordering, number or string encoding and the compression settings. Vectors already committed are never edited.

## 1. The stored document

One JSON object per trace (one request, one agent run):

| Field | Type | Meaning |
|---|---|---|
| `schema` | string | `"redberry.trace.v1"` |
| `agent_id` | string | The Redberry agent, `AGT-` + a 26-character Crockford ULID. The package sets it from its own configuration (§8), not from span attributes. The same id is also stamped on every span as `redberry.agent_id` (§2.1). |
| `trace_id` | string | The OpenTelemetry trace id: 32 lowercase hex characters. |
| `finish` | string | `"complete"`: the finish rule held (§8). `"cut_short"`: the trace was finalised while at least one span was still open, or before its root ended. |
| `cut_reason` | string or null | `null` when `finish` is `"complete"`. Otherwise one of `"deadline"`, `"hard_stop"` or `"shutdown"`. |
| `started_at` | string | The earliest span start, as ISO-8601 UTC with milliseconds, truncated (`YYYY-MM-DDTHH:MM:SS.mmmZ`). |
| `ended_at` | string | The latest of: every ended span's end, every open span's start and, for `cut_short`, the moment of the cut. Same format. |
| `resource` | object | The OpenTelemetry resource attributes of the root span, as emitted (`service.name`, `vercel.*` on Vercel, `cloud.*` on Azure and AWS Lambda, …). |
| `spans` | array | Every span of the trace that the processor saw, in the order of §2.2. |
| `dropped_spans` | integer | Spans not kept because the per-trace cap was reached (default cap 10,000). |
| `producer` | object | `{ "name": "@redberrylabs/otel", "version": "<semver>" }`. `name` identifies the writer: another conforming writer, such as the Python hasher in `redberry-agent-sdk`, sets its own name and version. |

## 2. Spans

### 2.1 Fields

Field names follow OTLP/JSON. Every field is always present.

| Field | Type | Notes |
|---|---|---|
| `traceId` | string | 32 lowercase hex characters |
| `spanId` | string | 16 lowercase hex characters |
| `parentSpanId` | string or null | `null` for a span with no parent |
| `name` | string | |
| `kind` | integer | OpenTelemetry `SpanKind`: 0 internal, 1 server, 2 client, 3 producer, 4 consumer |
| `startTimeUnixNano` | string | Nanoseconds since the Unix epoch, as a decimal string (no float rounding) |
| `endTimeUnixNano` | string or null | Same format. `null` when the span was still open when the trace was cut short. |
| `attributes` | object | The span's attributes **exactly as emitted**, plus one: `redberry.agent_id`, the document's `agent_id`. It is set on every span and replaces any value the span emitted under that name, and the OTELLINE normaliser reads it first. Values are strings, booleans, numbers or arrays of these. A value that is itself JSON text (most `gen_ai.*` messages, tool arguments and results) stays a string. It is never parsed or re-encoded. |
| `status` | object | `{ "code": 0 \| 1 \| 2, "message": string \| null }`. An empty message is `null`. |
| `events` | array | `{ name, timeUnixNano, attributes, droppedAttributesCount }`, in the order emitted |
| `links` | array | `{ traceId, spanId, attributes, droppedAttributesCount }`, in the order emitted |
| `scope` | object | Instrumentation scope: `{ name, version: string \| null, schemaUrl: string \| null }` |
| `dropped` | object | `{ attributes, events, links }`: the counts the SDK dropped |

### 2.2 Order

Spans are sorted by `startTimeUnixNano` compared as integers, then by `spanId` in ordinal (byte) order.

## 3. Canonical JSON

The document is serialised as RFC 8785 (JSON Canonicalization Scheme) and encoded as UTF-8:

- Object keys are sorted by UTF-16 code units, recursively at every level. No whitespace is added.
- Numbers use the ECMAScript shortest round-trip form (`Number.prototype.toString`). For example: `1`, `0.1`, `1e+21`, `1e-7`. `-0` is written as `0`.
- Strings are escaped as ECMAScript `JSON.stringify` escapes them: `\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t` and `\u00XX` for other C0 controls. All other characters are written literally, including U+007F, U+2028 and U+2029. A lone surrogate becomes a `\udXXX` escape.

OpenTelemetry can hold values that JSON cannot. These are pinned as follows:

| Value | Written as |
|---|---|
| an object member whose value is `undefined` | the member is omitted |
| an array element that is `undefined` or `null` | `null` |
| `NaN`, `Infinity`, `-Infinity` | the strings `"NaN"`, `"Infinity"`, `"-Infinity"` |
| a bigint | its decimal string |

The test suite checks every golden vector against an independent RFC 8785 implementation (the `canonicalize` package).

## 4. Compression: the stored bytes

The stored bytes are the canonical JSON compressed with gzip (RFC 1952) by **fflate 0.8.3** `gzipSync(data, { level: 6, mtime: 0 })`:

- The header is exactly `1f 8b 08 00 00 00 00 00 00 03`: deflate, no flags, no file name, mtime 0, XFL 0, OS 3 (Unix).
- The DEFLATE stream is fflate's output at level 6. Other implementations, including Node's `zlib`, produce different (still valid) compressed bytes, which is why the implementation and its version are pinned. `fflate` is an exact dependency (`0.8.3`, not a range).

Anyone can decompress the bytes with any gunzip. Re-compressing to the same bytes needs fflate 0.8.3. The commitment is always to the stored bytes as they are (§5), so a verifier hashes what is stored and never re-compresses.

**Other writers.** The fflate 0.8.3 bytes above are what this package writes. Another conforming writer, identified by `producer.name` (§1), such as the Python hasher in `redberry-agent-sdk`, writes the same 10-byte header but may produce a different DEFLATE stream from the same canonical JSON. Such documents verify in exactly the same way, because verification (§9) hashes the stored bytes and decompresses them, and never re-compresses. What every writer must match byte for byte is the canonical JSON (§3).

## 5. Hash, size and storage

- `sha256` is the lowercase hex SHA-256 of the stored (gzip) bytes.
- `size` is their length in bytes.
- The storage path is `redberry/<agent_id>/<YYYY-MM-DD of started_at>/<trace_id>.json.gz`.

| Store (`store`) | Where the bytes go | No-overwrite guarantee |
|---|---|---|
| `vercel-blob` | The customer's Vercel Blob store at the path above, with `access: "private"`, `addRandomSuffix: false`, `allowOverwrite: false`, `contentType: "application/gzip"` | Blob refuses a second `put` to the same path. This is no-overwrite, not immutability: the store's read-write token can delete. |
| `gcs` | The customer's bucket at the path above. The JSON API multipart upload uses `ifGenerationMatch=0` and object metadata `sha256`. Credentials come from Vercel OIDC, then Google STS (pool `GCP_WORKLOAD_POOL`, provider `GCP_WORKLOAD_PROVIDER`, project `GCP_PROJECT_NUMBER`), then IAM Credentials `generateAccessToken` for `GCP_SERVICE_ACCOUNT`. | GCS refuses (412). Bucket retention gives immutability. |
| `azure-blob` | The customer's Azure Blob Storage container (`REDBERRY_AZURE_CONTAINER_URL`, `https://<account>.blob.core.windows.net/<container>`) at the path above. Put Blob (`x-ms-version: 2023-11-03`, `x-ms-blob-type: BlockBlob`) with `If-None-Match: *`, `Content-Type: application/gzip` and metadata `x-ms-meta-sha256`. There is no storage key or SAS. On Vercel, the function's Vercel OIDC token is the client assertion in an Entra ID `client_credentials` request (`REDBERRY_AZURE_TENANT_ID`, `REDBERRY_AZURE_CLIENT_ID`, scope `https://storage.azure.com/.default`). On Azure Functions and App Service, the token comes from the managed-identity endpoint (`IDENTITY_ENDPOINT`, `IDENTITY_HEADER`, with `REDBERRY_AZURE_CLIENT_ID` for a user-assigned identity). `AZURE_TENANT_ID` and `AZURE_CLIENT_ID` are read when the `REDBERRY_AZURE_*` names are unset, but the `REDBERRY_AZURE_*` names are recommended: `AZURE_CLIENT_ID` set app-wide also changes the identity the app's own `DefaultAzureCredential` uses. | Azure refuses (409 `BlobAlreadyExists`). The container's time-based immutability policy makes each object write-once: it cannot be changed or deleted until the retention period ends, even by the account owner once the policy is locked. Unlike Vercel Blob, this is immutability, not only no-overwrite. |
| `s3` | The customer's Amazon S3 bucket (`REDBERRY_S3_BUCKET`, `<bucket>` or `s3://<bucket>`, in `REDBERRY_S3_REGION`) at the path above. A SigV4-signed `PUT https://<bucket>.s3.<region>.amazonaws.com/<path>` (path-style on `s3.<region>.amazonaws.com` for a bucket name with dots) with `If-None-Match: *`, `Content-Type: application/gzip`, `x-amz-content-sha256` (the SHA-256 of the body, signed) and metadata `x-amz-meta-sha256`. There is no long-lived AWS key. On Vercel, the function's Vercel OIDC token goes to AWS STS `AssumeRoleWithWebIdentity` (unsigned, `https://sts.<region>.amazonaws.com/`) for the role `REDBERRY_AWS_ROLE_ARN`; the temporary credentials are cached until five minutes before they expire, and a 401 or 403 on the PUT assumes the role again, once. On AWS Lambda, the execution role's credentials come from the environment Lambda sets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`). | S3 refuses (412 `PreconditionFailed`, or 409 `ConditionalRequestConflict` while a concurrent write is in flight). The bucket is created with S3 Object Lock and a default retention period, which makes each object version write-once: it cannot be changed or deleted until the retention ends (in compliance mode, not even by the account root user). As with `azure-blob`, this is immutability, not only no-overwrite. |
| `redberry` | Redberry's bucket, under the object name VALP chooses (`agent=<id>/dt=<date>/<trace_id>…`), through a signed create-only PUT that VALP pins to this size and SHA-256 | VALP and GCS both refuse. A 412 on retry means the same bytes are already there. |

`REDBERRY_STORE` picks the store, and the default is `redberry`, as in the CLI. If the store write fails, the report still goes out with `stored: false`.

## 6. The hash report

`POST {REDBERRY_URL}/v1/agents/{agent_id}/hashes`

| Header | Value |
|---|---|
| `Authorization` | `Bearer <project token>`: 64 lowercase hex characters |
| `X-Redberry-Key` | `<key_id>`: 32 lowercase hex characters, `hex(SHA-256(raw 32-byte Ed25519 public key)[0:16])` (VALP `hashing.key_id`) |
| `X-Redberry-Signature` | `ed25519=<signature>`: standard padded base64 (RFC 4648 §4, 88 characters) of the 64-byte signature |
| `Content-Type` | `application/json` |

The body is canonical JSON (§3) of exactly these ten fields, and is at most 4,096 bytes:

```json
{"agent_id":"AGT-…","ended_at":"…Z","leaf_kind":"stored-bytes","sha256":"<64 hex>","size":5467,
 "started_at":"…Z","store":"vercel-blob","stored":true,"trace_id":"<32 hex>","v":1}
```

`started_at` and `ended_at` are the document's own (§1), and `sha256` and `size` are those of §5. Because the body is canonical, a retry sends identical bytes and VALP answers 200 rather than 409.

**Signature (VALP SUITE-1).** The signature is Ed25519 (RFC 8032, pure) over the 33 bytes `0x05 || SHA-256(body)`, where `body` is the raw request bytes. The key is `REDBERRY_SIGNING_KEY`: base64 of the PKCS8 DER private key (48 bytes, RFC 8410). `test/vectors/signature.json` was produced by VALP's own Python code (`valp_core.keys`, `valp_core.hashing`), and the TypeScript signature matches it byte for byte.

**Replies.**

| Reply | Meaning | What the package does |
|---|---|---|
| 201 `{leaf, window_start[, sample]}` | A new leaf | Counted as `recorded` |
| 200 | The same body was already recorded (a retry) | Counted as `duplicate` |
| 400, 401, 403, 404, 409, 413 | Refused | Final: logged and counted as `refused`, not retried |
| 5xx, 429, network error | Transient | Retried: 3 attempts in all, waiting 0.5 s and then 2 s. Then counted as `reportFailed`. |

**Pricing sample.** When a 200 or 201 reply carries `sample: {url, method, headers}`, the stored bytes are sent with `PUT` to `url` with exactly `headers`. The upload has the same retries as the report. A 412 means the sample is already there.

On Vercel, all of this runs inside `waitUntil` from `@vercel/functions`. Outside Vercel, `withRedberry` awaits it before the invocation returns (§10). Either way, OpenTelemetry tracing is suppressed so that the package's own requests add no spans.

## 7. Golden vectors

`test/vectors/v1-*.json` each hold an input (the processor's span objects in any order, plus the agent, trace and finish), and the expected canonical JSON, gzip bytes (base64), SHA-256 and size. They are:

- `v1-minimal`: two spans, given child first.
- `v1-spike-refund-run`: the spike's real 32-span AI SDK 7 run, given in reverse order.
- `v1-edge-cases`: key order across astral and private-use characters, escapes, number forms, equal start times and an open span cut at a deadline.

`test/vectors/signature.json` is the Python-made signature vector. The tests also check that each vector's gzip unpacks with both fflate and Node's `zlib`, and that span order and key insertion order do not change the hash.

## 8. When a trace is finalised, and for which agent

**Finish rule.** The processor finalises a trace when all three hold: the local root span has ended, no span of the trace is open, and no new span started during `graceMs` (default 2 s). A span that starts during the grace period resets it. A span that starts or ends after finalisation is counted as late and ignored. It never produces a second document.

**Escape hatches.** Each of these finalises a trace as `cut_short`. Open spans are included with `endTimeUnixNano: null`, and the trace is still stored and reported.

- `hard_stop`: `hardStopMs` (default 60 s) after the root ended, if spans are still open.
- `deadline`: when `deadlineMs` is set, `deadlineMarginMs` (default 5 s) before the earlier of two times: first span plus `deadlineMs`, and the invocation deadline from Vercel's `getDeadline()`. Verified live: a route with `maxDuration` 10 was cut at about 7 s with a 3 s margin, then stored and reported before the kill.
- `shutdown`: the span processor's `shutdown()`. A trace that already meets the finish rule at that moment is `complete`.

**Limitation.** A hard kill still loses the run. Examples are a function killed before the deadline timer fires (no `deadlineMs`, or a margin too small for the store and report), an out-of-memory crash, or an instance frozen without `waitUntil`. Nothing in-process survives that.

**Filters.**

- `REDBERRY_DISABLED=1` turns the processor off everywhere.
- On Vercel (`VERCEL_ENV` set), the processor runs only when `VERCEL_ENV` is `production`, unless `REDBERRY_ALL_ENVS=1`.
- On Azure App Service and Azure Functions (`WEBSITE_SITE_NAME` set, no `VERCEL_ENV`), it always runs. These platforms have no preview environments of their own.
- On AWS Lambda (`AWS_LAMBDA_FUNCTION_NAME` set, no `VERCEL_ENV` or `WEBSITE_SITE_NAME`), it always runs.
- Anywhere else (local development, CI), it runs only with `REDBERRY_ALL_ENVS=1`.
- It runs only in the Node.js runtime, never on Edge.
- By default, a trace is hashed only if it has an AI SDK span. That is a span with a `gen_ai.operation.name` attribute, a name starting `ai.`, or the scope `gen_ai` or `ai`.

**Agent.** AI SDK 7 drops `metadata`, so the agent never comes from the AI SDK's span attributes. It is decided here and then stamped on every span (§2.1). If the root span carries a valid `redberry.agent_id` (which `withRedberry({ agentId })` sets, §10), that agent wins. Otherwise the package checks `agentsByRoute` (`REDBERRY_AGENTS`) against the root span's routes, in this order: `http.route`, `next.route`, then the URL path (`url.path`, or `http.target` / `http.url` without the query string). A key matches exactly, or, if it ends in `*`, as a prefix, and the longest prefix wins. If nothing matches, the package uses `agentId` (`REDBERRY_AGENT_ID`). If there is still no agent, the trace is skipped and counted (`skippedNoAgent`). On Vercel, the processor turns itself off unless at least one agent is configured. Outside Vercel it may run with none configured, because `withRedberry` can name the agent per handler.

## 9. Verifying a stored trace

```text
bytes  = read the stored object
assert sha256(bytes) == leaf.body.sha256 and len(bytes) == leaf.body.size
assert Ed25519.verify(project key, 0x05 || sha256(leaf.body as bytes), leaf.signature)
doc    = JSON.parse(gunzip(bytes))
assert doc.schema == "redberry.trace.v1"
assert doc.agent_id == leaf.body.agent_id and doc.trace_id == leaf.body.trace_id
assert doc.started_at == leaf.body.started_at and doc.ended_at == leaf.body.ended_at
```

## 10. Azure Functions (Node.js)

Azure Functions has no `waitUntil`, so a run is not left to finish in the background. `withRedberry(handler, { agentId? })` wraps an Azure Functions v4 handler `(request, context) => …` (or any function), and each invocation becomes one trace:

1. It starts a new root span for the invocation, in a new trace, with the scope `@redberrylabs/otel`. The span is named after `context.functionName` and has the attributes `faas.name`, `faas.invocation_id`, `faas.trigger` and, when given, `redberry.agent_id`. For an HTTP trigger it also has `http.request.method`, `url.path` (never the query string, which can carry function keys) and `http.response.status_code`. If a span was already active, the root links to it.
2. It runs the handler with that span active. The AI SDK's spans start under `context.active()`, so they join the trace. This needs an AsyncLocalStorage context manager, which `registerRedberry()` registers.
3. When the handler settles, the root span ends. If nothing else in the trace is open, the trace is finalised at once, as `complete`, with no grace period, and the wrapper waits for the store write and the hash report before it returns. If spans are still open (a streamed response, say), the wrapper returns at once. The trace is then finalised, without the grace period, as soon as the last span ends, with `hardStopMs` and `deadlineMs` still applying.
4. The wait is bounded by `flushTimeoutMs` (default 10 s). Past it, the wrapper returns and the work carries on in the background.
5. The handler's return value is passed back unchanged. An error it throws is recorded on the root span (status 2 and an `exception` event) and rethrown after the flush.

A span that starts after the trace was finalised (work the handler did not await) is counted as late, as in §8.

`registerRedberry(options?)`, from `@redberrylabs/otel/node`, registers once per process a tracer provider with `RedberryProcessor`, an AsyncLocalStorage context manager, and a resource with `service.name` (option `serviceName`, else `OTEL_SERVICE_NAME`, else `WEBSITE_SITE_NAME`). On Azure the resource also carries `cloud.provider: "azure"`, `cloud.platform` (`azure.functions` or `azure.app_service`), `cloud.region` and `faas.instance`. If another tracer provider is already registered, it stays in place and `RedberryProcessor` has to be added to that provider instead.

The stored document, its bytes and the report are exactly those of §1 to §6: only the way the run is delimited and kept alive differs.

## 11. AWS Lambda (Node.js)

AWS Lambda freezes the execution environment as soon as the handler returns, so nothing may be left in the background. `withRedberry(handler, { agentId? })` wraps an async Lambda handler `async (event, context) => …` exactly as in §10, steps 1 to 5. Callback-style handlers are not supported. The second argument is recognised as a Lambda context by its `awsRequestId` and `functionName`. The root span is named after `context.functionName` and has these attributes:

| Attribute | Value |
|---|---|
| `faas.name` | `context.functionName` |
| `faas.invocation_id` | `context.awsRequestId` |
| `faas.trigger` | `http` for an API Gateway REST event (payload 1.0: `httpMethod`, `path`), an API Gateway HTTP API event or a Lambda function URL event (payload 2.0: `requestContext.http.method`, `rawPath`), else `other` |
| `cloud.provider`, `cloud.platform` | `aws`, `aws_lambda` |
| `cloud.region` | `AWS_REGION`, else the region in `context.invokedFunctionArn` |
| `cloud.account.id` | The account in `context.invokedFunctionArn`, when present |
| `http.request.method`, `url.path` | For an HTTP event only. The path never includes the query string. |
| `http.response.status_code` | The result's `statusCode` (or `status`), when it is a number |

The span kind is `SERVER` for an HTTP event and `INTERNAL` otherwise. The wrapper waits (at most `flushTimeoutMs`) for the store write and the hash report before it returns, so both happen inside the invocation and count against the function's timeout.

`registerRedberry()` on Lambda sets the resource's `service.name` from `AWS_LAMBDA_FUNCTION_NAME` when neither `serviceName` nor `OTEL_SERVICE_NAME` is given, and adds `cloud.provider: "aws"`, `cloud.platform: "aws_lambda"`, `cloud.region` (`AWS_REGION`), `faas.name`, `faas.version` (`AWS_LAMBDA_FUNCTION_VERSION`) and `faas.instance` (`AWS_LAMBDA_LOG_STREAM_NAME`).

The stored document, its bytes and the report are exactly those of §1 to §6.
