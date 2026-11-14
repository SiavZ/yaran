/**
 * Wizard steps against the fake Cloudflare: probe, Access body and fallback, idempotence,
 * publishing order, domain fallback, IdPs, VAPID keys and the admin claim.
 *
 * <module-headers:begin>
 * Uses:
 * test/setup-steps.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/admin/settings-store.ts
 * ├── src/setup/capability-probe.ts
 * ├── src/setup/steps/access.ts
 * ├── src/setup/steps/claim.ts
 * ├── src/setup/steps/domain.ts
 * ├── src/setup/steps/idp.ts
 * ├── src/setup/steps/keys.ts
 * ├── src/setup/steps/org.ts
 * ├── src/setup/steps/zone.ts
 * ├── src/setup/wizard-state.ts
 * ├── test/helpers/deps.ts
 * └── test/helpers/fake-cf.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, test } from "vitest";
import { b64urlDecode } from "@yaran/protocol";
import { readKey } from "../src/admin/settings-store.ts";
import { probeCapabilities } from "../src/setup/capability-probe.ts";
import { controlPlaneAppBody, ensureAccess, everyoneRefused, policyInclude } from "../src/setup/steps/access.ts";
import { issueClaim, redeemClaim } from "../src/setup/steps/claim.ts";
import { attachDomain, checkDomain } from "../src/setup/steps/domain.ts";
import { addIdp, finishIdp } from "../src/setup/steps/idp.ts";
import { ensureVapidKey, VAPID_AAD, VAPID_PRIVATE_KEY } from "../src/setup/steps/keys.ts";
import { createOrg, readOrg } from "../src/setup/steps/org.ts";
import { chooseHostname } from "../src/setup/steps/zone.ts";
import { reduce, type SetupRecord } from "../src/setup/wizard-state.ts";
import { world } from "./helpers/deps.ts";
import { FakeCloudflare } from "./helpers/fake-cf.ts";

const allow = { mode: "allowlist" as const, emails: ["Bob@example.org"], domains: ["example.com"], access_group_ids: ["grp-1"] };
const input = { accountId: "acc1", host: "cp.example.org", adminEmail: "ada@example.org", sessionDuration: "24h", pairingPolicy: allow };

test("a missing permission maps to its manifest row", async () => {
  const cf = new FakeCloudflare().fault("GET /accounts/acc1/cfd_tunnel", "auth").fault("GET /zones", "rate_limited");
  const rows = await probeCapabilities(cf.transport(), "acc1", "yaran-cloud");
  const by = Object.fromEntries(rows.map((r) => [r.permission.probe, r.outcome]));
  expect(by).toEqual({ tunnels: "missing", access_apps: "ok", access_org: "ok", worker_script: "ok", dns: "unchecked", zones: "unchecked" });
  expect(rows.find((r) => r.outcome === "missing")!.permission.name).toBe("Cloudflare Tunnel Edit");
});

describe("access", () => {
  test("pairing_policy → include mapping", () => {
    expect(policyInclude(allow, "Ada@example.org")).toEqual([
      { email: { email: "ada@example.org" } },
      { email: { email: "bob@example.org" } },
      { email_domain: { domain: "example.com" } },
      { group: { id: "grp-1" } },
    ]);
    expect(policyInclude({ ...allow, mode: "everyone" }, "ada@example.org")).toEqual([{ everyone: {} }]);
  });

  test("the app body has exactly the two overrides, HttpOnly, lax and no binding cookie", () => {
    expect(controlPlaneAppBody("cp.example.org", "24h", "pol-1", true)).toMatchInlineSnapshot(`
      {
        "app_launcher_visible": false,
        "destinations": [
          {
            "overrides": [
              {
                "behavior": "public",
                "path_pattern": "/v1/meta",
              },
              {
                "behavior": "public",
                "path_pattern": "/v1/machine/*",
              },
            ],
            "type": "public",
            "uri": "cp.example.org",
          },
        ],
        "domain": "cp.example.org",
        "enable_binding_cookie": false,
        "http_only_cookie_attribute": true,
        "name": "yaran control plane",
        "policies": [
          {
            "id": "pol-1",
            "precedence": 1,
          },
        ],
        "same_site_cookie_attribute": "lax",
        "session_duration": "24h",
        "type": "self_hosted",
      }
    `);
  });

  test("a re-run after a partial failure finds the app and policy by name instead of duplicating them", async () => {
    const cf = new FakeCloudflare();
    cf.fault("POST /accounts/acc1/access/apps", "transient");
    await expect(ensureAccess(cf.transport(), input)).rejects.toThrow();
    expect(cf.policies).toHaveLength(1);
    cf.faults.clear();
    const first = await ensureAccess(cf.transport(), input);
    const again = await ensureAccess(cf.transport(), input);
    expect(cf.apps).toHaveLength(1);
    expect(cf.policies).toHaveLength(1);
    expect(again).toEqual(first);
  });

  test("G8 fallback: rejected overrides become bypass path apps", async () => {
    const cf = new FakeCloudflare();
    cf.faults.set("overrides", "invalid");
    const ev = await ensureAccess(cf.transport(), input);
    expect(ev).toMatchObject({ kind: "access_ready", public_paths_mode: "bypass_apps" });
    expect(cf.apps.map((a) => a.domain).sort()).toEqual(["cp.example.org", "cp.example.org/v1/machine/", "cp.example.org/v1/meta"]);
    expect(cf.policies.find((p) => p.name === "yaran public paths")?.decision).toBe("bypass");
  });

  test("everyone is refused while One-time PIN is enabled", async () => {
    const cf = new FakeCloudflare();
    expect(await everyoneRefused(cf.transport(), "acc1", { ...allow, mode: "everyone" })).toBe(false);
    cf.idps.push({ id: "otp", name: "One-time PIN", type: "onetimepin" });
    expect(await everyoneRefused(cf.transport(), "acc1", { ...allow, mode: "everyone" })).toBe(true);
    expect(await everyoneRefused(cf.transport(), "acc1", allow)).toBe(false);
  });
});

test("the domain step runs only after the Access app exists (publishing order)", () => {
  expect(reduce({ step: "access" }, { kind: "domain_attached", domain_mode: "api" }).ok).toBe(false);
});

describe("domain", () => {
  const d = { accountId: "acc1", host: "cp.example.org", zoneId: "z1", script: "yaran-cloud" };
  test("attaches once, idempotently", async () => {
    const cf = new FakeCloudflare();
    expect((await attachDomain(cf.transport(), d)).ok).toBe(true);
    expect((await attachDomain(cf.transport(), d)).ok).toBe(true);
    expect(cf.domains).toHaveLength(1);
  });
  test("G14 fallback: a refused attach asks for the dashboard, and Check again finds it", async () => {
    const cf = new FakeCloudflare().fault("PUT /accounts/acc1/workers/domains", "auth");
    expect(await attachDomain(cf.transport(), d)).toEqual({ ok: false, problem: "dashboard_required" });
    expect(await checkDomain(cf.transport(), d)).toEqual({ ok: false, problem: "not_found_yet" });
    cf.domains.push({ id: "x", hostname: d.host, service: d.script, zone_id: "z1" });
    expect(await checkDomain(cf.transport(), d)).toEqual({ ok: true, event: { kind: "domain_attached", domain_mode: "dashboard" } });
  });
});

test("zone: hostname conflicts and label rules", async () => {
  const cf = new FakeCloudflare();
  expect(await chooseHostname(cf.transport(), "acc1", "z1", "c-p")).toEqual({ ok: false, problem: "invalid_label" });
  cf.dns.push({ zone: "z1", name: "cp.example.org" });
  expect(await chooseHostname(cf.transport(), "acc1", "z1", "cp")).toEqual({ ok: false, problem: "hostname_conflict" });
  expect((await chooseHostname(cf.transport(), "acc1", "z1", "yaran")).ok).toBe(true);
});

test("org: team domain, creation, and the onboarding fallback", async () => {
  const cf = new FakeCloudflare();
  expect(await readOrg(cf.transport(), "acc1")).toEqual({ ok: true, event: { kind: "team_domain", team_domain: "team.cloudflareaccess.com" } });
  cf.org = null;
  expect(await readOrg(cf.transport(), "acc1")).toEqual({ ok: false, problem: "no_org" });
  cf.fault("POST /accounts/acc1/access/organizations", "auth");
  expect(await createOrg(cf.transport(), "acc1", "acme", "Acme")).toEqual({ ok: false, problem: "onboarding_required" });
  cf.faults.clear();
  expect((await createOrg(cf.transport(), "acc1", "acme", "Acme")).ok).toBe(true);
});

test("idp: a Cloudflare-only org cannot finish; One-time PIN and GitHub are added once", async () => {
  const cf = new FakeCloudflare();
  expect(await finishIdp(cf.transport(), "acc1")).toEqual({ ok: false, problem: "no_usable_idp" });
  expect(await addIdp(cf.transport(), "acc1", "github")).toEqual({ ok: false, problem: "client_fields_required" });
  await addIdp(cf.transport(), "acc1", "onetimepin");
  await addIdp(cf.transport(), "acc1", "onetimepin");
  await addIdp(cf.transport(), "acc1", "github", "cid", "secret");
  expect(cf.idps.map((p) => p.type)).toEqual(["cloudflare", "onetimepin", "github"]);
  expect((await finishIdp(cf.transport(), "acc1")).ok).toBe(true);
});

test("VAPID: generated, sealed, and the public key round-trips", async () => {
  const w = await world();
  const ev = await ensureVapidKey(w.db, w.deps.sealer, w.clock.now);
  if (ev.kind !== "keys_ready") throw new Error("unexpected event");
  const raw = b64urlDecode(ev.vapid_public_key)!;
  expect(raw).toHaveLength(65);
  expect(raw[0]).toBe(4);
  const sealed = await readKey<string>(w.db, VAPID_PRIVATE_KEY);
  expect(sealed).toMatch(/^k1\./);
  const jwk = JSON.parse(await w.deps.sealer.open("vapid", VAPID_AAD, sealed!));
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  expect(key.type).toBe("private");
  expect(await ensureVapidKey(w.db, w.deps.sealer, w.clock.now)).toEqual(ev);
});

describe("claim", () => {
  const record: SetupRecord = { step: "claim", admin_email: "ada@example.org", account_id: "acc1", script_name: "yaran-cloud", cp_host: "cp.example.org" };
  const codeOf = (url: string) => new URL(url).searchParams.get("c")!;

  test("refuses another email, a wrong code and an expired link", async () => {
    const w = await world();
    const code = codeOf(await issueClaim(w.deps, "cp.example.org"));
    const cf = async () => w.cf.transport();
    expect((await redeemClaim(w.deps, record, code, "eve@example.org", cf)).ok).toBe(false);
    expect((await redeemClaim(w.deps, record, "nope", "ada@example.org", cf)).ok).toBe(false);
    expect((await redeemClaim(w.deps, record, code, null, cf)).ok).toBe(false);
    w.clock.now = new Date(w.clock.now.getTime() + 31 * 60_000);
    expect((await redeemClaim(w.deps, record, code, "ada@example.org", cf)).ok).toBe(false);
    expect(w.audits).toHaveLength(0);
  });

  test("succeeds once: admin row, setup closed, workers.dev off, audited; reuse is refused", async () => {
    const w = await world();
    const code = codeOf(await issueClaim(w.deps, "cp.example.org"));
    const out = await redeemClaim(w.deps, record, code, "Ada@Example.org", async () => w.cf.transport());
    expect(out.ok).toBe(true);
    expect(await w.db.prepare("SELECT role, status FROM users WHERE email = ?").bind("ada@example.org").first()).toEqual({ role: "admin", status: "active" });
    expect(await readKey(w.db, "setup_state")).toBe("closed");
    expect(w.cf.subdomain.enabled).toBe(false);
    expect(w.cf.bodies).toContainEqual({ call: "POST /accounts/acc1/workers/scripts/yaran-cloud/subdomain", body: { enabled: false, previews_enabled: false } });
    expect(w.audits.map((a) => a.action)).toEqual(["setup.completed"]);
    const closed = (out as { record: SetupRecord }).record;
    expect((await redeemClaim(w.deps, closed, code, "ada@example.org", async () => w.cf.transport())).ok).toBe(false);
  });

  test("a failed workers.dev disable still closes setup and is recorded for Health", async () => {
    const w = await world();
    w.cf.fault("POST /accounts/acc1/workers/scripts", "auth");
    const code = codeOf(await issueClaim(w.deps, "cp.example.org"));
    const out = await redeemClaim(w.deps, record, code, "ada@example.org", async () => w.cf.transport());
    expect(out.ok && out.record.workers_dev_disabled).toBe(false);
    expect(await readKey(w.db, "setup_state")).toBe("closed");
    expect(await readKey(w.db, "workers_dev_disabled")).toBe(false);
  });
});
