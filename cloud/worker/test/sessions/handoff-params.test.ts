/**
 * Table tests for the W16/W16b validators: the redirect allowlist fixture, the field
 * rules in 02 §8's order, and the D24 device-field vectors.
 *
 * <module-headers:begin>
 * Uses:
 * test/sessions/handoff-params.test.ts
 * ├── cloud/protocol/fixtures/sig/handoff-device-signature.json
 * ├── cloud/protocol/fixtures/uri/handoff-redirect.json
 * └── src/sessions/handoff-params.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import redirectFx from "@yaran/protocol/fixtures/uri/handoff-redirect.json" with { type: "json" };
import sigFx from "@yaran/protocol/fixtures/sig/handoff-device-signature.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { callbackUrl, parseHandoffConsent, parseHandoffQuery } from "../../src/sessions/handoff-params.ts";

const CONFIGURED = redirectFx.configured;
const base = (o: Record<string, string | null> = {}): URLSearchParams => {
  const q: Record<string, string | null> = {
    v: "1",
    pk: sigFx.pk,
    state: sigFx.state,
    redirect: CONFIGURED[0]!,
    device: "Ada's Pixel",
    dk: sigFx.dk,
    dts: sigFx.dts,
    dsig: sigFx.dsig,
    ...o,
  };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== null) p.set(k, v);
  return p;
};
const parse = (o: Record<string, string | null> = {}, now = sigFx.now) => parseHandoffQuery(base(o), CONFIGURED, now);

describe("redirect allowlist (fixtures/uri/handoff-redirect.json)", () => {
  for (const c of redirectFx.cases) {
    it(`${c.build ?? "absent"} ${c.redirect} → ${c.expect}`, () => {
      const r = parse({ redirect: c.redirect, build: c.build });
      if (c.expect) expect(r.ok).toBe(true);
      else expect(r).toMatchObject({ ok: false, code: "handoff_request_invalid", target: null });
    });
  }
});

describe("field rules", () => {
  it("accepts a well-formed query and normalises build and mode", () => {
    const r = parse();
    expect(r.ok && r.value).toMatchObject({ v: 1, build: "release", mode: "query", device: "Ada's Pixel" });
  });
  it.each([
    ["a 21-char state", { state: "a".repeat(21) }],
    ["a state with padding", { state: `${"a".repeat(22)}=` }],
    ["an unknown build", { build: "beta" }],
  ])("refuses %s with no redirect", (_n, o) => {
    expect(parse(o)).toMatchObject({ ok: false, code: "handoff_request_invalid", target: null });
  });
  it.each([
    ["a bidi override in device", { device: "Pixel‮evil" }],
    ["a control character in device", { device: "Pixel\u0007" }],
    ["an empty device", { device: "" }],
    ["a 65-char device", { device: "x".repeat(65) }],
    ["an unknown mode", { mode: "post" }],
    ["an off-curve pk", { pk: `BA${sigFx.pk.slice(2, -2)}AA` }],
    ["a 64-byte pk", { pk: sigFx.pk.slice(0, 86) }],
    ["a missing v", { v: null }],
  ])("refuses %s with a redirect", (_n, o) => {
    const r = parse(o);
    expect(r).toMatchObject({ ok: false, code: "handoff_request_invalid" });
    expect(r.ok === false && r.target?.redirect).toBe(CONFIGURED[0]);
  });
  it("accepts a 64-char device with a multibyte character", () => {
    expect(parse({ device: `${"x".repeat(63)}é` }).ok).toBe(true);
  });
  it("answers protocol_unsupported with min and max", () => {
    expect(parse({ v: "2" })).toMatchObject({ ok: false, code: "protocol_unsupported", extra: { min: 1, max: 1 } });
  });
  it("redirects a dev build only to the custom scheme", () => {
    expect(parse({ build: "dev", redirect: "yaranapp://auth/callback" }).ok).toBe(true);
  });
});

describe("D24 device fields (fixtures/sig/handoff-device-signature.json)", () => {
  for (const c of sigFx.cases) {
    if (!("code" in c.expect)) continue;
    it(`${c.name} → ${c.expect.code}`, () => {
      const r = parse({ dk: c.fields.dk, dts: c.fields.dts, dsig: c.fields.dsig }, c.now);
      expect(r).toMatchObject({ ok: false, code: c.expect.code });
      expect(r.ok === false && r.target).not.toBeNull();
      if ("server_time" in c.expect) expect(r.ok === false && r.extra).toEqual({ server_time: c.expect.server_time });
    });
  }
  it("refuses a signed dts and a zero-led one as malformed", () => {
    for (const dts of ["+1731571200", "-1731571200", "01731571200"]) expect(parse({ dts })).toMatchObject({ code: "handoff_signature_malformed" });
  });
  it("accepts dts at the ±300 s edges and refuses ±301 s", () => {
    expect(parse({}, sigFx.now + 300).ok).toBe(true);
    expect(parse({}, sigFx.now - 300).ok).toBe(true);
    expect(parse({}, sigFx.now + 301)).toMatchObject({ code: "handoff_timestamp_skewed", extra: { server_time: sigFx.now + 301 } });
    expect(parse({}, sigFx.now - 301)).toMatchObject({ code: "handoff_timestamp_skewed" });
  });
  it("treats a missing dts as malformed", () => {
    expect(parse({ dts: null })).toMatchObject({ code: "handoff_signature_malformed" });
  });
});

describe("HandoffConsent", () => {
  const form = (o: Record<string, string | null> = {}) => {
    const p = base({ dts: null, dsig: null, csrf: "Y3NyZi10b2tlbi1mb3ItdGVzdA", decision: "continue", ...o });
    return parseHandoffConsent(p, CONFIGURED);
  };
  it("accepts continue and cancel", () => {
    expect(form().ok).toBe(true);
    expect(form({ decision: "cancel" }).ok).toBe(true);
  });
  it("re-checks dk exactly as the GET did", () => {
    expect(form({ dk: `A${sigFx.dk.slice(1)}` })).toMatchObject({ code: "handoff_device_key_invalid" });
  });
  it("refuses a bad decision or csrf", () => {
    expect(form({ decision: "approve" })).toMatchObject({ code: "handoff_request_invalid" });
    expect(form({ csrf: "short" })).toMatchObject({ code: "handoff_request_invalid" });
  });
});

describe("callbackUrl", () => {
  it("puts state first, in the query or the fragment", () => {
    const t = { redirect: "https://a.example/cb", state: "s".repeat(22), mode: "query" as const };
    expect(callbackUrl(t, { jwe: "x.y" })).toBe(`https://a.example/cb?state=${"s".repeat(22)}&jwe=x.y`);
    expect(callbackUrl({ ...t, mode: "fragment" }, { error: "e" })).toBe(`https://a.example/cb#state=${"s".repeat(22)}&error=e`);
  });
});
