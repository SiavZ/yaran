/**
 * The add-org QR: the payload matches the shared 02 fixture, the SVG is CSP-clean, and
 * the SVG decodes back to the payload with a JS QR decoder.
 *
 * <module-headers:begin>
 * Uses:
 * test/pairing/qr.test.ts
 * ├── cloud/protocol/fixtures/uri/add-org.json
 * └── src/pairing/qr.ts
 * External: jsqr, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import addOrg from "@yaran/protocol/fixtures/uri/add-org.json" with { type: "json" };
import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { phoneQrPayload, phoneQrSvg } from "../../src/pairing/qr.ts";

/** Rasterizes uqr's `M x,y h10v10h-10z` module path onto a white canvas with a quiet zone. */
function rasterize(svg: string): { data: Uint8ClampedArray; size: number } {
  const view = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)![1]);
  const margin = 40;
  const size = view + margin * 2;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const m of svg.matchAll(/M(\d+),(\d+)h(\d+)v(\d+)/g)) {
    const [x, y, w, h] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const i = ((yy + margin) * size + xx + margin) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
  }
  return { data, size };
}

describe("phone QR", () => {
  it.each(addOrg.build)("payload for $org_url matches the shared fixture", ({ org_url, expect: want }) => {
    if (want === null) expect(() => phoneQrPayload(org_url)).toThrow();
    else expect(phoneQrPayload(org_url)).toBe(want);
  });
  it("renders CSP-clean SVG (no style attribute, no script)", () => {
    const svg = phoneQrSvg("https://cp.example.com");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toMatch(/style=/i);
    expect(svg).not.toMatch(/<script/i);
  });
  it("decodes back to the payload", () => {
    const svg = phoneQrSvg("https://cp.example.com");
    const { data, size } = rasterize(svg);
    expect(jsQR(data, size, size)?.data).toBe("yaranapp://add-org?u=https%3A%2F%2Fcp.example.com");
  });
});
