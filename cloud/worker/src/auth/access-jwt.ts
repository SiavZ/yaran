/**
 * Cloudflare Access JWT verification for the control plane (D3 applied to the Worker).
 *
 * Reads ONLY the `Cf-Access-Jwt-Assertion` header Access adds, never the cookie. RS256 is
 * pinned; `iss` must be exactly `https://<team domain>`, `aud` must contain the
 * control-plane app's AUD, and `exp`/`nbf` are enforced with a configurable tolerance.
 * Then it requires an app token for a person: `type` is `app`, `email` and `sub` are set,
 * and a service-token JWT (it carries `common_name`) is refused.
 *
 * - Fails closed: an unreachable or broken JWKS is `503 identity_unavailable`, never a pass.
 * - The JWKS cache is module scope, so jose's cache survives across requests in an isolate.
 * - The team domain must match the cloudflared rule, so a poisoned setting cannot point the
 *   JWKS fetch at another host.
 *
 * <module-headers:begin>
 * Uses:
 * src/auth/access-jwt.ts
 * ├── src/db/settings.ts
 * ├── src/http/context.ts
 * └── src/http/responses.ts
 * External: jose
 *
 * Used by:
 * src/auth/access-jwt.ts
 * ├── src/auth/authorize.ts
 * └── test/access-jwt.test.ts
 * <module-headers:end>
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { TEAM_DOMAIN_RE } from "../db/settings.ts";
import type { AccessClaims } from "../http/context.ts";
import { HttpError } from "../http/responses.ts";

export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Test hook: forget every cached JWKS (jose's cooldown would otherwise span tests). */
export function resetJwksCache(): void {
  jwksByTeam.clear();
}

function jwksFor(team: string) {
  let jwks = jwksByTeam.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    jwksByTeam.set(team, jwks);
  }
  return jwks;
}

export interface AccessConfig {
  teamDomain: string | null;
  aud: string | null;
  clockToleranceS: number;
  /** Unix seconds the claims are checked against. */
  now: number;
}

/** The jose error codes that mean the key set could not be obtained, not that the token is bad. */
const UNAVAILABLE = new Set(["ERR_JOSE_GENERIC", "ERR_JWKS_TIMEOUT", "ERR_JWKS_INVALID"]);

/** Verifies the request's Access JWT and returns the claims this Worker relies on. */
export async function verifyAccessJwt(request: Request, cfg: AccessConfig): Promise<AccessClaims> {
  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (!token) throw new HttpError("unauthenticated", "No Cloudflare Access identity reached the Worker; the control-plane Access application must cover this route.");
  if (!cfg.teamDomain || !TEAM_DOMAIN_RE.test(cfg.teamDomain) || !cfg.aud) {
    throw new HttpError("identity_unavailable", "The Access team domain or application AUD is not configured, so no identity can be verified.");
  }
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwksFor(cfg.teamDomain), {
      algorithms: ["RS256"],
      issuer: `https://${cfg.teamDomain}`,
      audience: cfg.aud,
      clockTolerance: cfg.clockToleranceS,
      currentDate: new Date(cfg.now * 1000),
      requiredClaims: ["exp", "nbf"],
    }));
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code !== "string" || !code.startsWith("ERR_") || UNAVAILABLE.has(code)) {
      throw new HttpError("identity_unavailable", "The Access signing keys could not be fetched; try again shortly.");
    }
    throw new HttpError("unauthenticated", "The Cloudflare Access token is not valid for this application.");
  }
  if (payload.common_name !== undefined) {
    throw new HttpError("service_token_rejected", "Service tokens cannot use the control plane; sign in as a person.");
  }
  if (payload.type !== "app") throw new HttpError("unauthenticated", "The Access token is not an application token.");
  if (typeof payload.email !== "string" || payload.email.trim() === "") {
    throw new HttpError("unauthenticated", "The Access token carries no email address.");
  }
  if (typeof payload.sub !== "string" || payload.sub === "") throw new HttpError("unauthenticated", "The Access token carries no subject.");
  return { email: payload.email, sub: payload.sub, exp: payload.exp! };
}
