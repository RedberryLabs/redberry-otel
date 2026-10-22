// Canonical JSON and deterministic gzip, pinned in SPEC.md §3-§4. Any change here changes hashes:
// bump the envelope schema and add new golden vectors instead of editing old ones.
import { gzipSync } from 'fflate';

/**
 * RFC 8785 (JCS) JSON: object keys sorted by UTF-16 code units at every level, no whitespace,
 * numbers in ECMAScript shortest round-trip form, strings as ECMAScript JSON.stringify escapes them.
 * Beyond JCS, for values OpenTelemetry can hold but JSON cannot: an ``undefined`` object member is
 * omitted, an ``undefined`` array element is ``null``, a non-finite number is the string ``"NaN"``,
 * ``"Infinity"`` or ``"-Infinity"``, a bigint is its decimal string, and -0 is ``0``.
 */
export function canonicalJson(value: unknown): string {
  return write(value);
}

function write(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (Number.isFinite(v)) return JSON.stringify(v); // -0 -> "0"
      return JSON.stringify(Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity');
    case 'bigint':
      return JSON.stringify(v.toString());
    case 'object': {
      if (Array.isArray(v)) return `[${v.map(write).join(',')}]`;
      if (ArrayBuffer.isView(v)) throw new TypeError('canonicalJson: binary values are not supported');
      const o = v as Record<string, unknown>;
      const parts: string[] = [];
      for (const k of Object.keys(o).sort()) {
        if (o[k] === undefined || typeof o[k] === 'function' || typeof o[k] === 'symbol') continue;
        parts.push(`${JSON.stringify(k)}:${write(o[k])}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: cannot encode a ${typeof v}`);
  }
}

/** UTF-8 bytes of the canonical JSON. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

/**
 * gzip (RFC 1952) with fflate 0.8.3 at level 6: header 1f 8b 08 00 00000000 00 03 (no flags, no file
 * name, mtime 0, XFL 0, OS 3). The same input gives the same bytes on every run and machine.
 */
export function deterministicGzip(data: Uint8Array): Uint8Array {
  return gzipSync(data, { level: 6, mtime: 0 });
}
