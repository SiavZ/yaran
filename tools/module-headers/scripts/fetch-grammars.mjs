#!/usr/bin/env node
/**
 * Fetch the Swift grammar wasm from its pinned GitHub release, fail closed on its checksum.
 *
 * The npm `tree-sitter-swift` package ships no wasm, so the grammar comes from the
 * alex-pinkus/tree-sitter-swift 0.7.3 release asset instead. The file is cached in
 * `.grammars/` (gitignored, never committed) and a cached file with the right checksum is
 * not downloaded again.
 *
 * - A checksum mismatch, an empty checksum constant or a failed download exits non-zero
 *   and leaves no file behind.
 * - Importing this module has no side effects; parsers.mjs reads the checksum from it.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:crypto, node:fs, node:path, node:url
 *
 * Used by:
 * scripts/fetch-grammars.mjs
 * ├── src/parsers.mjs
 * └── test/parsers.test.mjs
 * <module-headers:end>
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SWIFT_WASM_URL =
  "https://github.com/alex-pinkus/tree-sitter-swift/releases/download/0.7.3/tree-sitter-swift.wasm";
/** SHA-256 of the 0.7.3 asset, measured on 2026-11-14 (two downloads agreed). */
export const SWIFT_WASM_SHA256 = "0258a7ef17303a8079ffe0748b3583d59656b5c3e8653fca7b6451b3e6689eb2";

/**
 * @param {Uint8Array} bytes
 * @param {string} expected
 * @returns {boolean}
 */
export function checksumMatches(bytes, expected) {
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error("no valid SHA-256 is pinned for the Swift grammar; refusing to trust any download");
  }
  return createHash("sha256").update(bytes).digest("hex") === expected;
}

/**
 * Download (or reuse) the grammar into `dest`.
 * @param {{ dest: string, url?: string, sha256?: string, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<"cached" | "downloaded">}
 */
export async function fetchSwiftGrammar({ dest, url = SWIFT_WASM_URL, sha256 = SWIFT_WASM_SHA256, fetchImpl = fetch }) {
  if (existsSync(dest) && checksumMatches(readFileSync(dest), sha256)) return "cached";
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!checksumMatches(bytes, sha256)) {
    const got = createHash("sha256").update(bytes).digest("hex");
    throw new Error(`checksum mismatch for ${url}: got ${got}, pinned ${sha256}`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(`${dest}.tmp`, bytes);
  renameSync(`${dest}.tmp`, dest);
  return "downloaded";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dest = join(dirname(fileURLToPath(import.meta.url)), "..", ".grammars", "tree-sitter-swift.wasm");
  try {
    const how = await fetchSwiftGrammar({ dest });
    console.log(`tree-sitter-swift.wasm ${how}, SHA-256 verified: ${dest}`);
  } catch (e) {
    console.error(`fetch-grammars: ${/** @type {Error} */ (e).message}`);
    process.exit(1);
  }
}
