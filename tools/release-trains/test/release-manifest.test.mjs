/**
 * Tests for release-manifest.mjs: the manifest written for a fixture tarball validates
 * against @yaran/protocol's ReleaseManifest schema and names that tarball's SHA-256.
 * Needs `npm ci` in cloud/protocol (the protocol suite and the release job both run it).
 *
 * <module-headers:begin>
 * Uses:
 * test/release-manifest.test.mjs
 * ├── release-manifest.mjs
 * └── test/helpers.mjs
 * External: node:assert/strict, node:crypto, node:fs, node:path, node:test
 *
 * Used by: entry point (node --test 'tools/release-trains/test/*.test.mjs', via npm test in tools/release-trains and the gates.yml release-trains job)
 * <module-headers:end>
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { protocolRange, run, validateManifest } from "../release-manifest.mjs";
import { capture, makeTree } from "./helpers.mjs";

const base = (dir) => [
  "--tag", "yaran-cloud-v1.2.0",
  "--tarball", path.join(dir, "yaran-cloud-worker-v1.2.0.tar.gz"),
  "--url", "https://github.com/SiavZ/yaran/releases/download/yaran-cloud-v1.2.0/yaran-cloud-worker-v1.2.0.tar.gz",
  "--notes-url", "https://github.com/SiavZ/yaran/releases/tag/yaran-cloud-v1.2.0",
  "--min-update-from", "1.0.0",
  "--released-at", "2026-11-14T12:00:00Z",
  "--out", path.join(dir, "release.json"),
];

test("release.json for a fixture tarball validates and names its hash", async () => {
  const dir = makeTree({ "yaran-cloud-worker-v1.2.0.tar.gz": "not really a tarball, but bytes are bytes" });
  const out = capture();
  assert.equal(await run(base(dir), out.log), 0, out.text());
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "release.json"), "utf8"));
  const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, "yaran-cloud-worker-v1.2.0.tar.gz"))).digest("hex");
  assert.equal(manifest.tarball.sha256, sha);
  assert.equal(manifest.train, "yaran-cloud");
  assert.deepEqual(manifest.protocol, protocolRange());
  assert.equal((await validateManifest(manifest)).valid, true);
});

test("an invalid manifest is refused and nothing is written", async () => {
  const dir = makeTree({ "yaran-cloud-worker-v1.2.0.tar.gz": "x" });
  const args = base(dir);
  args[args.indexOf("--url") + 1] = "http://insecure.example/x.tar.gz";
  const out = capture();
  assert.equal(await run(args, out.log), 1);
  assert.match(out.text(), /does not validate against ReleaseManifest/);
  assert.equal(fs.existsSync(path.join(dir, "release.json")), false);
});

test("a mobile tag is refused", async () => {
  const dir = makeTree({ "yaran-cloud-worker-v1.2.0.tar.gz": "x" });
  const args = base(dir);
  args[1] = "yaran-mobile-v1.2.0";
  const out = capture();
  assert.equal(await run(args, out.log), 1);
  assert.match(out.text(), /is not a yaran-cloud-v\* tag/);
});
