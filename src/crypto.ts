// SHA-256, VALP key ids and SUITE-1 Ed25519 signatures, on WebCrypto only (no dependency).
//
// SUITE-1 (valp_core.hashing.signing_message): Ed25519 signs the 33 bytes 0x05 || SHA-256(raw body),
// never the body itself. key_id (valp_core.hashing.key_id): lowercase hex of the first 16 bytes of
// SHA-256 over the raw 32-byte public key.
import { concat, hex, unb64 } from './encoding';

const ED25519 = { name: 'Ed25519' } as const;
const SIG_CONTEXT = 0x05;
/** DER prefix of a PKCS8 Ed25519 private key; the 32-byte seed follows (RFC 8410). */
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf(data)));
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return hex(await sha256(data));
}

/** ``valp_core.hashing.key_id``: hex of SHA-256(raw public key)[:16]. */
export async function keyIdOf(publicKey: Uint8Array): Promise<string> {
  if (publicKey.byteLength !== 32) throw new Error('an Ed25519 public key is 32 raw bytes');
  return hex((await sha256(publicKey)).slice(0, 16));
}

/** The 33 bytes Ed25519 signs: 0x05 || SHA-256(body). */
export async function signingMessage(body: Uint8Array): Promise<Uint8Array> {
  return concat(Uint8Array.of(SIG_CONTEXT), await sha256(body));
}

export interface Signer {
  readonly keyId: string;
  readonly publicKey: Uint8Array;
  /** The 64-byte SUITE-1 signature over ``body`` exactly as it will be sent. */
  sign(body: Uint8Array): Promise<Uint8Array>;
}

/**
 * Decode ``REDBERRY_SIGNING_KEY``: base64 PKCS8 DER (what the Redberry CLI writes, via Python
 * ``cryptography``). A PEM ``PRIVATE KEY`` block or a bare base64 32-byte seed are accepted too.
 */
export function decodeSigningKey(value: string): Uint8Array {
  const body = value.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').trim();
  const der = unb64(body);
  if (der.byteLength === 32) return concat(PKCS8_PREFIX, der);
  if (der.byteLength !== 48 || PKCS8_PREFIX.some((b, i) => der[i] !== b)) {
    throw new Error('REDBERRY_SIGNING_KEY is not a base64 PKCS8 Ed25519 private key');
  }
  return der;
}

export async function loadSigner(signingKey: string, keyId?: string): Promise<Signer> {
  const pkcs8 = decodeSigningKey(signingKey);
  // Extractable only so the public half can be read back as a JWK; the CryptoKey never leaves here.
  const key = await crypto.subtle.importKey('pkcs8', buf(pkcs8), ED25519, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  if (!jwk.x) throw new Error('could not derive the Ed25519 public key');
  const publicKey = unb64(jwk.x);
  const derived = await keyIdOf(publicKey);
  if (keyId && keyId !== derived) {
    throw new Error(`REDBERRY_KEY_ID ${keyId} is not the id of REDBERRY_SIGNING_KEY (${derived})`);
  }
  return {
    keyId: derived,
    publicKey,
    async sign(body) {
      return new Uint8Array(await crypto.subtle.sign(ED25519, key, buf(await signingMessage(body))));
    },
  };
}

/** Verify a SUITE-1 signature (tests, and anyone checking a stored report). */
export async function verify(publicKey: Uint8Array, body: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', buf(publicKey), ED25519, false, ['verify']);
  return crypto.subtle.verify(ED25519, key, buf(signature), buf(await signingMessage(body)));
}
