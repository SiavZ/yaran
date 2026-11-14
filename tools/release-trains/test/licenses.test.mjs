/**
 * Tests for license-allowlist.mjs and swiftpm-licenses.mjs: the deny.toml allowlist is
 * read exactly, emitted for npm and jk1, and the SwiftPM map gate refuses unmapped or
 * disallowed packages.
 *
 * <module-headers:begin>
 * Uses:
 * test/licenses.test.mjs
 * ├── license-allowlist.mjs
 * ├── swiftpm-licenses.mjs
 * └── test/helpers.mjs
 * External: node:assert/strict, node:fs, node:path, node:test
 *
 * Used by: entry point (node --test 'tools/release-trains/test/*.test.mjs', via npm test in tools/release-trains and the gates.yml release-trains job)
 * <module-headers:end>
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseAllowlist, readAllowlist, run as allowlist } from "../license-allowlist.mjs";
import { run as swiftpm, swiftpmInventory } from "../swiftpm-licenses.mjs";
import { capture, makeTree } from "./helpers.mjs";

// The real deny.toml [licenses] allow array (deny.toml:70-96), in file order.
const EXPECTED = [
  "MIT", "Apache-2.0", "Apache-2.0 WITH LLVM-exception", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Zlib",
  "Unicode-DFS-2016", "Unicode-3.0", "MPL-2.0", "CC0-1.0", "0BSD", "OFL-1.1", "Bitstream-Vera", "BSL-1.0",
  "CDLA-Permissive-2.0",
];

test("the repo's deny.toml parses to its allow list", () => {
  assert.deepEqual(readAllowlist(), EXPECTED);
});

test("comments, other tables and other arrays are ignored", () => {
  const text = `[bans]\nallow = ["nope"]\n[licenses]\nprivate = { ignore = true }\nallow = [\n  "MIT", # a comment with "quoted"\n  # "Commented-Out",\n  "ISC",\n]\nexceptions = ["x"]\n[sources]\n`;
  assert.deepEqual(parseAllowlist(text), ["MIT", "ISC"]);
  assert.throws(() => parseAllowlist("[bans]\n"), /no \[licenses\] table/);
});

test("--npm prints the onlyAllow string and --jk1 writes allowed-licenses.json", () => {
  const out = capture();
  assert.equal(allowlist(["--npm"], out.log), 0);
  assert.equal(out.text(), EXPECTED.join(";"));
  const dir = makeTree({});
  const file = path.join(dir, "build", "allowed-licenses.json");
  assert.equal(allowlist(["--jk1", file], () => {}), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).allowedLicenses.map((x) => x.moduleLicense), EXPECTED);
});

const resolved = { version: 3, pins: [{ identity: "swift-log", location: "https://github.com/apple/swift-log", state: { version: "1.6.1" } }, { identity: "gpl-thing", location: "https://example.org/gpl", state: { revision: "abc" } }] };

test("swiftpm gate refuses unmapped and disallowed packages", () => {
  const { problems } = swiftpmInventory(resolved, { "swift-log": { license: "Apache-2.0" } }, EXPECTED);
  assert.deepEqual(problems, ["gpl-thing (https://example.org/gpl) is resolved but missing from the license map"]);
  const bad = swiftpmInventory(resolved, { "swift-log": { license: "Apache-2.0" }, "gpl-thing": { license: "GPL-3.0" } }, EXPECTED);
  assert.deepEqual(bad.problems, ["gpl-thing is GPL-3.0, which deny.toml does not allow"]);
});

test("swiftpm CLI writes the inventory when every pin is mapped and allowed", () => {
  const dir = makeTree({
    "Package.resolved": resolved,
    "map.json": { "swift-log": { license: "Apache-2.0", url: "https://github.com/apple/swift-log" }, "gpl-thing": { license: "MIT" } },
  });
  const out = path.join(dir, "inventory.json");
  assert.equal(swiftpm(["--resolved", path.join(dir, "Package.resolved"), "--map", path.join(dir, "map.json"), "--out", out], () => {}), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")).map((p) => [p.identity, p.version, p.license]), [["swift-log", "1.6.1", "Apache-2.0"], ["gpl-thing", "abc", "MIT"]]);
});
