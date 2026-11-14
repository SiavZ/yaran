/**
 * Remembered handoff consent on the control plane (D24, 02 §8.1): the device-signature
 * verdict, the consent-cookie read, the revoked-key lookup and the cookie issue.
 *
 * The skip decision itself is @yaran/protocol's `decideRemembered`; this module only
 * gathers its inputs from the request, D1 and 04's `macKey("handoff_consent")`.
 *
 * - The signed host is the recorded control-plane host, never a query or Host value.
 * - A cookie that fails any rule is ignored, never an error and never cleared.
 * - Rule 5 looks across every user: any revoked device row carrying this key's
 *   fingerprint ends the skip, whoever it belonged to.
 *
 * <module-headers:begin>
 * Uses:
 * src/sessions/handoff-remembered.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/seams/foundation.ts
 * └── src/sessions/handoff-params.ts
 * External: none
 *
 * Used by:
 * src/sessions/handoff-remembered.ts
 * ├── src/sessions/handoff-route.ts
 * └── test/sessions/handoff-remembered.test.ts
 * <module-headers:end>
 */
import {
  buildConsentCookie,
  CONSENT_COOKIE_NAME,
  CONSENT_PATHS,
  consentSetCookie,
  decideRemembered,
  deviceKeyFingerprint,
  deviceKeyFp24,
  verifyHandoffDeviceSig,
} from "@yaran/protocol";
import type { FoundationCtx } from "../seams/foundation.ts";
import type { HandoffGet } from "./handoff-params.ts";

/** One cookie's raw value from a Cookie header, or null. */
export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Whether `dsig` verifies over the canonical string; a mismatch is a verdict, not an error. */
export function deviceSignatureVerified(host: string, q: HandoffGet): Promise<boolean> {
  return verifyHandoffDeviceSig({ host, pk: q.pk, state: q.state, dts: q.dts, dk: q.dk, dsig: q.dsig });
}

/** Rule 5: a revoked device row carries this device key's fingerprint. */
export async function deviceKeyRevoked(ctx: FoundationCtx, dk: string): Promise<boolean> {
  const row = await ctx.db
    .prepare("SELECT 1 AS hit FROM devices WHERE device_key_fingerprint = ? AND revoked_at IS NOT NULL LIMIT 1")
    .bind(await deviceKeyFingerprint(dk))
    .first<{ hit: number }>();
  return row !== null;
}

/** True when the consent page may be skipped. The caller has already refused a stale `dts`. */
export async function rememberedConsent(ctx: FoundationCtx, req: Request, host: string, q: HandoffGet, verified: boolean): Promise<boolean> {
  const cookie = readCookie(req.headers.get("Cookie"), CONSENT_COOKIE_NAME);
  if (cookie === null || !verified) return false;
  const { kv, key } = await ctx.dataKey.macKey("handoff_consent");
  const decision = await decideRemembered({
    side: "worker",
    cookie,
    host,
    dkFp24: await deviceKeyFp24(q.dk),
    verified,
    dtsFresh: true,
    deviceRevoked: await deviceKeyRevoked(ctx, q.dk),
    key,
    currentKv: kv,
    now: ctx.now(),
  });
  return decision === "skip";
}

/** The `Set-Cookie` an explicit, verified Continue carries (fp24 is the 29-char form undashed). */
export async function consentCookieHeader(ctx: FoundationCtx, host: string, dkFingerprint: string): Promise<string> {
  const { kv, key } = await ctx.dataKey.macKey("handoff_consent");
  const value = await buildConsentCookie({ key, kv, host, fp24: dkFingerprint.replace(/-/g, ""), iat: ctx.now() });
  return consentSetCookie(value, CONSENT_PATHS.control_plane);
}
