/**
 * Google OAuth for the G5 fallback: a service-account RS256 JWT exchanged for an access
 * token with the firebase.messaging scope, cached until 300 s before it expires.
 *
 * - The service account JSON (`client_email`, `private_key` PKCS#8 PEM, `token_uri`) is a
 *   relay secret; neither it nor the access token is ever logged.
 * - Concurrent callers share one in-flight exchange.
 *
 * <module-headers:begin>
 * Uses:
 * src/fcm/oauth.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/apns/jwt.ts
 * External: none
 *
 * Used by:
 * src/fcm/oauth.ts
 * ├── src/core/deps.ts
 * ├── src/fcm/client.ts
 * └── test/fcm.test.ts
 * <module-headers:end>
 */
import { b64urlEncode, utf8 } from "@yaran/protocol";
import { pemToDer } from "../apns/jwt.ts";

export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const REFRESH_EARLY_S = 300;
const ASSERTION_LIFETIME_S = 3600;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

function parseServiceAccount(json: string): ServiceAccount {
  let v: Partial<ServiceAccount>;
  try {
    v = JSON.parse(json);
  } catch {
    v = {};
  }
  if (typeof v.client_email !== "string" || typeof v.private_key !== "string") {
    throw new Error("relay secret FCM_SERVICE_ACCOUNT is not a Google service account key");
  }
  const tokenUri = v.token_uri ?? DEFAULT_TOKEN_URI;
  if (!tokenUri.startsWith("https://")) throw new Error("relay secret FCM_SERVICE_ACCOUNT has a non-https token_uri");
  return { client_email: v.client_email, private_key: v.private_key, token_uri: tokenUri };
}

export class FcmTokenSource {
  private readonly sa: ServiceAccount;
  private cached: { token: string; refreshAt: number } | null = null;
  private inflight: Promise<string> | null = null;
  private readonly fetchFn: typeof fetch;

  constructor(serviceAccountJson: string, fetchFn: typeof fetch = fetch) {
    this.sa = parseServiceAccount(serviceAccountJson);
    this.fetchFn = fetchFn;
  }

  async token(now: number): Promise<string> {
    if (this.cached && now < this.cached.refreshAt) return this.cached.token;
    this.inflight ??= this.exchange(now).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Forgets the cached token (after a 401 from FCM). */
  invalidate(): void {
    this.cached = null;
  }

  private async exchange(now: number): Promise<string> {
    const key = await crypto.subtle.importKey("pkcs8", pemToDer(this.sa.private_key) as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const enc = (v: unknown) => b64urlEncode(utf8.encode(JSON.stringify(v)));
    const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iss: this.sa.client_email, scope: FCM_SCOPE, aud: this.sa.token_uri, iat: now, exp: now + ASSERTION_LIFETIME_S })}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8.encode(input) as BufferSource);
    const res = await this.fetchFn(this.sa.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${input}.${b64urlEncode(new Uint8Array(sig))}` }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
    if (!res.ok || typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
      throw new Error(`the Google token exchange answered ${res.status}`);
    }
    this.cached = { token: body.access_token, refreshAt: now + body.expires_in - REFRESH_EARLY_S };
    return body.access_token;
  }
}
