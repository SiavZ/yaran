/**
 * Grammar loader tests: every grammar parses a sample, a corrupted wasm is refused, and
 * the Swift fetch fails closed on a checksum mismatch or a missing checksum.
 *
 * <module-headers:begin>
 * Uses:
 * test/parsers.test.mjs
 * ├── scripts/fetch-grammars.mjs
 * └── src/parsers.mjs
 * External: node:assert/strict, node:crypto, node:fs, node:os, node:path, node:test
 *
 * Used by: entry point (node --test, via npm test in tools/module-headers)
 * <module-headers:end>
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse, loadGrammarBytes, GRAMMAR_FILES } from "../src/parsers.mjs";
import { fetchSwiftGrammar, checksumMatches } from "../scripts/fetch-grammars.mjs";

const SAMPLES = {
  rust: ["mod a; use crate::b;", "mod_item"],
  shell: ["source ./x.sh", "command"],
  kotlin: ["package a.b\nclass C", "package_header"],
  swift: ["import Foundation\nstruct S {}", "import_declaration"],
};

for (const [lang, [code, nodeType]] of Object.entries(SAMPLES)) {
  test(`${lang} grammar parses a sample`, async () => {
    const tree = await parse(lang, code);
    assert.ok(tree.rootNode.namedChildren.some((c) => c?.type === nodeType), tree.rootNode.toString());
    assert.equal(tree.rootNode.hasError, false);
  });
}

test("a corrupted wasm is refused before loading", async () => {
  await assert.rejects(loadGrammarBytes("rust", new TextEncoder().encode("not wasm at all")), /not a WebAssembly module/);
  const real = readFileSync(GRAMMAR_FILES.rust);
  const truncated = real.subarray(0, 4096);
  await assert.rejects(loadGrammarBytes("rust", truncated));
});

test("a swift grammar with the wrong checksum is refused", async () => {
  const rustBytes = readFileSync(GRAMMAR_FILES.rust);
  await assert.rejects(loadGrammarBytes("swift", rustBytes), /SHA-256/);
});

test("fetch fails closed on a mismatch, leaves no file, and refuses an empty pin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mh-fetch-"));
  const dest = join(dir, "g.wasm");
  const fakeFetch = /** @type {typeof fetch} */ (async () => new Response(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])));
  await assert.rejects(fetchSwiftGrammar({ dest, fetchImpl: fakeFetch }), /checksum mismatch/);
  assert.equal(existsSync(dest), false);
  assert.throws(() => checksumMatches(new Uint8Array(), ""), /no valid SHA-256/);
  const bad = /** @type {typeof fetch} */ (async () => new Response("nope", { status: 404 }));
  await assert.rejects(fetchSwiftGrammar({ dest, fetchImpl: bad }), /HTTP 404/);
});

test("fetch accepts bytes matching the pin and then reuses the cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mh-fetch-"));
  const dest = join(dir, "g.wasm");
  const bytes = new TextEncoder().encode("pinned bytes");
  const real = createHash("sha256").update(bytes).digest("hex");
  let calls = 0;
  const ok = /** @type {typeof fetch} */ (async () => (calls++, new Response(bytes)));
  assert.equal(await fetchSwiftGrammar({ dest, sha256: real, fetchImpl: ok }), "downloaded");
  assert.equal(await fetchSwiftGrammar({ dest, sha256: real, fetchImpl: ok }), "cached");
  assert.equal(calls, 1);
});
