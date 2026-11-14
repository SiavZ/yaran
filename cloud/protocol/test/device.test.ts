/**
 * Pins the handoff device signature (Design §8.1): canonical bytes, the form and
 * freshness checks with their codes, and ES256 verification over raw r || s, for every
 * case in `fixtures/sig/handoff-device-signature.json`.
 *
 * <module-headers:begin>
 * Uses:
 * test/device.test.ts
 * ├── src/b64url.ts
 * ├── src/sig/device.ts
 * └── test/fixtures.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { toHex } from "../src/b64url.ts";
import { checkHandoffDeviceFields, handoffDeviceCanonical, verifyHandoffDeviceSig } from "../src/sig/device.ts";
import { fixture, utf8 } from "./fixtures.ts";

const v = fixture("sig/handoff-device-signature.json");

describe("handoff device signature", () => {
  it("builds the canonical bytes", () => {
    const text = handoffDeviceCanonical({ host: v.host, pk: v.pk, state: v.state, dts: v.dts });
    expect(text).toBe(v.canonical_utf8);
    expect(toHex(utf8(text))).toBe(v.canonical_hex);
  });

  for (const c of v.cases) {
    it(c.name, async () => {
      const f = c.fields;
      const field = checkHandoffDeviceFields(f, c.now);
      if (c.expect.code) {
        expect(field?.code).toBe(c.expect.code);
        if (c.expect.server_time !== undefined) expect(field?.serverTime).toBe(c.expect.server_time);
        return;
      }
      expect(field).toBeNull();
      expect(await verifyHandoffDeviceSig(f)).toBe(c.expect.verified);
    });
  }
});
