# Changelog

All notable changes to `@redberrylabs/otel` are recorded here. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Licence.** From this release the package is licensed under the PolyForm Shield License 1.0.0, replacing the
  Apache License 2.0. Versions 0.5.0 and earlier remain under the Apache License 2.0. See `LICENSE` and `NOTICE`.

### Removed

- **The in-process hasher.** `RedberryProcessor`, `withRedberry`, `registerRedberry` (the `@redberrylabs/otel/node`
  entry), the stores (`vercelBlob`, `gcs`, `azureBlob`, `s3`, `redberry`) and the stored-trace and report functions
  (`buildEnvelope`, `encodeTrace`, `canonicalJson`, `loadSigner`, `sendReport` and the rest) are removed. They were
  deprecated in favour of `redberryExporter()` and `init()`, which send spans to the ingest service in the
  customer's cloud; no signing key, bucket or hashing runs in the agent's process. `SPEC.md` (the
  `redberry.trace.v1` format) is no longer shipped. `fflate` is no longer a dependency, and `@vercel/blob` no longer
  a peer dependency.

## [0.5.0] - 2026-11-05

### Added

- `discoveryFailureMarker(exporter)`: for an hour after the exporter recovers from a discovery failure, new spans
  carry `redberry.sdk.discovery_failure` (`<code>;<minutes>`), so the install can show how long the agent could
  not send. `init()` adds it; with `@vercel/otel`, add it beside `redberryExporter()`.
- `exporter.recentRecovery()`, and the `discoveryRetryMs` option (`REDBERRY_DISCOVERY_RETRY_S`).

### Changed

- When the install cannot be found on AWS or Azure, the exporter says so once with a code and the fix
  (`RB-SDK-DISC-002`, `RB-SDK-DISC-003`), on the console as well as the `diag` logger, so it shows in Lambda,
  Azure and Vercel logs. Discovery is tried again every 5 minutes instead of on every export, and its recovery is
  logged.
- Releases to npm now wait for a maintainer's approval (the `npm` environment).

## [0.4.0] - 2026-11-02

### Added

- `redberryExporter` and `init()` (from `@redberrylabs/otel/init`): OTLP/HTTP export of an agent's spans to the
  customer's Redberry ingest service.
- AWS: the ingest URL is discovered from the installation's `ingest.json`.
- Azure: managed identity credentials and ingest discovery.
- Platform resource attributes, including `vercel.deployment_id`, `vercel.project_id`, `vercel.region` and
  `vercel.sha` on Vercel, and `faas.*` and `cloud.region` on AWS Lambda and Azure.

### Changed

- The build no longer requires `@vercel/blob` unless the `vercel-blob` store is used.

## [0.3.0] - 2026-10-26

### Added

- AWS: the `s3` store (SigV4 signing; credentials from Vercel OIDC through STS, or from the Lambda runtime) and
  support for the AWS Lambda runtime.

### Fixed

- `s3`: sends `x-amz-checksum-sha256`, which Object Lock buckets require on `PutObject`.

## [0.2.0] - 2026-10-22

### Added

- Azure: the `azure-blob` store and Azure Functions support.

### Changed

- `azure-blob` prefers `REDBERRY_AZURE_TENANT_ID` and `REDBERRY_AZURE_CLIENT_ID`.

## [0.1.1] - 2026-10-22

### Changed

- Releases are published with npm trusted publishing and provenance.

## [0.1.0] - 2026-10-22

- First release.

[Unreleased]: https://github.com/RedberryLabs/redberry-otel/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/RedberryLabs/redberry-otel/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/RedberryLabs/redberry-otel/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/RedberryLabs/redberry-otel/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/RedberryLabs/redberry-otel/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/RedberryLabs/redberry-otel/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/RedberryLabs/redberry-otel/releases/tag/v0.1.0
