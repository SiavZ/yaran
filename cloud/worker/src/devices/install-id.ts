/**
 * The `Yaran-Install-Id` check every authenticated user call passes through (02 §2, D22):
 * a revoked install gets `403 device_revoked`, a live one has its `last_seen_at` stamped
 * at most hourly.
 *
 * - Every Phase 06 `user` or `admin` route runs it after 04 verified the Access JWT
 *   (`routes/phase06-context.ts`).
 * - A header naming no device of this user is ignored: the app sends it only once
 *   registered, and an unknown id must not let anyone probe other users' devices (T34).
 *
 * <module-headers:begin>
 * Uses:
 * src/devices/install-id.ts
 * ├── src/http/responses.ts
 * └── src/routes/call.ts
 * External: none
 *
 * Used by:
 * src/devices/install-id.ts
 * └── src/routes/phase06-context.ts
 * <module-headers:end>
 */
import type { FoundationCtx, UserIdentity } from "../routes/call.ts";
import { HttpError } from "../http/responses.ts";

export const LAST_SEEN_THROTTLE_S = 3600;
const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function checkInstallId(ctx: FoundationCtx, user: UserIdentity, installId: string | null): Promise<void> {
  if (installId === null || !INSTALL_ID_RE.test(installId)) return;
  const row = await ctx.db
    .prepare("SELECT id, revoked_at FROM devices WHERE user_id = ? AND install_id = ?")
    .bind(user.userId, installId)
    .first<{ id: string; revoked_at: number | null }>();
  if (!row) return;
  if (row.revoked_at !== null) throw new HttpError("device_revoked", "This phone was removed from the org. Sign in again to add it back.");
  const now = ctx.now();
  await ctx.db
    .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)")
    .bind(now, row.id, now - LAST_SEEN_THROTTLE_S)
    .run();
}
