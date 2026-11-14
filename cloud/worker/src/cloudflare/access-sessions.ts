/**
 * Cloudflare Access endpoint module: revoke every Access session of one user, over 05's
 * Cloudflare client (budget, retries, envelope parsing).
 *
 * UNVERIFIED: the request shape `POST /accounts/{account_id}/access/organizations/revoke_user`
 * with body `{email}` comes from the API reference and is not yet proven by a live call
 * (Phase 06 work item 9); until it is, callers fall back to naming the dashboard path.
 *
 * - Interactive priority: a person is waiting on the answer.
 *
 * <module-headers:begin>
 * Uses:
 * src/cloudflare/access-sessions.ts
 * ├── src/http/responses.ts
 * └── src/routes/call.ts
 * External: none
 *
 * Used by:
 * src/cloudflare/access-sessions.ts
 * └── src/sessions/revoke-sessions.ts
 * <module-headers:end>
 */
import type { Phase06Ctx } from "../routes/call.ts";
import { HttpError } from "../http/responses.ts";

export async function revokeUserSessions(ctx: Phase06Ctx, email: string): Promise<void> {
  const { accountId } = await ctx.settings.internal();
  if (!accountId) throw new HttpError("unavailable", "The Cloudflare account is not recorded yet; finish setup first.");
  await ctx.cloudflare.call({ method: "POST", path: `/accounts/${accountId}/access/organizations/revoke_user`, body: { email } });
}
