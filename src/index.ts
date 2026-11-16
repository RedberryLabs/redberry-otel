export { VERSION } from './version';
export {
  redberryExporter,
  ExportResultCode,
  DISCOVERY_FAILURE_ATTRIBUTE,
  type Cloud,
  type RedberryExporter,
  type RedberryExporterOptions,
  type GcpExporterOptions,
  type AwsExporterOptions,
  type AzureExporterOptions,
} from './ingest/exporter';
export { discoveryFailureMarker } from './ingest/marker';
export { gcpCredential, awsCredential, azureCredential, type IngestCredential } from './ingest/credentials';
export { encodeOtlpJson } from './ingest/otlp';
export { validateAgentName, exporterOptionsFrom, AGENT_NAME_ATTRIBUTE, type IngestConfig } from './ingest/config';
