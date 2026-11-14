/**
 * Test helper: reads a shared fixture from `fixtures/` by its path.
 *
 * Every suite (TS here, Rust in yaran-core, Kotlin and Swift later) reads the same files,
 * so this resolves relative to this file rather than the working directory (the
 * prose.test.tsx pattern).
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:fs, node:path, node:url
 *
 * Used by:
 * test/fixtures.ts
 * ├── test/consent.test.ts
 * ├── test/device.test.ts
 * ├── test/fingerprint.test.ts
 * ├── test/jwe.test.ts
 * ├── test/push.test.ts
 * ├── test/redirect.test.ts
 * ├── test/sig.test.ts
 * ├── test/ua.test.ts
 * ├── test/uri.test.ts
 * └── test/version.test.ts
 * <module-headers:end>
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

export function fixture<T = any>(path: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, path), "utf8")) as T;
}

/** Fixture paths in a directory whose file names start with a prefix. */
export function fixturePaths(dir: string, prefix: string): string[] {
  return readdirSync(join(FIXTURES, dir))
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()
    .map((f) => `${dir}/${f}`);
}

export const hexToBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
export const utf8 = (s: string) => new TextEncoder().encode(s);
