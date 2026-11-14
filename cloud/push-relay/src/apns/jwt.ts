/**
 * The APNs provider token: an ES256 JWT `{alg, kid}.{iss: team id, iat}` signed with the
 * publisher's .p8 key.
 *
 * `iat` is the start of the current 30-minute bucket, so every isolate signs the same claims
 * and a token is never older than 30 minutes (Apple: refresh no more than every 20 and no
 * less than every 60 minutes). Whether concurrent isolates with distinct signatures trip
 * TooManyProviderTokenUpdates is UNVERIFIED (gate G4); the fallback is a single Durable
 * Object handing out the token.
 *
 * <module-headers:begin>
 * Uses:
 * src/apns/jwt.ts
 * └── @yaran/protocol:src/index.ts
 * External: none
 *
 * Used by:
 * src/apns/jwt.ts
 * ├── src/apns/client.ts
 * ├── src/core/deps.ts
 * └── src/fcm/oauth.ts
 * <module-headers:end>
 */
import { b64urlEncode, utf8 } from "@yaran/protocol";

export const TOKEN_BUCKET_S = 30 * 60;

/** DER bytes of a PEM block (header, footer and whitespace stripped). */
export function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

export class ProviderTokenCache {
  private key: Promise<CryptoKey> | null = null;
  /** Per bucket; concurrent requests share one signing, so one isolate presents one token. */
  private cached: { iat: number; token: Promise<string> } | null = null;
  private readonly cfg: { teamId: string; keyId: string; p8: string };

  constructor(cfg: { teamId: string; keyId: string; p8: string }) {
    this.cfg = cfg;
  }

  /** The bucket start for a Unix time. */
  static bucket(now: number): number {
    return now - (now % TOKEN_BUCKET_S);
  }

  token(now: number): Promise<string> {
    const iat = ProviderTokenCache.bucket(now);
    if (this.cached?.iat === iat) return this.cached.token;
    const token = this.sign(iat);
    this.cached = { iat, token };
    token.catch(() => {
      if (this.cached?.token === token) this.cached = null;
      this.key = null;
    });
    return token;
  }

  private async sign(iat: number): Promise<string> {
    this.key ??= crypto.subtle.importKey("pkcs8", pemToDer(this.cfg.p8) as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const enc = (v: unknown) => b64urlEncode(utf8.encode(JSON.stringify(v)));
    const input = `${enc({ alg: "ES256", kid: this.cfg.keyId })}.${enc({ iss: this.cfg.teamId, iat })}`;
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await this.key, utf8.encode(input) as BufferSource);
    return `${input}.${b64urlEncode(new Uint8Array(sig))}`;
  }
}
