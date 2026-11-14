/**
 * Pins remembered consent (Design §8.1, D24): the cookie MAC, value and Set-Cookie
 * lines, the Worker's HKDF key, every cookie verify case (failures are reasons, never
 * errors), and every row of the skip decision table.
 *
 * <module-headers:begin>
 * Uses:
 * test/consent.test.ts
 * ├── src/b64url.ts
 * ├── src/consent.ts
 * └── test/fixtures.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { toHex } from "../src/b64url.ts";
import {
  buildConsentCookie,
  CONSENT_PATHS,
  consentMac,
  consentMacInput,
  consentSetCookie,
  consentSetsCookie,
  decideRemembered,
  verifyConsentCookie,
  workerConsentKey,
} from "../src/consent.ts";
import { fixture, hexToBytes, utf8 } from "./fixtures.ts";

const c = fixture("handoff/consent-cookie.json");
const key = hexToBytes(c.key_hex);

describe("consent cookie", () => {
  it("reproduces mac_in, the MAC, the value and both Set-Cookie lines", async () => {
    const input = consentMacInput(c.host, c.fp24, c.iat, c.kv);
    expect(input).toBe(c.mac_in_utf8);
    expect(toHex(utf8(input))).toBe(c.mac_in_hex);
    expect(await consentMac(key, c.host, c.fp24, c.iat, c.kv)).toBe(c.mac);
    const value = await buildConsentCookie({ key, kv: c.kv, host: c.host, fp24: c.fp24, iat: c.iat });
    expect(value).toBe(c.value);
    expect(consentSetCookie(value, CONSENT_PATHS.machine)).toBe(c.set_cookie.machine);
    expect(consentSetCookie(value, CONSENT_PATHS.control_plane)).toBe(c.set_cookie.control_plane);
  });

  it("derives the Worker key from DATA_KEY", async () => {
    expect(toHex(await workerConsentKey(hexToBytes(c.worker_key.data_key_hex)))).toBe(c.worker_key.key_hex);
    expect(Buffer.from(c.worker_key.data_key_b64, "base64").toString("hex")).toBe(c.worker_key.data_key_hex);
  });

  for (const v of c.verify_cases) {
    it(`verify: ${v.name}`, async () => {
      const verdict = await verifyConsentCookie({ value: v.value, host: v.host, key, currentKv: v.current_kv, now: v.now });
      if (v.expect_reason === null) expect(verdict).toEqual({ ok: true, fp24: c.fp24 });
      else expect(verdict).toEqual({ ok: false, reason: v.expect_reason });
    });
  }
});

describe("remembered-consent skip rule", () => {
  const t = fixture("handoff/remembered-consent.json");
  for (const row of t.rows) {
    it(row.name, async () => {
      const decision = await decideRemembered({
        side: row.side,
        cookie: row.cookie,
        host: t.host,
        dkFp24: t.dk_fp24,
        verified: row.verified,
        dtsFresh: row.dts_fresh,
        deviceRevoked: row.device_revoked,
        key: hexToBytes(t.key_hex),
        currentKv: t.current_kv,
        now: t.now,
      });
      expect(decision).toBe(row.expect);
      if (decision === "skip") expect(row.verified).toBe(true);
      expect(consentSetsCookie("continue", row.verified)).toBe(row.continue_sets_cookie);
      expect(consentSetsCookie("cancel", row.verified)).toBe(row.cancel_sets_cookie);
    });
  }
});
