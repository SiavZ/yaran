/**
 * Pins the app URIs (Design §10): the add-org builder and parser, the in-WebView control
 * URL decisions, the handoff callback parameter split (query, else fragment), and the
 * strict add-machine and verified agent-link forms.
 *
 * <module-headers:begin>
 * Uses:
 * test/uri.test.ts
 * ├── src/uri.ts
 * └── test/fixtures.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/protocol and cloud-protocol.yml)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import {
  addMachineUri,
  addOrgUri,
  agentLinkUrl,
  controlUrlDecision,
  handoffCallbackParams,
  parseAddMachineUri,
  parseAgentLink,
  parseAppUri,
  reauthUri,
} from "../src/uri.ts";
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

describe("add-machine", () => {
  const f = fixture("uri/add-machine.json");
  for (const c of f.build) {
    it(`build ${c.host.slice(0, 40)}`, () => {
      if (c.expect === null) expect(() => addMachineUri(c.host)).toThrow();
      else expect(addMachineUri(c.host)).toBe(c.expect);
    });
  }
  for (const c of f.parse) {
    it(`parse ${c.uri.slice(0, 70)}`, () => {
      const r = parseAddMachineUri(c.uri);
      if (c.expect === "uri_invalid") expect(r).toEqual({ ok: false, code: "uri_invalid" });
      else expect(r).toEqual({ ok: true, kind: "add-machine", host: c.expect.host });
      // The older parser and the machine-view control decision never act on it.
      if (c.uri.toLowerCase().startsWith("yaranapp://add-machine")) {
        expect(parseAppUri(c.uri)).toEqual({ ok: false, code: "uri_invalid" });
        expect(controlUrlDecision(c.uri, "yaran.example.com")).toBe("ignore");
      }
    });
  }
  it("round-trips every built URI", () => {
    for (const c of f.build.filter((b: { expect: string | null }) => b.expect !== null)) {
      expect(parseAddMachineUri(addMachineUri(c.host))).toEqual({ ok: true, kind: "add-machine", host: c.host });
    }
  });
});

describe("agent link", () => {
  const f = fixture("uri/agent-link.json");
  const domain: string = f.publisher_domain;
  for (const c of f.build) {
    it(`build ${JSON.stringify(c.link).slice(0, 70)}`, () => {
      if (c.expect === null) expect(() => agentLinkUrl(domain, c.link)).toThrow();
      else {
        expect(agentLinkUrl(domain, c.link)).toBe(c.expect);
        expect(parseAgentLink(c.expect, domain)).toEqual({ ok: true, ...c.link });
      }
    });
  }
  it("refuses to build without a valid publisher domain", () => {
    const link = f.build[0].link;
    for (const d of f.build_bad_domain) expect(() => agentLinkUrl(d, link)).toThrow();
  });
  for (const c of f.parse) {
    it(`parse ${c.url.slice(0, 80)}`, () => {
      const r = parseAgentLink(c.url, domain);
      if (c.expect === "uri_invalid") expect(r).toEqual({ ok: false, code: "uri_invalid" });
      else expect(r).toEqual({ ok: true, ...c.expect });
    });
  }
  it("refuses everything when the build has no valid publisher domain", () => {
    const g = f.parse_without_domain;
    for (const d of g.domains) expect(parseAgentLink(g.url, d)).toEqual({ ok: false, code: "uri_invalid" });
  });
});
