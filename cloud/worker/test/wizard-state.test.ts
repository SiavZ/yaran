/**
 * The setup reducer: every state × event, the forward path, and `closed` as a terminal state.
 *
 * <module-headers:begin>
 * Uses:
 * test/wizard-state.test.ts
 * └── src/setup/wizard-state.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { describe, expect, test } from "vitest";
import { INITIAL_SETUP, reduce, SETUP_STEPS, setupPhase, type SetupEvent, type SetupRecord, type SetupStep } from "../src/setup/wizard-state.ts";

const EVENTS: SetupEvent[] = [
  { kind: "code_ok" },
  { kind: "probe_ok", account_id: "acc1", admin_email: "Ada@Example.org", script_name: "yaran-cloud" },
  { kind: "team_domain", team_domain: "team.cloudflareaccess.com" },
  { kind: "hostname_chosen", zone_id: "z1", zone_name: "example.org", cp_label: "cp" },
  { kind: "access_ready", policy_id: "p", access_app_id: "a", access_aud: "aud", public_paths_mode: "overrides", bypass_app_ids: [] },
  { kind: "domain_attached", domain_mode: "api" },
  { kind: "idp_ready", idp_ids: ["i"] },
  { kind: "keys_ready", vapid_public_key: "BPub" },
  { kind: "admin_claimed", closed_at: "2026-11-14T12:00:00Z", workers_dev_disabled: true },
];

/** The one event each step accepts, in order. */
const ACCEPTS: Record<SetupStep, SetupEvent["kind"] | null> = {
  locked: "code_ok",
  token: "probe_ok",
  org: "team_domain",
  zone: "hostname_chosen",
  access: "access_ready",
  domain: "domain_attached",
  idp: "idp_ready",
  keys: "keys_ready",
  claim: "admin_claimed",
  closed: null,
};

describe("wizard reducer", () => {
  test.each(SETUP_STEPS.flatMap((step) => EVENTS.map((event) => [step, event] as const)))("%s × %o", (step, event) => {
    const t = reduce({ step } as SetupRecord, event);
    expect(t.ok).toBe(ACCEPTS[step] === event.kind);
    if (t.ok) expect(SETUP_STEPS.indexOf(t.record.step)).toBe(SETUP_STEPS.indexOf(step) + 1);
  });

  test("the forward path records every fact and ends closed", () => {
    let r = INITIAL_SETUP;
    for (const e of EVENTS) {
      const t = reduce(r, e);
      expect(t.ok).toBe(true);
      if (t.ok) r = t.record;
    }
    expect(r).toMatchObject({ step: "closed", admin_email: "ada@example.org", cp_host: "cp.example.org", access_aud: "aud", workers_dev_disabled: true });
    expect(setupPhase(r)).toBe("closed");
  });

  test("closed is terminal: no event moves out of it", () => {
    for (const e of EVENTS) expect(reduce({ step: "closed" }, e)).toEqual({ ok: false, reason: "setup is closed for good" });
  });

  test("the idp step needs at least one usable provider", () => {
    expect(reduce({ step: "idp" }, { kind: "idp_ready", idp_ids: [] }).ok).toBe(false);
  });
});
