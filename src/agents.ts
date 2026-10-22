// Which Redberry agent a trace belongs to. AI SDK 7 drops ``metadata``, so the package does not read an
// agent id from the AI spans: it decides from its own config (or the root span withRedberry opens) and
// records the answer as the envelope's ``agent_id`` (and the report's).
import type { Attributes } from '@opentelemetry/api';
import { AGENT_ATTRIBUTE } from './envelope';

export const AGENT_ID = /^AGT-[0-9A-HJKMNP-TV-Z]{26}$/;

export const isAgentId = (s: unknown): s is string => typeof s === 'string' && AGENT_ID.test(s);

/**
 * The root span's candidate routes, in order: ``http.route``, ``next.route``, then the URL path
 * (``url.path``, or ``http.target`` / ``http.url`` without the query string).
 */
export function routeCandidates(attrs: Attributes): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string' && v && !out.includes(v)) out.push(v);
  };
  add(attrs['http.route']);
  add(attrs['next.route']);
  add(attrs['url.path']);
  for (const k of ['http.target', 'http.url', 'url.full']) {
    const v = attrs[k];
    if (typeof v !== 'string' || !v) continue;
    try {
      add(new URL(v, 'http://x').pathname);
    } catch {
      add(v.split('?')[0]);
    }
  }
  return out;
}

/**
 * Match one route against a ``route -> agent`` map. A key matches exactly, or, ending in ``*``, as a
 * prefix (``/api/agents/*``, ``/api/*``); the longest prefix wins.
 */
export function matchRoute(route: string, map: Record<string, string>): string | undefined {
  if (Object.hasOwn(map, route)) return map[route];
  let best: string | undefined;
  for (const key of Object.keys(map)) {
    if (!key.endsWith('*')) continue;
    const prefix = key.slice(0, -1);
    if (route.startsWith(prefix) && (best === undefined || prefix.length > best.length - 1)) best = key;
  }
  return best === undefined ? undefined : map[best];
}

/**
 * The root span's own ``redberry.agent_id`` (set by withRedberry), else the route map against the root
 * span's routes (first candidate that matches), else the default agent.
 */
export function resolveAgent(rootAttrs: Attributes, agentsByRoute: Record<string, string> | undefined, agentId: string | undefined): string | undefined {
  const own = rootAttrs[AGENT_ATTRIBUTE];
  if (isAgentId(own)) return own;
  if (agentsByRoute) {
    for (const route of routeCandidates(rootAttrs)) {
      const hit = matchRoute(route, agentsByRoute);
      if (hit) return hit;
    }
  }
  return agentId || undefined;
}
