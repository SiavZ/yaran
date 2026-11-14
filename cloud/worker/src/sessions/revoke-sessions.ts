/**
 * "Sign out everywhere": revokes every Access session of a user and audits it, or fails
 * with a refusal that names the dashboard path the person can use instead.
 *
 * Used by W14's `?sign_out_everywhere=1` and by Phase 07's disable-and-revoke. Access has
 * no per-device session revocation, so this ends every session of that email (T45).
 *
 * <module-headers:begin>
 * Uses:
 * src/sessions/revoke-sessions.ts
 * ├── src/cloudflare/access-sessions.ts
 * ├── src/seams/context.ts
 * └── src/seams/foundation.ts
 * External: none
 *
 * Used by:
 * src/sessions/revoke-sessions.ts
 * ├── src/me/devices-route.ts
 * └── test/sessions/revoke-sessions.test.ts
 * <module-headers:end>
 */
import { revokeUserSessions } from "../cloudflare/access-sessions.ts";
import type { Phase06Ctx } from "../seams/context.ts";
import { ApiError, type AuditRecord } from "../seams/foundation.ts";

export const DASHBOARD_FALLBACK = "Revoke them in the Cloudflare dashboard instead: Zero Trust → Users → the person → Revoke sessions.";

export async function revokeSessions(ctx: Phase06Ctx, o: { email: string; userId: string; actor: AuditRecord["actor"] }): Promise<void> {
  try {
    await revokeUserSessions(ctx, o.email);
  } catch (e) {
    const code = e instanceof ApiError ? e.code : "cloudflare_api_failed";
    throw new ApiError(code, `The phone was removed, but its Access sessions could not be revoked. ${DASHBOARD_FALLBACK}`, { fallback: "dashboard" });
  }
  await ctx.audit.record({ action: "sessions.revoked", actor: o.actor, target: { kind: "user", id: o.userId }, outcome: "ok" });
}
