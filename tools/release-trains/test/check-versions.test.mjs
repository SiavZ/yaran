/**
 * Tests for check-versions.mjs and bump.mjs: literal checks (including an NSE whose
 * version disagrees with the App), toolchain pins, the one-Node-pin rule, the publisher,
 * listing-length and Play enrollment gates, and a bump → check round trip.
 *
 * <module-headers:begin>
 * Uses:
 * test/check-versions.test.mjs
 * ├── bump.mjs
 * ├── check-versions.mjs
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
import { run as check } from "../check-versions.mjs";
import { run as bump } from "../bump.mjs";
import { GOOD_CERT, OTHER_CERT, capture, makeTree, mobileFiles, publisherFiles } from "./helpers.mjs";

const TAG = "yaran-mobile-v1.2.3";

function runCheck(root, ...args) {
  const out = capture();
  const status = check([...args, "--root", root], out.log);
  return { status, text: out.text() };
}

function bumped(files) {
  const root = makeTree(files);
  assert.equal(bump([TAG, "--root", root], () => {}), 0);
  return root;
}

test("bump then check round-trips on a fixture tree", () => {
  const root = bumped(mobileFiles());
  const { status, text } = runCheck(root, TAG);
  assert.equal(status, 0, text);
  assert.match(fs.readFileSync(path.join(root, "mobile/android/app/build.gradle.kts"), "utf8"), /versionCode = 1020399[\s\S]*versionName = "1.2.3"/);
  assert.ok(fs.existsSync(path.join(root, "fastlane/metadata/android/en-US/changelogs/1020399.txt")));
});

test("an un-bumped tree fails on every literal", () => {
  const { status, text } = runCheck(makeTree(mobileFiles()), TAG);
  assert.equal(status, 1);
  for (const what of ["versionCode", "versionName", "MARKETING_VERSION", "CURRENT_PROJECT_VERSION", "mobile/app/package.json version", "changelogs/1020399.txt"]) {
    assert.match(text, new RegExp(`FAIL .*${what.replace(/[.*/]/g, "\\$&")}`), what);
  }
});

test("a NotificationService target with a different version fails", () => {
  const root = bumped(mobileFiles());
  const pbx = path.join(root, "mobile/ios/App/App.xcodeproj/project.pbxproj");
  const text = fs.readFileSync(pbx, "utf8");
  const nse = text.indexOf("/* NotificationService */");
  fs.writeFileSync(pbx, text.slice(0, nse) + text.slice(nse).replace(/MARKETING_VERSION = 1\.2\.3;/, "MARKETING_VERSION = 1.2.2;"));
  const res = runCheck(root, TAG);
  assert.equal(res.status, 1);
  assert.match(res.text, /FAIL .*MARKETING_VERSION must be 1\.2\.3 in every target .*1\.2\.2/);
});

test("toolchain pins must match the Gradle SDKs and the iOS deployment target", () => {
  const root = bumped(mobileFiles({ sdk: 35, deployment: "16.0" }));
  const { status, text } = runCheck(root, TAG);
  assert.equal(status, 1);
  assert.match(text, /FAIL  Gradle targetSdk vs mobile\/toolchain.env ANDROID_TARGET_SDK is "35"/);
  assert.match(text, /FAIL  Gradle compileSdk/);
  assert.match(text, /FAIL .*IPHONEOS_DEPLOYMENT_TARGET must be 17\.4/);
});

test("Gradle SDK levels fall back to Capacitor's variables.gradle", () => {
  const files = mobileFiles();
  files["mobile/android/app/build.gradle"] = files["mobile/android/app/build.gradle.kts"]
    .replace(/compileSdk = 36/, "compileSdk rootProject.ext.compileSdkVersion")
    .replace(/targetSdk = 36/, "targetSdkVersion rootProject.ext.targetSdkVersion")
    .replace(/versionCode = 1/, "versionCode 1")
    .replace(/versionName = "0.0.0"/, 'versionName "0.0.0"');
  delete files["mobile/android/app/build.gradle.kts"];
  files["mobile/android/variables.gradle"] = "ext {\n    minSdkVersion = 24\n    compileSdkVersion = 36\n    targetSdkVersion = 36\n}\n";
  const root = bumped(files);
  const { status, text } = runCheck(root, TAG);
  assert.equal(status, 0, text);
  assert.match(fs.readFileSync(path.join(root, "mobile/android/app/build.gradle"), "utf8"), /versionCode 1020399\n\s+versionName "1.2.3"/);
});

test("a .nvmrc under mobile/ fails (one Node pin)", () => {
  const root = bumped({ ...mobileFiles(), "mobile/app/.nvmrc": "22\n" });
  const { status, text } = runCheck(root, TAG);
  assert.equal(status, 1);
  assert.match(text, /FAIL  a second Node pin exists \(mobile\/app\/\.nvmrc\)/);
});

test("--dry-run skips missing files and exits 0; a bad tag still fails", () => {
  const empty = makeTree({ "README.md": "x" });
  const dry = runCheck(empty, "yaran-mobile-v1.0.0-rc.1", "--dry-run");
  assert.equal(dry.status, 0, dry.text);
  assert.match(dry.text, /skip  mobile\/app\/package.json: not present yet/);
  assert.equal(runCheck(empty, "yaran-mobile-v1.0.0-rc.1").status, 1);
  assert.equal(runCheck(empty, "yaran-mobile-v1.100.0", "--dry-run").status, 1);
});

test("cloud tags check every cloud/* package version", () => {
  const root = makeTree({ "cloud/protocol/package.json": { version: "1.0.0" }, "cloud/worker/package.json": { version: "0.9.0" } });
  const bad = runCheck(root, "yaran-cloud-v1.0.0");
  assert.equal(bad.status, 1);
  assert.match(bad.text, /FAIL  cloud\/worker\/package.json version is "0.9.0"/);
  assert.equal(bump(["yaran-cloud-v1.0.0", "--root", root], () => {}), 0);
  assert.equal(runCheck(root, "yaran-cloud-v1.0.0").status, 0);
});

test("--publisher refuses the placeholder in publisher.json", () => {
  const root = makeTree({ "cloud/worker/package.json": { version: "1.0.0" }, "publisher.json": { publisher_domain: "<publisher-domain>" } });
  const { status, text } = runCheck(root, "yaran-cloud-v1.0.0", "--publisher");
  assert.equal(status, 1);
  assert.match(text, /FAIL  publisher.json publisher_domain is "<publisher-domain>"/);
});

test("--publisher passes when every publisher value agrees", () => {
  const root = bumped({ ...mobileFiles(), ...publisherFiles() });
  const { status, text } = runCheck(root, TAG, "--publisher");
  assert.equal(status, 0, text);
});

test("--publisher fails when Phase 14's config disagrees with publisher.json", () => {
  const props = runCheck(bumped({ ...mobileFiles(), ...publisherFiles("yaran.example.org", { propsDomain: "other.example.org" }) }), TAG, "--publisher");
  assert.equal(props.status, 1);
  assert.match(props.text, /FAIL  mobile\/publisher.properties publisherDomain is "other.example.org"/);
  const xc = runCheck(bumped({ ...mobileFiles(), ...publisherFiles("yaran.example.org", { xcDomain: "other.example.org" }) }), TAG, "--publisher");
  assert.equal(xc.status, 1);
  assert.match(xc.text, /FAIL  mobile\/ios\/App\/Config\/Publisher.xcconfig PUBLISHER_DOMAIN/);
  const appId = runCheck(bumped({ ...mobileFiles(), ...publisherFiles("yaran.example.org", { appId: "com.example.yaran" }) }), TAG, "--publisher");
  assert.equal(appId.status, 1);
  assert.match(appId.text, /appId com.example.yaran is the repo default/);
});

test("--metadata flags over-length listing files", () => {
  const root = bumped({
    ...mobileFiles(),
    "fastlane/metadata/android/en-US/title.txt": "yaran\n",
    "fastlane/metadata/android/en-US/short_description.txt": `${"é".repeat(80)}\n`,
    "fastlane/metadata/android/de-DE/full_description.txt": "x".repeat(4001),
    "fastlane/metadata/android/en-US/changelogs/1020300.txt": "y".repeat(501),
  });
  const { status, text } = runCheck(root, TAG, "--metadata");
  assert.equal(status, 1);
  assert.match(text, /ok    fastlane\/metadata\/android\/en-US\/short_description.txt 80\/80/);
  assert.match(text, /FAIL  .*de-DE\/full_description.txt is 4001 characters; F-Droid allows 4000/);
  assert.match(text, /FAIL  .*changelogs\/1020300.txt is 501 characters; F-Droid allows 500/);
});

test("--metadata runs without a tag, as mobile-ci does on every PR", () => {
  const root = bumped({ ...mobileFiles(), "fastlane/metadata/android/en-US/title.txt": "t".repeat(51) });
  const { status, text } = runCheck(root, "--metadata");
  assert.equal(status, 1);
  assert.match(text, /title.txt is 51 characters; F-Droid allows 50/);
  assert.equal(runCheck(root, "--publisher").status, 2);
});

const enrollment = (over = {}) => ({
  package: "org.example.yaran",
  app_signing_cert_sha256: GOOD_CERT,
  upload_cert_sha256: OTHER_CERT,
  enrolled_at: "2026-11-20",
  enrolled_by: "two maintainers",
  ...over,
});

test("--play fails without an enrollment record", () => {
  const { status, text } = runCheck(makeTree(publisherFiles()), "--play");
  assert.equal(status, 1);
  assert.match(text, /play-enrollment.json does not exist/);
});

test("--play fails on a placeholder record and placeholder certificate", () => {
  const root = makeTree({
    ...publisherFiles(),
    "mobile/android/signing/play-enrollment.json": enrollment({ app_signing_cert_sha256: "<app-signing-cert-sha256>" }),
    "mobile/android/signing/app-signing-cert.sha256": "<app-signing-cert-sha256>\n",
  });
  const { status, text } = runCheck(root, "--play");
  assert.equal(status, 1);
  assert.match(text, /app_signing_cert_sha256 is empty or a placeholder/);
  assert.match(text, /app-signing-cert.sha256 holds "<app-signing-cert-sha256>"/);
});

test("--play fails when the enrolled fingerprint differs from the committed one", () => {
  const root = makeTree({
    ...publisherFiles(),
    "mobile/android/signing/play-enrollment.json": enrollment(),
    "mobile/android/signing/app-signing-cert.sha256": `${OTHER_CERT}\n`,
  });
  const { status, text } = runCheck(root, "--play");
  assert.equal(status, 1);
  assert.match(text, /FAIL  .*app_signing_cert_sha256 vs mobile\/android\/signing\/app-signing-cert.sha256/);
});

test("--play passes on a real, agreeing record, even under --dry-run it never softens", () => {
  const good = makeTree({
    ...publisherFiles(),
    "mobile/android/signing/play-enrollment.json": enrollment(),
    "mobile/android/signing/app-signing-cert.sha256": `${GOOD_CERT}\n`,
  });
  assert.equal(runCheck(good, "--play").status, 0);
  assert.equal(runCheck(makeTree(publisherFiles()), "--play", "--dry-run").status, 1);
});
