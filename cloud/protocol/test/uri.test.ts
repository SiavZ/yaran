/**
 * Pins the app URIs (Design §10): the add-org builder and parser, the in-WebView control
 * URL decisions, and the handoff callback parameter split (query, else fragment).
 *
 * <module-headers:begin>
 * Uses:
 * test/uri.test.ts
 * ├── src/uri.ts
 * └── test/fixtures.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { addOrgUri, controlUrlDecision, handoffCallbackParams, parseAppUri, reauthUri } from "../src/uri.ts";
import { fixture } from "./fixtures.ts";

describe("add-org", () => {
  const f = fixture("uri/add-org.json");
  for (const c of f.build) {
    it(`build ${c.org_url.slice(0, 40)}`, () => {
      if (c.expect === null) expect(() => addOrgUri(c.org_url)).toThrow();
      else expect(addOrgUri(c.org_url)).toBe(c.expect);
    });
  }
  for (const c of f.parse) {
    it(`parse ${c.uri.slice(0, 60)}`, () => {
      const r = parseAppUri(c.uri);
      if (c.expect === "uri_invalid") expect(r).toEqual({ ok: false, code: "uri_invalid" });
      else expect(r).toEqual({ ok: true, kind: "add-org", orgUrl: c.expect.org_url });
    });
  }
});

describe("control URLs", () => {
  for (const c of fixture("uri/control-urls.json").cases) {
    it(c.uri, () => {
      expect(controlUrlDecision(c.uri, c.loaded_host)).toBe(c.expect);
      if (c.code) expect(parseAppUri(c.uri)).toEqual({ ok: false, code: c.code });
    });
  }
  it("builds a reauth URL machine-view honours", () => {
    expect(controlUrlDecision(reauthUri("laptop-ada.example.com"), "laptop-ada.example.com")).toBe("reauth");
  });
});

describe("handoff callback parameters", () => {
  it("reads the query, else the fragment, and refuses duplicates", () => {
    expect(handoffCallbackParams("https://app.example.com/auth/callback?state=s&jwe=j")?.get("jwe")).toBe("j");
    expect(handoffCallbackParams("https://app.example.com/auth/callback#state=s&error=handoff_declined")?.get("error")).toBe("handoff_declined");
    expect(handoffCallbackParams("yaranapp://auth/callback?state=a&state=b")).toBeNull();
  });
});
