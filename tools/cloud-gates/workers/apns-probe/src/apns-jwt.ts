/**
 * APNs provider JWT: turns a .p8 PKCS#8 PEM into an ES256 token with WebCrypto.
 *
 * APNs token authentication wants a JWT signed with the team's P-256 key, header
 * `{alg:"ES256",kid}` and claims `{iss:<team id>, iat}`. Workers have no Node crypto, so the
 * signing goes through crypto.subtle, which is also present in Node 22 for the tests.
 *
 * - WebCrypto ECDSA already returns the raw 64-byte r||s form JWS wants; it is not DER, so
 *   it is base64url-encoded as is.
 * - The key is imported non-extractable and only for signing.
 * - Pure: no logging, no network; the caller decides what to do with the token.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/apns-jwt.ts
 * ├── src/index.ts
 * └── test/apns-jwt.test.ts
 * <module-headers:end>
 */

/** Strips the PEM armour and whitespace and decodes the base64 body. */
export function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function base64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Signs the APNs provider token. `iat` is seconds since the epoch. */
export async function signProviderJwt(
  p8Pem: string,
  kid: string,
  team: string,
  iat: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(p8Pem), { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ]);
  const signingInput = `${base64url(JSON.stringify({ alg: 'ES256', kid }))}.${base64url(JSON.stringify({ iss: team, iat }))}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}
