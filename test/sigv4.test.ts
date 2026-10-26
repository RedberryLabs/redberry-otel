// SigV4 against AWS's published examples: the SigV4 test suite (get-vanilla, post-vanilla,
// get-vanilla-query-order-key-case), the IAM ListUsers example from the IAM User Guide, and the S3 examples
// (GET Object, PUT Object) from "Signature Calculations for the Authorization Header" in the S3 API Reference.
import { describe, expect, it } from 'vitest';
import { amzDate, EMPTY_SHA256, sha256Hex, sign, signingKey, uriEncode } from '../src/sigv4';

const SUITE = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const SUITE_DATE = new Date('2015-08-30T12:36:00Z');
const S3_KEYS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const S3_DATE = new Date('2013-05-24T00:00:00Z');

describe('SigV4 test suite', () => {
  const base = { region: 'us-east-1', service: 'service', credentials: SUITE, date: SUITE_DATE, payloadHash: EMPTY_SHA256 };

  it('get-vanilla', () => {
    const s = sign({ ...base, method: 'GET', url: 'https://example.amazonaws.com/' });
    expect(s.canonicalRequest).toBe(
      'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n' + EMPTY_SHA256,
    );
    expect(s.stringToSign).toBe(
      'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
    );
    expect(s.signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    expect(s.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('post-vanilla', () => {
    const s = sign({ ...base, method: 'POST', url: 'https://example.amazonaws.com/' });
    expect(s.canonicalRequest).toBe(
      'POST\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n' + EMPTY_SHA256,
    );
    expect(s.signature).toBe('5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b');
  });

  it('get-vanilla-query-order-key-case', () => {
    const s = sign({ ...base, method: 'GET', url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1' });
    expect(s.canonicalRequest.split('\n')[2]).toBe('Param1=value1&Param2=value2');
    expect(s.signature).toBe('b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500');
  });

  it('the IAM ListUsers example (IAM User Guide)', () => {
    const s = sign({
      method: 'GET',
      url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      payloadHash: EMPTY_SHA256,
      region: 'us-east-1',
      service: 'iam',
      credentials: SUITE,
      date: SUITE_DATE,
    });
    expect(sha256Hex(s.canonicalRequest)).toBe('f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59');
    expect(signingKey(SUITE.secretAccessKey, '20150830', 'us-east-1', 'iam').toString('hex')).toBe(
      'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9',
    );
    expect(s.signature).toBe('5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  });
});

describe('S3 examples (S3 API Reference)', () => {
  it('GET Object with a Range header', () => {
    const s = sign({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      headers: { range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_SHA256 },
      payloadHash: EMPTY_SHA256,
      region: 'us-east-1',
      service: 's3',
      credentials: S3_KEYS,
      date: S3_DATE,
    });
    expect(s.canonicalRequest).toBe(
      'GET\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\nx-amz-content-sha256:' + EMPTY_SHA256 +
        '\nx-amz-date:20130524T000000Z\n\nhost;range;x-amz-content-sha256;x-amz-date\n' + EMPTY_SHA256,
    );
    expect(s.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('PUT Object (test$file.text, "Welcome to Amazon S3.")', () => {
    const body = 'Welcome to Amazon S3.';
    const payloadHash = sha256Hex(body);
    expect(payloadHash).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const s = sign({
      method: 'PUT',
      url: 'https://examplebucket.s3.amazonaws.com/test$file.text',
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY', 'x-amz-content-sha256': payloadHash },
      payloadHash,
      region: 'us-east-1',
      service: 's3',
      credentials: S3_KEYS,
      date: S3_DATE,
    });
    expect(s.canonicalRequest.split('\n').slice(0, 2)).toEqual(['PUT', '/test%24file.text']);
    expect(s.canonicalRequest.endsWith('\n\ndate;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class\n' + payloadHash)).toBe(true);
    expect(s.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('adds the session token as a signed header', () => {
    const s = sign({
      method: 'PUT', url: 'https://b.s3.us-east-1.amazonaws.com/k', payloadHash: EMPTY_SHA256, region: 'us-east-1', service: 's3',
      credentials: { ...S3_KEYS, sessionToken: 'tok' }, date: S3_DATE,
    });
    expect(s.headers['x-amz-security-token']).toBe('tok');
    expect(s.headers.authorization).toContain('SignedHeaders=host;x-amz-date;x-amz-security-token,');
  });
});

describe('helpers', () => {
  it('encodes per RFC 3986 and formats the date', () => {
    expect(uriEncode("a b/c!'()*~")).toBe('a%20b%2Fc%21%27%28%29%2A~');
    expect(uriEncode('a/b', true)).toBe('a/b');
    expect(amzDate(new Date('2026-10-26T09:08:07.123Z'))).toBe('20261026T090807Z');
  });
});
