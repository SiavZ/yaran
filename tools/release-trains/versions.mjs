#!/usr/bin/env node
/**
 * Release-train tag parser: the one place a `yaran-cloud-v*` or `yaran-mobile-v*` tag
 * becomes a version, a prerelease flag and an Android versionCode.
 *
 * Both new trains (D15) share this parser so the workflows, `check-versions.mjs` and
 * `bump.mjs` cannot disagree about what a tag means. The versionCode scheme leaves room
 * for release candidates and keeps codes monotonic: `1.2.3-rc.1` < `1.2.3` < `1.3.0-rc.1`.
 *
 * - Pure functions plus a CLI; no file or network access.
 * - The CLI prints `key=value` lines meant for `$GITHUB_OUTPUT`.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:url
 *
 * Used by: entry point (CLI: node tools/release-trains/versions.mjs <tag> >> $GITHUB_OUTPUT, in release-cloud.yml, release-mobile.yml, _fdroid-verify.yml and mobile-store-promote.yml)
 * versions.mjs
 * ├── bump.mjs
 * ├── check-deploy-tree.mjs
 * ├── check-versions.mjs
 * ├── release-manifest.mjs
 * └── test/versions.test.mjs
 * <module-headers:end>
 */

import { fileURLToPath } from "node:url";

const TAG = /^yaran-(cloud|mobile)-v(\d+)\.(\d+)\.(\d+)(-rc\.(\d+))?$/;
const MAX_VERSION_CODE = 2_100_000_000;

/** Parses a release-train tag; throws with a readable message on anything else. */
export function parseTag(tag) {
  const m = TAG.exec(String(tag ?? ""));
  if (!m) {
    throw new Error(`"${tag}" is not a release-train tag (expected yaran-cloud-vX.Y.Z[-rc.N] or yaran-mobile-vX.Y.Z[-rc.N])`);
  }
  const [major, minor, patch] = [m[2], m[3], m[4]].map(Number);
  const rc = m[6] === undefined ? null : Number(m[6]);
  const base = `${major}.${minor}.${patch}`;
  return {
    train: m[1],
    major,
    minor,
    patch,
    rc,
    version: rc === null ? base : `${base}-rc.${rc}`,
    base,
    prerelease: rc !== null,
  };
}

/** Android versionCode (and iOS CFBundleVersion): X*1e6 + Y*1e4 + Z*100 + (rc ? N : 99). */
export function versionCode(v) {
  if (v.minor > 99) throw new Error(`minor version ${v.minor} exceeds 99, which the versionCode scheme cannot encode`);
  if (v.patch > 99) throw new Error(`patch version ${v.patch} exceeds 99, which the versionCode scheme cannot encode`);
  if (v.rc !== null && (v.rc < 1 || v.rc > 98)) throw new Error(`release candidate number ${v.rc} must be between 1 and 98`);
  const code = v.major * 1_000_000 + v.minor * 10_000 + v.patch * 100 + (v.rc === null ? 99 : v.rc);
  if (code > MAX_VERSION_CODE) throw new Error(`versionCode ${code} exceeds Play's limit of ${MAX_VERSION_CODE}`);
  return code;
}

/** Parses `X.Y.Z[-rc.N]` (no prefix) into the parseTag shape minus train. */
export function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(-rc\.(\d+))?$/.exec(String(text ?? ""));
  if (!m) throw new Error(`"${text}" is not a version of the form X.Y.Z[-rc.N]`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), rc: m[5] === undefined ? null : Number(m[5]) };
}

/** Semver order for X.Y.Z[-rc.N]: a release candidate sorts before its release. */
export function compareVersions(a, b) {
  const pa = typeof a === "string" ? parseVersion(a) : a;
  const pb = typeof b === "string" ? parseVersion(b) : b;
  for (const k of ["major", "minor", "patch"]) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (pa.rc === pb.rc) return 0;
  if (pa.rc === null) return 1;
  if (pb.rc === null) return -1;
  return pa.rc < pb.rc ? -1 : 1;
}

function main(argv) {
  const tag = argv[0];
  if (!tag || argv.length !== 1) {
    console.error("usage: node tools/release-trains/versions.mjs <tag>");
    return 2;
  }
  try {
    const v = parseTag(tag);
    const lines = [
      `train=${v.train}`,
      `version=${v.version}`,
      `base=${v.base}`,
      `prerelease=${v.prerelease}`,
      `version_code=${versionCode(v)}`,
    ];
    console.log(lines.join("\n"));
    return 0;
  } catch (err) {
    console.error(`versions: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
