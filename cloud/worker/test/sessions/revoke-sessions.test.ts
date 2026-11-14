/**
 * Session revocation through Access revoke_user.
 *
 * The recorded request shape and the dashboard-path fallback when Cloudflare refuses.
 *
 * <module-headers:begin>
 * Uses:
 * test/sessions/revoke-sessions.test.ts
 * ├── src/seams/foundation.ts
 * ├── src/sessions/revoke-sessions.ts
 * └── test/phase06/fakes.ts
 * External: vitest
 *
 * Used by: entry point (vitest in the Workers pool, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/seams/foundation.ts";
import { DASHBOARD_FALLBACK, revokeSessions } from "../../src/sessions/revoke-sessions.ts";
import { makeWorld } from "../phase06/fakes.ts";

const actor = { kind: "user" as const, id: "u1" };

describe("revokeSessions", () => {
  it("calls revoke_user with the email and audits sessions.revoked", async () => {
    const w = await makeWorld();
    await revokeSessions(w.ctx, { email: "ada@example.org", userId: "u1", actor });
    expect(w.cfCalls).toEqual([{ method: "POST", path: "/accounts/acc123/access/organizations/revoke_user", body: { email: "ada@example.org" }, priority: "interactive" }]);
    expect(w.audit).toEqual([{ action: "sessions.revoked", actor, target: { kind: "user", id: "u1" }, outcome: "ok" }]);
  });

  it("names the dashboard path when Cloudflare refuses, and audits nothing", async () => {
    const w = await makeWorld();
    w.cfFail.next = true;
    const err = await revokeSessions(w.ctx, { email: "ada@example.org", userId: "u1", actor }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("cloudflare_permission_denied");
    expect((err as ApiError).message).toContain(DASHBOARD_FALLBACK);
    expect((err as ApiError).message).toContain("Zero Trust → Users → the person → Revoke sessions");
    expect(w.audit).toEqual([]);
  });
});
