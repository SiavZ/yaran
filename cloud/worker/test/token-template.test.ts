/**
 * The token template URL comes from permissions.json alone, and README and binding text match it.
 *
 * <module-headers:begin>
 * Uses:
 * test/token-template.test.ts
 * ├── cloud/worker/scripts/permissions.json
 * └── src/setup/token-template.ts
 * External: node:fs, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import manifest from "../scripts/permissions.json" with { type: "json" };
import { PERMISSIONS, permissionGroupKeys, tokenTemplateUrl } from "../src/setup/token-template.ts";

test("the URL round-trips to exactly the manifest's IDs", () => {
  const url = new URL(tokenTemplateUrl());
  expect(url.origin + url.pathname + "?to=" + url.searchParams.get("to")).toBe("https://dash.cloudflare.com/?to=/:account/api-tokens");
  const keys = JSON.parse(url.searchParams.get("permissionGroupKeys")!);
  expect(keys).toEqual(PERMISSIONS.map((p) => ({ key: p.id, type: p.name.endsWith(" Read") ? "read" : "edit" })));
  expect(url.searchParams.get("name")).toBe("yaran control plane");
});

test("every row has a 32-hex id, a purpose, endpoints, a scope and a probe", () => {
  for (const p of manifest.permissions) {
    expect(p.id).toMatch(/^[0-9a-f]{32}$/);
    expect(p.purpose.length).toBeGreaterThan(20);
    expect(p.endpoints.length).toBeGreaterThan(0);
    expect(["account", "zone"]).toContain(p.scope);
    expect(p.probe).toBeTruthy();
  }
});

test("no token-minting, D1 or service-token permission is requested", () => {
  for (const p of PERMISSIONS) expect(p.name).not.toMatch(/API Tokens|D1|Service Token|Workers Builds/);
});

test("the short-key fallback leaves out the tunnel row, which has no official short key", () => {
  expect(permissionGroupKeys(PERMISSIONS, true).map((k) => k.key)).toEqual(["access", "access_acct", "workers_scripts", "dns", "zone"]);
});

test("the deploy README and the CF_API_TOKEN binding description link the generated URL", () => {
  const readme = readFileSync(new URL("../deploy-template/README.md", import.meta.url), "utf8");
  expect(readme.match(/https:\/\/dash\.cloudflare\.com\/\?to=[^)\s]*/g)).toEqual([tokenTemplateUrl()]);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg.cloudflare.bindings.CF_API_TOKEN.description).toContain(tokenTemplateUrl());
});
