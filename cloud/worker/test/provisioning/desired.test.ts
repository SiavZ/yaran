/**
 * Desired-state builders (golden JSON) and drift comparators (every single-field drift is
 * detected; server-added fields are ignored).
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/desired.test.ts
 * └── src/cloudflare/desired.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm run test:provisioning in cloud/worker)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import {
  appBody,
  appDrift,
  dnsBody,
  dnsDrift,
  ingressConfig,
  ingressDrift,
  liveOriginPort,
  oauthAllowedUris,
  policyBody,
  policyDrift,
  teamNameFor,
} from "../../src/cloudflare/desired.ts";

const M = { instanceId: "a1b2c3d4", machineId: "0f0e0d0c-0b0a-4908-8706-050403020100", hostname: "laptop-alice.example.com", ownerEmail: "alice@example.org" };
const OPTS = { sessionDuration: "24h", sameSite: "lax" as const };

describe("golden builders", () => {
  it("policy", () => {
    expect(policyBody(M)).toEqual({ name: `yaran:a1b2c3d4:owner:${M.machineId}`, decision: "allow", include: [{ email: { email: "alice@example.org" } }] });
  });

  it("app (L0/L1: no oauth_configuration)", () => {
    expect(appBody(M, "pol-1", OPTS)).toEqual({
      type: "self_hosted",
      name: `yaran:a1b2c3d4:m:${M.machineId}`,
      domain: "laptop-alice.example.com",
      destinations: [{ type: "public", uri: "laptop-alice.example.com" }],
      session_duration: "24h",
      app_launcher_visible: false,
      enable_binding_cookie: false,
      http_only_cookie_attribute: true,
      same_site_cookie_attribute: "lax",
      options_preflight_bypass: false,
      allow_iframe: false,
      policies: [{ id: "pol-1", precedence: 1 }],
    });
  });

  it("app under G1 fallback L2 adds Managed OAuth with the callback URIs", () => {
    const uris = oauthAllowedUris(["https://app.example.org/cb", "https://app.example.org/other", "https://b.example.net/x", "::bad"]);
    expect(uris).toEqual(["https://app.example.org/oauth/callback", "https://b.example.net/oauth/callback", "yaranapp://oauth/callback"]);
    expect(appBody(M, "p", { ...OPTS, oauthAllowedUris: uris })["oauth_configuration"]).toEqual({
      enabled: true,
      dynamic_client_registration: { enabled: true, allowed_uris: uris, allow_any_on_localhost: false, allow_any_on_loopback: false },
      grant: { access_token_lifetime: "15m", session_duration: "24h" },
    });
  });

  it("ingress puts access inside the machine's rule and leaves the tunnel-level originRequest empty", () => {
    const cfg = ingressConfig(M.hostname, 4123, teamNameFor("acme.cloudflareaccess.com"), "aud-1");
    expect(cfg).toEqual({
      ingress: [
        {
          hostname: "laptop-alice.example.com",
          service: "http://127.0.0.1:4123",
          originRequest: { access: { required: true, teamName: "acme", audTag: ["aud-1"] } },
        },
        { service: "http_status:404" },
      ],
      originRequest: {},
    });
    expect(JSON.stringify(cfg)).not.toContain("httpHostHeader");
    expect(teamNameFor("acme.cloudflareaccess.com", "domain")).toBe("acme.cloudflareaccess.com");
    expect(liveOriginPort({ config: cfg })).toBe(4123);
  });

  it("dns", () => {
    expect(dnsBody(M, "tun-1")).toEqual({
      type: "CNAME",
      name: "laptop-alice.example.com",
      content: "tun-1.cfargotunnel.com",
      proxied: true,
      ttl: 1,
      comment: `yaran:a1b2c3d4:m:${M.machineId}`,
    });
  });
});

describe("comparators", () => {
  it("policy: each field drifts, server fields do not", () => {
    const want = policyBody(M);
    const live = { ...want, id: "p", app_count: 1, created_at: "x" };
    expect(policyDrift(want, live)).toEqual([]);
    expect(policyDrift(want, { ...live, name: "x" })).toEqual(["policy.name"]);
    expect(policyDrift(want, { ...live, decision: "deny" })).toEqual(["policy.decision"]);
    expect(policyDrift(want, { ...live, include: [{ everyone: {} }] })).toEqual(["policy.include"]);
  });

  it("app: each managed field drifts, server fields do not", () => {
    const want = appBody(M, "pol-1", OPTS);
    const live = { ...want, id: "a", aud: "x", created_at: "t", updated_at: "u", policies: [{ id: "pol-1", precedence: 1, name: "n" }] } as never;
    expect(appDrift(want, live)).toEqual([]);
    const flips: Record<string, unknown> = {
      type: "ssh",
      name: "other",
      domain: "evil.example.com",
      destinations: [{ type: "public", uri: "x" }],
      session_duration: "720h",
      app_launcher_visible: true,
      enable_binding_cookie: true,
      http_only_cookie_attribute: false,
      same_site_cookie_attribute: "none",
      options_preflight_bypass: true,
      allow_iframe: true,
      policies: [{ id: "pol-2", precedence: 1 }],
    };
    for (const [k, v] of Object.entries(flips)) expect(appDrift(want, { ...(live as object), [k]: v } as never)).toEqual([`app.${k}`]);
    expect(appDrift(want, { ...(live as object), oauth_configuration: { enabled: true } } as never)).toEqual([]);
  });

  it("ingress: hostname, service (port), access, catch-all and tunnel-level access drift", () => {
    const want = ingressConfig(M.hostname, 3890, "acme", "aud");
    const live = { version: 3, config: structuredClone(want) };
    expect(ingressDrift(want, live)).toEqual([]);
    const mutate = (f: (c: typeof want) => void) => {
      const c = structuredClone(want);
      f(c);
      return ingressDrift(want, { config: c });
    };
    expect(mutate((c) => (c.ingress[0]!.hostname = "x"))).toEqual(["ingress.hostname"]);
    expect(mutate((c) => (c.ingress[0]!.service = "http://127.0.0.1:9999"))).toEqual(["ingress.service"]);
    expect(mutate((c) => (c.ingress[0]!.originRequest = {}))).toEqual(["ingress.originRequest"]);
    expect(mutate((c) => c.ingress.pop())).toEqual(["ingress.catch_all"]);
    expect(mutate((c) => (c.originRequest = { access: { required: true } }))).toEqual(["ingress.tunnel_origin_request"]);
    expect(ingressDrift(want, { config: null })).toEqual(["ingress.missing"]);
  });

  it("dns: each field drifts, id and timestamps do not", () => {
    const want = dnsBody(M, "tun-1");
    const live = { ...want, id: "r", created_on: "t", name: "Laptop-Alice.example.com" };
    expect(dnsDrift(want, live)).toEqual([]);
    for (const [k, v] of Object.entries({ type: "A", content: "x.cfargotunnel.com", proxied: false, ttl: 300, comment: "z" })) {
      expect(dnsDrift(want, { ...live, [k]: v })).toEqual([`dns.${k}`]);
    }
  });
});
