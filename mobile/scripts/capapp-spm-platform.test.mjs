/**
 * Tests for the CapApp-SPM platform pin and its `cap sync` hook.
 *
 * Pins a Capacitor 8.6.2-shaped generated package (`.iOS(.v17)`) to the Xcode project's 17.4,
 * proves it is idempotent and fails on a missing platform line or a mixed deployment target,
 * checks that mobile/app wires it as the `capacitor:update:after` hook, and that the result
 * covers every local plugin package's iOS minimum.
 *
 * - Hermetic: the run test works on temp copies; the real files are only read.
 *
 * <module-headers:begin>
 * Uses:
 * mobile/scripts/capapp-spm-platform.test.mjs
 * └── mobile/scripts/capapp-spm-platform.mjs
 * External: node:assert/strict, node:fs, node:os, node:path, node:test, node:url
 *
 * Used by: entry point (node --test mobile/scripts/<name>.test.mjs)
 * <module-headers:end>
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PATHS, deploymentTarget, pinPlatform, run } from './capapp-spm-platform.mjs';

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..');

// What `cap sync ios` writes (Capacitor CLI 8.6.2, util/spm.js generatePackageText).
const GENERATED = `// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v17)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.6.2"),
        .package(name: "YaranMachineView", path: "../../../app/node_modules/@yaran/machine-view")
    ],
    targets: []
)
`;

test('the generated major-only platform becomes the exact deployment target, idempotently', () => {
  const pinned = pinPlatform(GENERATED, '17.4');
  assert.match(pinned, /platforms: \[\.iOS\("17\.4"\)\],/);
  assert.equal(pinned.replace('.iOS("17.4")', '.iOS(.v17)'), GENERATED);
  assert.equal(pinPlatform(pinned, '17.4'), pinned);
});

test('a missing platform line or a mixed deployment target fails loudly', () => {
  assert.throws(() => pinPlatform('let package = Package(name: "CapApp-SPM")', '17.4'), /no `platforms/);
  assert.throws(() => deploymentTarget('IPHONEOS_DEPLOYMENT_TARGET = 17.4;\nIPHONEOS_DEPLOYMENT_TARGET = 17.0;'), /expected one/);
  assert.throws(() => deploymentTarget(''), /found none/);
});

test('run rewrites the package from the project target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'capapp-'));
  const paths = { pbxproj: join(dir, 'project.pbxproj'), packageSwift: join(dir, 'Package.swift') };
  writeFileSync(paths.pbxproj, readFileSync(PATHS.pbxproj, 'utf8'));
  writeFileSync(paths.packageSwift, GENERATED);
  assert.equal(run(paths), '17.4');
  assert.match(readFileSync(paths.packageSwift, 'utf8'), /\.iOS\("17\.4"\)/);
});

test('mobile/app runs the pin after every cap update and sync', () => {
  const scripts = JSON.parse(readFileSync(join(MOBILE, 'app', 'package.json'), 'utf8')).scripts;
  assert.equal(scripts['capacitor:update:after'], 'node ../scripts/capapp-spm-platform.mjs');
});

test('the pinned target covers every local plugin package iOS minimum', () => {
  const target = deploymentTarget(readFileSync(PATHS.pbxproj, 'utf8'));
  const version = (v) => v.split('.').map(Number).reduce((a, n, i) => a + n / 100 ** i, 0);
  for (const pkg of ['plugins/machine-view', 'plugins/push', 'plugins/secure-store', 'plugins/core/ios']) {
    const text = readFileSync(join(MOBILE, pkg, 'Package.swift'), 'utf8');
    const [, quoted, major] = text.match(/\.iOS\((?:"([0-9.]+)"|\.v([0-9]+))\)/);
    assert.ok(version(quoted ?? major) <= version(target), `${pkg} needs iOS ${quoted ?? major}, above CapApp-SPM's ${target}`);
  }
});
