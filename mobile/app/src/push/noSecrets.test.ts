/**
 * D22 lint over the shell's push module: no product file reads an endpoint, a push key, a JWT
 * or a cookie, and none makes a network call of its own.
 *
 * - Scans source text, so it also catches a field read the type checker would allow through
 *   an `unknown` or a cast.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:fs, node:path, node:url, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = dirname(fileURLToPath(import.meta.url));
const productFiles = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== "pushTestKit.ts");

const FORBIDDEN: [string, RegExp][] = [
  ["endpoint field", /\.endpoint\b|["']endpoint["']\s*:/],
  ["push keys", /\.(p256dh|keys)\b|["'](p256dh|keys)["']\s*:/],
  ["auth secret", /\.auth\b|["']auth["']\s*:/],
  ["JWT or cookie", /\bjwt\b|cookie|authorization|cf-access-token/i],
  ["direct network", /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/],
];

describe("push module never touches key material", () => {
  it("has product files to scan", () => {
    expect(productFiles.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of productFiles) {
    it(file, () => {
      const text = readFileSync(join(dir, file), "utf8").replace(/\/\*\*[\s\S]*?\*\//, "");
      for (const [what, pattern] of FORBIDDEN) expect(pattern.test(text), `${file}: ${what}`).toBe(false);
    });
  }
});
