/**
 * Access JWT test kit: an RS256 key pair, the JWKS served by msw at the team's certs URL,
 * and token minting for every shape the verifier must refuse.
 *
 * <module-headers:begin>
 * Uses:
 * test/helpers/access.ts
 * ├── test/helpers/seed.ts
 * └── test/setup.ts
 * External: jose, msw
 *
 * Used by:
 * test/helpers/access.ts
 * ├── test/access-jwt.test.ts
 * ├── test/body.test.ts
 * ├── test/helpers/deps.ts
 * ├── test/helpers/matrix.ts
 * ├── test/identity.test.ts
 * ├── test/phase06/fakes.ts
 * └── test/phase06/harness.ts
 * <module-headers:end>
 */
import { exportJWK, SignJWT, type JWK } from "jose";
import { http, HttpResponse } from "msw";
import { network } from "../setup.ts";
import { AUD, NOW, TEAM } from "./seed.ts";

const pair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"],
)) as CryptoKeyPair;
export const KID = "test-kid-1";
const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };

/** Serves the JWKS for `team` and counts fetches. */
export function serveJwks(team = TEAM, keys: JWK[] = [publicJwk]): { fetches: number } {
  const counter = { fetches: 0 };
  network.use(http.get(`https://${team}/cdn-cgi/access/certs`, () => {
    counter.fetches++;
    return HttpResponse.json({ keys });
  }));
  return counter;
}

export interface MintOptions {
  email?: string | null;
  sub?: string;
  aud?: string;
  iss?: string;
  exp?: number;
  nbf?: number;
  kid?: string;
  type?: string;
  extra?: Record<string, unknown>;
}

/** An Access-shaped JWT; defaults are a valid user token at NOW. */
export async function mintJwt(o: MintOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = { type: o.type ?? "app", ...o.extra };
  if (o.email !== null) claims.email = o.email ?? "user@example.com";
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: o.kid ?? KID })
    .setIssuer(o.iss ?? `https://${TEAM}`)
    .setAudience(o.aud ?? AUD)
    .setSubject(o.sub ?? "access-sub-1")
    .setIssuedAt(NOW)
    .setNotBefore(o.nbf ?? NOW - 10)
    .setExpirationTime(o.exp ?? NOW + 3600)
    .sign(pair.privateKey);
}

/** A service-token JWT: empty sub, common_name, no email. */
export const mintServiceToken = () => mintJwt({ email: null, sub: "", extra: { common_name: "abc.access" } });

/** An unsigned (`alg: none`) or HS256 token with otherwise valid claims. */
export function forgedJwt(alg: "none" | "HS256"): string {
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const body = { type: "app", email: "user@example.com", sub: "x", aud: [AUD], iss: `https://${TEAM}`, exp: NOW + 3600, nbf: NOW - 10 };
  return `${enc({ alg, kid: KID })}.${enc(body)}.${alg === "none" ? "" : "c2ln"}`;
}
