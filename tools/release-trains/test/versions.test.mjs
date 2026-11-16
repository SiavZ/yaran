/**
 * Tests for versions.mjs: tag parsing, the versionCode scheme and its bounds, semver
 * order across release candidates, and the CLI's $GITHUB_OUTPUT lines.
 *
 * <module-headers:begin>
 * Uses:
 * test/versions.test.mjs
 * └── versions.mjs
 * External: node:assert/strict, node:child_process, node:test, node:url
 *
 * Used by: entry point (node --test 'tools/release-trains/test/*.test.mjs', via npm test in tools/release-trains and the gates.yml release-trains job)
 * <module-headers:end>
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compareVersions, parseTag, versionCode } from "../versions.mjs";

const code = (tag) => versionCode(parseTag(tag));

test("parses both trains and release candidates", () => {
  assert.deepEqual(parseTag("yaran-mobile-v1.2.3"), { train: "mobile", major: 1, minor: 2, patch: 3, rc: null, version: "1.2.3", base: "1.2.3", prerelease: false });
  const rc = parseTag("yaran-cloud-v0.4.0-rc.7");
  assert.equal(rc.train, "cloud");
  assert.equal(rc.version, "0.4.0-rc.7");
  assert.equal(rc.prerelease, true);
});

test("rejects tags of other trains and malformed tags", () => {
  for (const tag of ["yaran-v1.2.3", "dux-amq-v1.0.0", "yaran-mobile-v1.2", "yaran-mobile-v1.2.3-beta.1", "yaran-mobile-v1.2.3-rc.", ""]) {
    assert.throws(() => parseTag(tag), /not a release-train tag/, tag);
  }
});

test("versionCode for 1.2.3 and the rc ordering", () => {
  assert.equal(code("yaran-mobile-v1.2.3"), 1_020_399);
  assert.equal(code("yaran-mobile-v1.2.3-rc.1"), 1_020_301);
  assert.ok(code("yaran-mobile-v1.2.3-rc.1") < code("yaran-mobile-v1.2.3"));
  assert.ok(code("yaran-mobile-v1.3.0-rc.1") > code("yaran-mobile-v1.2.99"));
  assert.ok(code("yaran-mobile-v1.2.3-rc.98") < code("yaran-mobile-v1.2.3"));
});

test("versionCode rejects out-of-range parts and overflow", () => {
  assert.throws(() => code("yaran-mobile-v1.100.0"), /minor version 100/);
  assert.throws(() => code("yaran-mobile-v1.0.100"), /patch version 100/);
  assert.throws(() => code("yaran-mobile-v1.0.0-rc.99"), /between 1 and 98/);
  assert.throws(() => code("yaran-mobile-v1.0.0-rc.0"), /between 1 and 98/);
  assert.throws(() => code("yaran-mobile-v2101.0.0"), /exceeds Play's limit/);
  assert.equal(code("yaran-mobile-v2099.99.99"), 2_099_999_999);
});

test("compareVersions orders release candidates before their release", () => {
  assert.equal(compareVersions("1.2.3-rc.1", "1.2.3"), -1);
  assert.equal(compareVersions("1.2.3", "1.2.3-rc.9"), 1);
  assert.equal(compareVersions("1.2.3-rc.2", "1.2.3-rc.10"), -1);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("CLI prints GITHUB_OUTPUT lines and fails on a bad tag", () => {
  const cli = fileURLToPath(new URL("../versions.mjs", import.meta.url));
  const ok = spawnSync(process.execPath, [cli, "yaran-mobile-v1.0.0-rc.2"], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, "train=mobile\nversion=1.0.0-rc.2\nbase=1.0.0\nprerelease=true\nversion_code=1000002\n");
  const bad = spawnSync(process.execPath, [cli, "yaran-v1.0.0"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not a release-train tag/);
});
