// The live RedberryProcessors, so withRedberry can finalise its invocation's trace without being handed the
// processor. Kept on globalThis: the ESM and CJS builds (and the /node entry) each have their own copy of
// this module, and an app may load more than one.
import type { TraceResult } from './processor';

export interface Settler {
  settle(traceId: string): Promise<TraceResult | undefined> | undefined;
}

const KEY = Symbol.for('@redberrylabs/otel.processors');

export function processors(): Set<Settler> {
  const g = globalThis as { [KEY]?: Set<Settler> };
  return (g[KEY] ??= new Set());
}
