/**
 * APNs JWT signer tests: the provider token has the shape APNs expects and really verifies.
 *
 * Generates a throwaway P-256 key pair, exports the private half as a PKCS#8 PEM exactly
 * like an Apple .p8 file, signs a token with it and checks the header, the claims, the raw
 * 64-byte r||s signature and that the matching public key verifies it.
 *
 * - Uses only WebCrypto, which Node 22 and the Workers runtime both provide.
 * - No network; the key never leaves the test process.
 *
 * <module-headers:begin>
 * Uses:
 * test/apns-jwt.test.ts
 * └── src/apns-jwt.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in the Worker directory)
 * <module-headers:end>
 */
import { describe, expect, it } from 'vitest';
import { base64url, pemToDer, signProviderJwt } from '../src/apns-jwt';

function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function makeKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return { pem: `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

describe('signProviderJwt', () => {
  it('produces an ES256 JWT with kid, iss and iat, a 64-byte signature that verifies', async () => {
    const { pem, publicKey } = await makeKey();
    const jwt = await signProviderJwt(pem, 'KID1234567', 'TEAM123456', 1_700_000_000);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    const [h, c, s] = parts as [string, string, string];
    const dec = new TextDecoder();
    expect(JSON.parse(dec.decode(fromBase64url(h)))).toEqual({ alg: 'ES256', kid: 'KID1234567' });
    expect(JSON.parse(dec.decode(fromBase64url(c)))).toEqual({ iss: 'TEAM123456', iat: 1_700_000_000 });
    const sig = fromBase64url(s);
    expect(sig.length).toBe(64);
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      sig,
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });

  it('defaults iat to now', async () => {
    const { pem } = await makeKey();
    const before = Math.floor(Date.now() / 1000);
    const jwt = await signProviderJwt(pem, 'K', 'T');
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(jwt.split('.')[1] ?? '')));
    expect(claims.iat).toBeGreaterThanOrEqual(before);
  });
});

describe('helpers', () => {
  it('base64url has no padding or URL-unsafe characters', () => {
    expect(base64url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-');
    expect(base64url('a')).toBe('YQ');
  });

  it('pemToDer ignores armour and line breaks', () => {
    const der = new Uint8Array(pemToDer('-----BEGIN PRIVATE KEY-----\nAAEC\nAw==\n-----END PRIVATE KEY-----'));
    expect([...der]).toEqual([0, 1, 2, 3]);
  });
});
