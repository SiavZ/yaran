/**
 * The handoff consent page's csrf token: minted by W16, consumed once by W16b.
 *
 * The token (128 random bits) is stored only as a SHA-256 hash, bound to the request's
 * `state`, `pk` and `dk` and to the signed-in user, together with the GET's device
 * signature verdict (D24), so the POST inherits that verdict rather than re-deciding it.
 *
 * - Lives 10 minutes; consumed by one conditional `UPDATE`, so a replayed form loses.
 * - A token bound to another state, pk, dk or user is refused and left unconsumed.
 *
 * <module-headers:begin>
 * Uses:
 * src/sessions/handoff-csrf.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/pairing/pkce.ts
 * └── src/routes/call.ts
 * External: none
 *
 * Used by:
 * src/sessions/handoff-csrf.ts
 * └── src/sessions/handoff-route.ts
 * <module-headers:end>
 */
import { decodeP256Point, deviceKeyFingerprint, jwkThumbprint, pointToJwk, timingSafeEqual } from "@yaran/protocol";
import { randomToken, sha256Text } from "../pairing/pkce.ts";
import type { FoundationCtx } from "../routes/call.ts";

export const HANDOFF_CSRF_TTL_S = 600;

export interface CsrfBinding {
  userId: string;
  state: string;
  pk: string;
  dk: string;
}

/** RFC 7638 thumbprint of a validated P256Point (43 chars). */
export function pkThumbprint(pk: string): Promise<string> {
  return jwkThumbprint(pointToJwk(decodeP256Point(pk)!));
}

export async function mintHandoffCsrf(ctx: FoundationCtx, b: CsrfBinding, verified: boolean): Promise<string> {
  const token = randomToken(16);
  await ctx.db
    .prepare(
      `INSERT INTO handoff_csrf (token_hash, state_hash, pk_thumbprint, dk_fingerprint, verified, user_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(await sha256Text(token), await sha256Text(b.state), await pkThumbprint(b.pk), await deviceKeyFingerprint(b.dk), verified ? 1 : 0, b.userId, ctx.now() + HANDOFF_CSRF_TTL_S)
    .run();
  return token;
}

export type CsrfOutcome = { ok: true; verified: boolean; dkFingerprint: string } | { ok: false };

/** Checks the binding and consumes the token; `ok: false` maps to `handoff_request_invalid`. */
export async function consumeHandoffCsrf(ctx: FoundationCtx, token: string, b: CsrfBinding): Promise<CsrfOutcome> {
  const hash = await sha256Text(token);
  const now = ctx.now();
  const row = await ctx.db
    .prepare("SELECT state_hash, pk_thumbprint, dk_fingerprint, verified, user_id FROM handoff_csrf WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?")
    .bind(hash, now)
    .first<{ state_hash: ArrayBuffer; pk_thumbprint: string; dk_fingerprint: string; verified: number; user_id: string }>();
  if (!row) return { ok: false };
  const bound =
    row.user_id === b.userId &&
    timingSafeEqual(new Uint8Array(row.state_hash), await sha256Text(b.state)) &&
    row.pk_thumbprint === (await pkThumbprint(b.pk)) &&
    row.dk_fingerprint === (await deviceKeyFingerprint(b.dk));
  if (!bound) return { ok: false };
  const used = await ctx.db.prepare("UPDATE handoff_csrf SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?").bind(now, hash, now).run();
  return used.meta.changes === 1 ? { ok: true, verified: row.verified === 1, dkFingerprint: row.dk_fingerprint } : { ok: false };
}
