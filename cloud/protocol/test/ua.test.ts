/**
 * Pins the app UA token (Design §11) to `fixtures/ua/ua.json`.
 *
 * <module-headers:begin>
 * Uses:
 * test/ua.test.ts
 * ├── src/ua.ts
 * └── test/fixtures.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/protocol and cloud-protocol.yml)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { parseYaranAppUa, yaranAppToken } from "../src/ua.ts";
import { fixture } from "./fixtures.ts";

describe("YaranApp UA token", () => {
  const f = fixture("ua/ua.json");
  for (const c of f.parse) {
    it(`parse ${c.ua.slice(-48)}`, () => {
      expect(parseYaranAppUa(c.ua)).toEqual(c.expect);
    });
  }
  for (const c of f.build) {
    it(`build ${c.token}`, () => {
      expect(yaranAppToken(c.input)).toBe(c.token);
    });
  }
  it("refuses a version the grammar does not allow", () => {
    expect(() => yaranAppToken({ version: "1.0", os: "ios", form: "phone" })).toThrow();
  });
});
