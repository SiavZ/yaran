/**
 * Test helpers for the release-train suites: build a throwaway repo tree from a map of
 * files, and capture a CLI's output lines.
 *
 * - Writes only under the OS temp directory.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:fs, node:os, node:path
 *
 * Used by:
 * test/helpers.mjs
 * ├── test/association.test.mjs
 * ├── test/check-versions.test.mjs
 * ├── test/deploy-tree.test.mjs
 * ├── test/licenses.test.mjs
 * └── test/release-manifest.test.mjs
 * <module-headers:end>
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Writes `{ "rel/path": "content" | object }` under a new temp dir and returns it. */
export function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-trains-"));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

/** Returns `{ log, lines, text() }` for passing as a CLI's logger. */
export function capture() {
  const lines = [];
  return { lines, log: (l) => lines.push(String(l)), text: () => lines.join("\n") };
}

export const GOOD_CERT = "a1".repeat(32);
export const OTHER_CERT = "b2".repeat(32);

/** A minimal mobile project at versions 0.0.0 / 1, with the toolchain pins it must match. */
export function mobileFiles({ nseVersion = "1.0", sdk = 36, deployment = "17.4" } = {}) {
  const config = (marketing) => `\t\t\tbuildSettings = {\n\t\t\t\tCURRENT_PROJECT_VERSION = 1;\n\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = ${deployment};\n\t\t\t\tMARKETING_VERSION = ${marketing};\n\t\t\t};\n`;
  return {
    "mobile/android/app/build.gradle.kts": `android {\n    compileSdk = ${sdk}\n    defaultConfig {\n        targetSdk = ${sdk}\n        versionCode = 1\n        versionName = "0.0.0"\n    }\n}\n`,
    "mobile/ios/App/App.xcodeproj/project.pbxproj": `/* App */\n${config("1.0")}${config("1.0")}/* NotificationService */\n${config(nseVersion)}${config(nseVersion)}`,
    "mobile/app/package.json": { name: "yaran-app", version: "0.0.0", private: true },
    "mobile/toolchain.env": "# pins\nANDROID_COMPILE_SDK=36\nANDROID_TARGET_SDK=36\nIOS_DEPLOYMENT_TARGET=17.4\n",
  };
}

/** Publisher values that agree with each other (a real domain, a real app id). */
export function publisherFiles(domain = "yaran.example.org", { propsDomain = domain, xcDomain = domain, appId = "org.example.yaran" } = {}) {
  return {
    "publisher.json": { $comment: "test", publisher_domain: domain },
    "mobile/publisher.properties": `appId=${appId}\nappleTeamId=ABCDE12345\npublisherDomain=${propsDomain}\nrelayUrl=https://relay.example.org\nplayPushTransport=relay-fcm\n`,
    "mobile/ios/App/Config/Publisher.xcconfig": `// generated\nPUBLISHER_DOMAIN = ${xcDomain}\nAPP_ID = ${appId}\n`,
  };
}
