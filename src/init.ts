// @redberrylabs/otel/init: the simple entry point. Registers, once per process, a tracer provider whose batch span processor
// sends every span to the Redberry ingest service in the customer's cloud, with the resource attribute
// ``redberry.agent.name``. On Vercel with @vercel/otel, pass redberryExporter() to registerOTel instead
// (see the README).
import { context, diag, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AGENT_NAME_ATTRIBUTE, exporterOptionsFrom, platformResourceAttributes, validateAgentName, type IngestConfig } from './ingest/config';
import { redberryExporter, type RedberryExporter } from './ingest/exporter';

export * from './index';

type Env = Record<string, string | undefined>;

export interface InitOptions extends IngestConfig {
  /** The agent's name, sent as the resource attribute ``redberry.agent.name``. */
  agent: string;
  /** ``service.name``. Default: OTEL_SERVICE_NAME, else the agent name. */
  serviceName?: string;
  /** The batch processor's queue bound (default 2048); spans over it are dropped. */
  maxQueueSize?: number;
  /** More span processors to run beside Redberry's. */
  spanProcessors?: SpanProcessor[];
  /** Where the REDBERRY_* variables are read (default: process.env). */
  env?: Env;
}

export interface RedberryTracing {
  provider: BasicTracerProvider;
  exporter: RedberryExporter;
  /** Flush and stop. */
  shutdown(): Promise<void>;
}

const KEY = Symbol.for('@redberrylabs/otel.init');

/**
 * Set up tracing to the Redberry ingest service. Idempotent: later calls return the first call's result.
 * Throws on an invalid agent name or incomplete configuration; never throws once spans flow.
 */
export function init(options: InitOptions): RedberryTracing {
  const g = globalThis as { [KEY]?: RedberryTracing };
  if (g[KEY]) return g[KEY];
  const agent = validateAgentName(options?.agent);
  const env = options.env ?? process.env;
  const exporter = redberryExporter(exporterOptionsFrom(options, env));
  const manager = new AsyncLocalStorageContextManager().enable();
  if (!context.setGlobalContextManager(manager)) manager.disable(); // one is registered already: keep it
  const provider = new BasicTracerProvider({
    resource: defaultResource().merge(
      resourceFromAttributes({
        ...platformResourceAttributes(env),
        'service.name': options.serviceName || env.OTEL_SERVICE_NAME || agent,
        [AGENT_NAME_ATTRIBUTE]: agent,
      }),
    ),
    spanProcessors: [new BatchSpanProcessor(exporter, { maxQueueSize: options.maxQueueSize ?? 2048 }), ...(options.spanProcessors ?? [])],
  });
  if (!trace.setGlobalTracerProvider(provider)) {
    diag.warn('@redberrylabs/otel: another tracer provider is already registered; pass redberryExporter() to it instead');
  }
  const result: RedberryTracing = { provider, exporter, shutdown: () => provider.shutdown() };
  g[KEY] = result;
  return result;
}
