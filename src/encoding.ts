// Byte helpers that work the same in Node and any WebCrypto runtime (no Buffer).

const enc = new TextEncoder();

export const utf8 = (s: string): Uint8Array => enc.encode(s);

export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Standard, padded base64 (RFC 4648 §4), as VALP's signature header expects. */
export function b64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** Standard or URL-safe base64, padded or not. */
export function unb64(s: string): Uint8Array {
  let t = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
