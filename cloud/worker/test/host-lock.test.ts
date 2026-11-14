/**
 * The host lock in both setup states (D19): workers.dev serves only the wizard and meta while
 * open; after close every other Host gets 421 and /setup* on the control plane gets 410.
 *
 * <module-headers:begin>
 * Uses:
 * test/host-lock.test.ts
 * └── src/setup/host-lock.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { describe, expect, test } from "vitest";
import { hostLock, scriptNameFromHost } from "../src/setup/host-lock.ts";

const WD = "yaran-cloud.acme.workers.dev";
const CP = "cp.example.org";

describe("setup open", () => {
  test.each([
    [WD, "/setup", true],
    [WD, "/setup/token", true],
    [WD, "/v1/meta", true],
    [WD, "/v1/me", false],
    [WD, "/admin/users", false],
    [WD, "/v1/machine/config", false],
    [WD, "/setupx", false],
    [CP, "/setup/claim", true],
    [CP, "/setup", false],
    [CP, "/v1/meta", true],
    ["other.example.org", "/setup", false],
  ])("%s %s → ok=%s", (host, path, ok) => {
    const v = hostLock({ setup: "open", host, path, controlPlaneHost: CP });
    expect(v.ok).toBe(ok);
    if (!v.ok) expect(v.code).toBe("setup_incomplete");
  });
});

describe("setup closed", () => {
  test.each([WD, "preview-abc.yaran-cloud.acme.workers.dev", "evil.example.com"])("%s → 421 misdirected_host", (host) => {
    expect(hostLock({ setup: "closed", host, path: "/v1/meta", controlPlaneHost: CP })).toEqual({ ok: false, code: "misdirected_host" });
  });
  test("the control-plane host serves everything but /setup*", () => {
    expect(hostLock({ setup: "closed", host: "CP.example.org:443", path: "/v1/me", controlPlaneHost: CP }).ok).toBe(true);
    expect(hostLock({ setup: "closed", host: CP, path: "/setup/claim", controlPlaneHost: CP })).toEqual({ ok: false, code: "setup_closed" });
  });
  test("the verdict carries no host name", () => {
    expect(JSON.stringify(hostLock({ setup: "closed", host: WD, path: "/", controlPlaneHost: CP }))).not.toContain(CP);
  });
});

test("script name from the workers.dev host", () => {
  expect(scriptNameFromHost(WD)).toBe("yaran-cloud");
  expect(scriptNameFromHost(CP)).toBeUndefined();
});
