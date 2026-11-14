/**
 * Pins the machine and device key fingerprints (Design §7.1, §8.1) to
 * `fixtures/sig/fingerprint.json` and `fixtures/sig/device-fingerprint.json`.
 *
 * <module-headers:begin>
 * Uses:
 * test/fingerprint.test.ts
 * ├── src/sig/device.ts
 * ├── src/sig/fingerprint.ts
 * └── test/fixtures.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { deviceKeyFingerprint, deviceKeyFp24 } from "../src/sig/device.ts";
import { base32, fingerprintsMatch, machineKeyFingerprint } from "../src/sig/fingerprint.ts";
import { fixture } from "./fixtures.ts";

describe("machine key fingerprint", () => {
  for (const c of fixture("sig/fingerprint.json").cases) {
    it(c.fingerprint, async () => {
      expect(await machineKeyFingerprint(c.public_key)).toBe(c.fingerprint);
      expect(c.fingerprint).toMatch(/^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}$/);
    });
  }

  it("compares typed fingerprints case-insensitively, dashes optional", () => {
    expect(fingerprintsMatch("k7qf3mzdw2paHX5RLC4NTB6E", "K7QF-3MZD-W2PA-HX5R-LC4N-TB6E")).toBe(true);
    expect(fingerprintsMatch("K7QF-3MZD-W2PA-HX5R-LC4N-TB6F", "K7QF-3MZD-W2PA-HX5R-LC4N-TB6E")).toBe(false);
  });

  it("encodes RFC 4648 base32 test vectors", () => {
    expect(base32(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
    expect(base32(new TextEncoder().encode("fooba"))).toBe("MZXW6YTB");
  });
});

describe("device key fingerprint", () => {
  for (const c of fixture("sig/device-fingerprint.json").cases) {
    it(c.fingerprint, async () => {
      expect(await deviceKeyFingerprint(c.dk)).toBe(c.fingerprint);
      expect(await deviceKeyFp24(c.dk)).toBe(c.fp24);
    });
  }
});
