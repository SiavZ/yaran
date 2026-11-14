/**
 * Error classification table and wire-code mapping (02 §4).
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/errors.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/cloudflare/errors.ts
 * └── test/provisioning/helpers/world.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { errorEntry } from "@yaran/protocol";
import { describe, expect, it } from "vitest";
import { CfApiError, classify, permissionFor, safeErrorDetail, wireCodeFor, type CfErrorKind } from "../../src/cloudflare/errors.ts";
import { sanitize } from "./helpers/world.ts";

describe("classify", () => {
  it.each([
    [429, [], "rate_limited"],
    [500, [], "transient"],
    [503, [], "transient"],
    [404, [], "not_found"],
    [409, [], "conflict"],
    [400, [{ code: 81053, message: "exists" }], "conflict"],
    [400, [{ code: 81058, message: "exists" }], "conflict"],
    [401, [], "auth"],
    [403, [], "auth"],
    [400, [{ code: 1001, message: "bad" }], "invalid"],
    [422, [], "invalid"],
  ] as const)("HTTP %i %j → %s", (status, errors, kind) => {
    expect(classify(status, errors)).toBe(kind);
  });
});

describe("wireCodeFor", () => {
  it("maps every kind to a registry code with the registry status", () => {
    const expected: Record<CfErrorKind, [string, number]> = {
      rate_limited: ["cloudflare_rate_limited", 503],
      transient: ["cloudflare_unavailable", 502],
      conflict: ["hostname_conflict", 409],
      auth: ["cloudflare_permission_denied", 502],
      invalid: ["cloudflare_api_failed", 502],
      not_found: ["cloudflare_api_failed", 502],
    };
    for (const [kind, [code, status]] of Object.entries(expected)) {
      expect(wireCodeFor(kind as CfErrorKind)).toBe(code);
      expect(errorEntry(code)?.status).toBe(status);
    }
  });
});

describe("permission naming and sanitizing", () => {
  it("names the token permission an endpoint needs", () => {
    expect(permissionFor("GET /accounts/a/cfd_tunnel/x")).toBe("Cloudflare Tunnel Edit");
    expect(permissionFor("POST /accounts/a/access/apps")).toBe("Access: Apps and Policies Edit");
    expect(permissionFor("POST /zones/z/dns_records")).toBe("DNS Edit");
    expect(permissionFor("GET /zones/z")).toBe("Zone Read");
  });
  it("sanitizes Cloudflare's message text", () => {
    const e = new CfApiError("auth", 403, "GET /zones/z/dns_records", [{ code: 1, message: "evil \u001b]0;title\u0007" }]);
    const d = safeErrorDetail(e, sanitize);
    expect(JSON.stringify(d)).not.toMatch(/\u001b|\u0007/); // eslint-disable-line no-control-regex
    expect(d["permission"]).toBe("DNS Edit");
  });
});
