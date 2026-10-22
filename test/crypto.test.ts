// Against test/vectors/signature.json, which VALP's own Python (valp_core.keys / hashing) produced:
// scripts/python/make_signature_vector.py.
import { describe, expect, it } from 'vitest';
import { decodeSigningKey, keyIdOf, loadSigner, signingMessage, verify } from '../src/crypto';
import { b64, hex, unb64, utf8 } from '../src/encoding';
import { reportBytes, type ReportBody } from '../src/report';
import v from './vectors/signature.json';
import { fromHex } from './helpers';

describe('VALP SUITE-1 signatures, against the Python vector', () => {
  it('derives VALP key_id from the public key (valp_core.hashing.key_id)', async () => {
    expect(await keyIdOf(fromHex(v.public_key_hex))).toBe(v.key_id);
  });

  it('loads the PKCS8 key the CLI writes, and derives its public key and key_id', async () => {
    const s = await loadSigner(v.signing_key_pkcs8_b64);
    expect(hex(s.publicKey)).toBe(v.public_key_hex);
    expect(s.keyId).toBe(v.key_id);
  });

  it('builds the signing message 0x05 || SHA-256(body)', async () => {
    expect(hex(await signingMessage(utf8(v.body)))).toBe(v.signing_message_hex);
  });

  it('produces the very signature Python produced (Ed25519 is deterministic)', async () => {
    const s = await loadSigner(v.signing_key_pkcs8_b64, v.key_id);
    const sig = await s.sign(utf8(v.body));
    expect(b64(sig)).toBe(v.signature_b64);
    expect(`ed25519=${b64(sig)}`).toHaveLength('ed25519='.length + 88);
    expect(await verify(fromHex(v.public_key_hex), utf8(v.body), unb64(v.signature_b64))).toBe(true);
  });

  it('serialises the report body exactly as the Python vector did (sorted, compact)', () => {
    const body = JSON.parse(v.body) as ReportBody;
    expect(new TextDecoder().decode(reportBytes(body))).toBe(v.body);
  });

  it('rejects a tampered body', async () => {
    const tampered = utf8(v.body.replace('5321', '5322'));
    expect(await verify(fromHex(v.public_key_hex), tampered, unb64(v.signature_b64))).toBe(false);
  });

  it('accepts a PEM block or a bare 32-byte seed for the same key', async () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${v.signing_key_pkcs8_b64}\n-----END PRIVATE KEY-----\n`;
    expect((await loadSigner(pem)).keyId).toBe(v.key_id);
    expect((await loadSigner(b64(fromHex(v.seed_hex)))).keyId).toBe(v.key_id);
  });

  it('refuses a key_id that is not the key\'s, and a key that is not Ed25519 PKCS8', async () => {
    await expect(loadSigner(v.signing_key_pkcs8_b64, '0'.repeat(32))).rejects.toThrow(/not the id/);
    expect(() => decodeSigningKey(b64(new Uint8Array(40)))).toThrow(/PKCS8/);
  });
});
