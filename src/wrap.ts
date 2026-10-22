// withRedberry: one invocation of a handler as one agent run, for runtimes without Vercel's waitUntil (Azure
// Functions above all). It opens the invocation's root span, runs the handler inside it so the AI SDK's spans
// join that trace, and once the handler has settled, ends the root, has the processor finalise the trace at
// once (no grace period: the root is ours and nothing else is open) and waits for the store write and the
// signed hash report before handing back the handler's own result. The wait is bounded, so a slow store
// never holds the function: past ``flushTimeoutMs`` the work carries on in the background.
import { context, isSpanContextValid, SpanKind, SpanStatusCode, trace, type Attributes, type Link } from '@opentelemetry/api';
import { isAgentId } from './agents';
import { defaultLogger } from './config';
import { AGENT_ATTRIBUTE } from './envelope';
import { processors } from './registry';
import { VERSION } from './version';

/** The instrumentation scope of the root spans withRedberry opens. */
export const TRACER_NAME = '@redberrylabs/otel';

export const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;

export interface WithRedberryOptions {
  /** The agent this handler's runs belong to. Wins over REDBERRY_AGENTS and REDBERRY_AGENT_ID. */
  agentId?: string;
  /** The root span's name. Default: the Azure Functions function name, else the handler's name. */
  name?: string;
  /** The longest the wrapper waits, after the handler, for the store write and hash report (ms, default 10000). */
  flushTimeoutMs?: number;
}

interface HttpRequestLike {
  method: string;
  url: string;
}

interface InvocationContextLike {
  invocationId: string;
  functionName: string;
  options?: { trigger?: { type?: unknown } };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const isHttpRequest = (v: unknown): v is HttpRequestLike => isObject(v) && typeof v.method === 'string' && typeof v.url === 'string';

const isInvocationContext = (v: unknown): v is InvocationContextLike =>
  isObject(v) && typeof v.invocationId === 'string' && typeof v.functionName === 'string';

/** OpenTelemetry ``faas.trigger`` for an Azure Functions binding type. */
function faasTrigger(type: unknown): string {
  if (type === 'httpTrigger') return 'http';
  if (type === 'timerTrigger') return 'timer';
  if (typeof type !== 'string') return 'other';
  if (/^(queue|serviceBus|eventHub|eventGrid|webPubSub)Trigger$/.test(type)) return 'pubsub';
  if (/^(blob|cosmosDB|sql|mysql)Trigger$/.test(type)) return 'datasource';
  return 'other';
}

/** The root span's name, kind and attributes, from the handler's arguments. */
function describeInvocation(args: unknown[], fallbackName: string): { name: string; kind: SpanKind; attributes: Attributes } {
  const attributes: Attributes = {};
  const request = args.find(isHttpRequest);
  const ctx = args.find(isInvocationContext);
  if (ctx) {
    attributes['faas.name'] = ctx.functionName;
    attributes['faas.invocation_id'] = ctx.invocationId;
    attributes['faas.trigger'] = request ? 'http' : faasTrigger(ctx.options?.trigger?.type);
  }
  if (request) {
    attributes['http.request.method'] = request.method;
    try {
      // The path only: Azure Functions keys travel in the query string (?code=…).
      attributes['url.path'] = new URL(request.url).pathname;
    } catch {
      // not an absolute URL: leave it out
    }
  }
  return {
    name: ctx?.functionName || fallbackName || 'invocation',
    kind: request ? SpanKind.SERVER : SpanKind.INTERNAL,
    attributes,
  };
}

/** Finalise the trace in every live processor that holds it, and wait (at most ``ms``) for the outcome. */
async function flush(traceId: string, ms: number): Promise<void> {
  const pending: Promise<unknown>[] = [];
  for (const p of processors()) {
    try {
      const work = p.settle(traceId);
      if (work) pending.push(work);
    } catch (e) {
      defaultLogger.error(`withRedberry: trace ${traceId}: ${String(e)}`);
    }
  }
  if (pending.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((r) => (timer = setTimeout(() => r(true), ms)));
  const late = await Promise.race([Promise.allSettled(pending).then(() => false), timedOut]);
  clearTimeout(timer);
  if (late) defaultLogger.warn(`withRedberry: trace ${traceId} not stored and reported within ${ms} ms; continuing in the background`);
}

/**
 * Wrap an Azure Functions v4 handler ``(request, context) => …`` (or any function) so that each invocation
 * is one trace, hashed, stored and reported before the wrapper returns. The handler's result is returned
 * unchanged, and an error it throws is rethrown, after the flush. Without a registered tracer provider
 * (``registerRedberry()``) or with the processor disabled, the handler simply runs.
 */
export function withRedberry<A extends unknown[], R>(handler: (...args: A) => R, options: WithRedberryOptions = {}): (...args: A) => Promise<Awaited<R>> {
  const agentId = options.agentId;
  if (agentId !== undefined && !isAgentId(agentId)) {
    defaultLogger.warn(`withRedberry: ${JSON.stringify(agentId)} is not an agent id (AGT- and a ULID); using the configured agent`);
  }
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  return async function redberryInvocation(this: unknown, ...args: A): Promise<Awaited<R>> {
    const { name, kind, attributes } = describeInvocation(args, handler.name);
    if (isAgentId(agentId)) attributes[AGENT_ATTRIBUTE] = agentId;
    // A new trace per invocation, linked to whatever span was active (a host's own instrumentation).
    const active = trace.getSpanContext(context.active());
    const links: Link[] = active && isSpanContextValid(active) ? [{ context: active }] : [];
    const span = trace.getTracer(TRACER_NAME, VERSION).startSpan(options.name ?? name, { root: true, kind, attributes, links });
    let failed = false;
    let error: unknown;
    let result: Awaited<R> | undefined;
    try {
      result = await context.with(trace.setSpan(context.active(), span), () => handler.apply(this, args));
      const status = isObject(result) ? result.status : undefined;
      if (typeof status === 'number') span.setAttribute('http.response.status_code', status);
    } catch (e) {
      failed = true;
      error = e;
      span.recordException(e instanceof Error ? e : String(e));
      span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
    }
    span.end();
    if (isSpanContextValid(span.spanContext())) await flush(span.spanContext().traceId, flushTimeoutMs);
    if (failed) throw error;
    return result as Awaited<R>;
  };
}
