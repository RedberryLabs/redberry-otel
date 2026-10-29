// @redberrylabs/otel/node: the OpenTelemetry set-up for Node.js outside Vercel (Azure Functions and AWS
// Lambda above all).
// On Vercel, keep @vercel/otel's registerOTel with RedberryProcessor in its spanProcessors.
//
// registerRedberry() registers, once per process, a tracer provider that runs RedberryProcessor and an
// AsyncLocalStorage context manager, so that the AI SDK's spans (which start under context.active()) join
// the root span withRedberry opens for each invocation. This entry point needs the optional peers
// @opentelemetry/context-async-hooks and @opentelemetry/resources; the main entry point never loads them.
import { context, trace, type Attributes } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { defaultLogger, type RedberryOptions } from './config';
import { RedberryProcessor } from './processor';

export * from './index';

export interface RegisterRedberryOptions extends RedberryOptions {
  /**
   * The resource's ``service.name``. Default: OTEL_SERVICE_NAME, else WEBSITE_SITE_NAME (the Azure app's
   * name), else AWS_LAMBDA_FUNCTION_NAME.
   */
  serviceName?: string;
  /** More span processors to run beside Redberry's (an exporter's, for example). */
  spanProcessors?: SpanProcessor[];
}

const KEY = Symbol.for('@redberrylabs/otel.registered');

type Env = Record<string, string | undefined>;

/** The resource every span carries, and so the stored trace's ``resource``. */
export function resourceAttributes(env: Env, serviceName?: string): Attributes {
  const a: Attributes = {
    'service.name': serviceName || env.OTEL_SERVICE_NAME || env.WEBSITE_SITE_NAME || env.AWS_LAMBDA_FUNCTION_NAME || 'unknown_service:node',
  };
  if (env.WEBSITE_SITE_NAME) {
    a['cloud.provider'] = 'azure';
    a['cloud.platform'] = env.FUNCTIONS_WORKER_RUNTIME ? 'azure.functions' : 'azure.app_service';
    if (env.REGION_NAME) a['cloud.region'] = env.REGION_NAME;
    if (env.WEBSITE_INSTANCE_ID) a['faas.instance'] = env.WEBSITE_INSTANCE_ID;
  } else if (env.AWS_LAMBDA_FUNCTION_NAME) {
    a['cloud.provider'] = 'aws';
    a['cloud.platform'] = 'aws_lambda';
    if (env.AWS_REGION) a['cloud.region'] = env.AWS_REGION;
    a['faas.name'] = env.AWS_LAMBDA_FUNCTION_NAME;
    if (env.AWS_LAMBDA_FUNCTION_VERSION) a['faas.version'] = env.AWS_LAMBDA_FUNCTION_VERSION;
    if (env.AWS_LAMBDA_LOG_STREAM_NAME) a['faas.instance'] = env.AWS_LAMBDA_LOG_STREAM_NAME;
  }
  return a;
}

/**
 * Set up tracing with RedberryProcessor for this process and return the processor. Call it once, before
 * the handlers run (at the top of the module that registers them); later calls return the same processor.
 * When the processor is disabled (local development, say) and no other span processor is given, nothing is
 * registered. If another tracer provider is already registered globally (the Azure Monitor distro, for
 * example), it is left in place: add ``new RedberryProcessor()`` to that provider's span processors instead.
 * @deprecated In-process hashing is replaced by sending spans to the Redberry ingest service in your cloud: use redberryExporter() or init().
 */
export function registerRedberry(options: RegisterRedberryOptions = {}): RedberryProcessor {
  const g = globalThis as { [KEY]?: RedberryProcessor };
  if (g[KEY]) return g[KEY];
  const { serviceName, spanProcessors = [], ...rest } = options;
  const processor = new RedberryProcessor(rest);
  g[KEY] = processor;
  if (!processor.stats().enabled && spanProcessors.length === 0) return processor;

  const manager = new AsyncLocalStorageContextManager().enable();
  if (!context.setGlobalContextManager(manager)) manager.disable(); // one is registered already: keep it
  const provider = new BasicTracerProvider({
    resource: defaultResource().merge(resourceFromAttributes(resourceAttributes(process.env, serviceName))),
    spanProcessors: [processor, ...spanProcessors],
  });
  if (!trace.setGlobalTracerProvider(provider)) {
    (rest.logger ?? defaultLogger).warn(
      'registerRedberry: another tracer provider is already registered; add new RedberryProcessor() to its span processors instead',
    );
  }
  return processor;
}
