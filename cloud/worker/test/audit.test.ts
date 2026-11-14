/**
 * Audit log: row shape, detail cap and scrubbing, coalesced denials, retention purge, the
 * generated action catalogue and the W25 `AuditEntry` mapping.
 *
 * <module-headers:begin>
 * Uses:
 * test/audit.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── cloud/protocol/registry/audit-actions.json
 * ├── src/audit/actions.ts
 * ├── src/audit/audit.ts
 * ├── src/db/client.ts
 * ├── src/http/context.ts
 * ├── test/helpers/app.ts
 * └── test/helpers/seed.ts
 * External: cloudflare:test, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { validate } from "@yaran/protocol";
import registry from "@yaran/protocol/registry/audit-actions.json";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, type AuditAction } from "../src/audit/actions.ts";
import { auditStatement, purgeAudit, record, toAuditEntry, type AuditRow } from "../src/audit/audit.ts";
import { all } from "../src/db/client.ts";
import type { Actor } from "../src/http/context.ts";
import { appCtx } from "./helpers/app.ts";
import { NOW } from "./helpers/seed.ts";

const as = (actor: Actor, now = NOW) => ({ ...appCtx({}, now), actor: () => actor });
const rows = (action: string) => all<AuditRow>(env.DB, "SELECT * FROM audit_log WHERE action = ? ORDER BY at", action);

/** Every action Phase 04 records. */
const PHASE_04_ACTIONS = ["access.denied"] as const satisfies readonly AuditAction[];

describe("record", () => {
  it("writes the row with actor, target, request facts and scrubbed detail", async () => {
    await record(as({ kind: "admin", id: "u-1", email: "a@example.com" }), {
      action: "settings.updated", outcome: "ok", target: { kind: "settings" },
      detail: { changed: ["org_name"], token: "secret-token", note: "\u001b[2Jhi" },
    });
    const [row] = await rows("settings.updated");
    expect(row).toMatchObject({ actor_kind: "admin", actor_id: "u-1", target_kind: "settings", outcome: "ok", error_code: null, request_id: "test", ip: "198.51.100.7", country: "SE" });
    expect(JSON.parse(row!.detail!)).toEqual({ changed: ["org_name"], token: "[redacted]", note: "\\x1b[2Jhi" });
  });
  it("caps detail at 2 KiB", async () => {
    await record(as({ kind: "system" }), { action: "orphan.found", outcome: "ok", detail: { big: "x".repeat(4000) } });
    expect(JSON.parse((await rows("orphan.found"))[0]!.detail!)).toEqual({ truncated: true });
  });
  it("coalesces denials to one row per actor, action and minute", async () => {
    const actor: Actor = { kind: "user", id: "u-9", email: "x@example.com" };
    for (let i = 0; i < 3; i++) await record(as(actor, NOW + i), { action: "access.denied", outcome: "denied", errorCode: "forbidden" });
    await record(as({ kind: "user", id: "u-10", email: "y@example.com" }), { action: "access.denied", outcome: "denied", errorCode: "forbidden" });
    await record(as(actor, NOW + 120), { action: "access.denied", outcome: "denied", errorCode: "forbidden" });
    const denied = await rows("access.denied");
    expect(denied).toHaveLength(3);
    expect(denied.every((r) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.id))).toBe(true);
  });
  it("batches with the change it records", async () => {
    const ctx = as({ kind: "setup" });
    await env.DB.batch([env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('setup_state', '\"closed\"', 1)"), await auditStatement(ctx, { action: "setup.completed", outcome: "ok" })]);
    expect(await rows("setup.completed")).toHaveLength(1);
    await env.DB.prepare("DELETE FROM settings WHERE key = 'setup_state'").run();
  });
});

describe("retention", () => {
  it("purges only rows older than the window", async () => {
    await record(as({ kind: "system" }, NOW - 400 * 86_400), { action: "drift.repaired", outcome: "ok" });
    await record(as({ kind: "system" }, NOW - 10 * 86_400), { action: "drift.repaired", outcome: "ok" });
    expect(await purgeAudit(env.DB, NOW, 365, 100)).toBe(1);
    expect(await rows("drift.repaired")).toHaveLength(1);
  });
});

describe("catalogue and wire mapping", () => {
  it("is generated from registry/audit-actions.json and holds every action this phase records", () => {
    expect(AUDIT_ACTIONS).toEqual(registry.actions);
    for (const a of PHASE_04_ACTIONS) expect(AUDIT_ACTIONS).toContain(a);
  });
  it("maps rows to W25 AuditEntry", async () => {
    const base: AuditRow = { id: crypto.randomUUID(), at: NOW, actor_kind: "admin", actor_id: "u-1", action: "user.disabled", target_kind: "user", target_id: "u-2", outcome: "ok", error_code: null, request_id: "r", ip: "1.2.3.4", country: "SE", detail: null };
    const ok = toAuditEntry(base, "a@example.com");
    expect(ok).toEqual({ id: base.id, ts: "2024-11-14T08:00:00Z", actor: { kind: "user", id: "u-1", email: "a@example.com" }, action: "user.disabled", target: { kind: "user", id: "u-2" }, result: "ok", country: "SE" });
    expect(validate("AuditEntry", ok).valid).toBe(true);
    for (const [actor_kind, kind] of [["user", "user"], ["machine", "machine"], ["system", "system"], ["setup", "system"]] as const) {
      expect(toAuditEntry({ ...base, actor_kind }).actor.kind).toBe(kind);
    }
    for (const outcome of ["denied", "failed"] as const) {
      const e = toAuditEntry({ ...base, outcome, error_code: "forbidden", country: null, target_kind: null, target_id: null });
      expect(e).toMatchObject({ result: "error", error_code: "forbidden", target: { kind: "org" } });
      expect(e).not.toHaveProperty("country");
      expect(validate("AuditEntry", e).valid).toBe(true);
    }
    expect(JSON.stringify(toAuditEntry(base))).not.toContain("1.2.3.4");
  });
});
