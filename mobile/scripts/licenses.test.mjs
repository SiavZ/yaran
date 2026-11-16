/**
 * Tests for the native license list builders used by licenses.sh.
 *
 * - Hermetic: manifests and AboutLibraries documents are inline fixtures.
 *
 * <module-headers:begin>
 * Uses:
 * mobile/scripts/licenses.test.mjs
 * ├── mobile/scripts/android-licenses.mjs
 * └── mobile/scripts/ios-licenses.mjs
 * External: node:assert/strict, node:fs, node:os, node:path, node:test
 *
 * Used by: entry point (node --test mobile/scripts/<name>.test.mjs)
 * <module-headers:end>
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { convertAboutLibraries } from './android-licenses.mjs';
import { iosLicenseList, remoteDependencies } from './ios-licenses.mjs';

test('remote Swift dependencies are read with their pins; local paths are not', () => {
  const text = '.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.6.2"),\n.package(path: "../core/ios")';
  assert.deepEqual(remoteDependencies(text), [{ url: 'https://github.com/ionic-team/capacitor-swift-pm.git', version: '8.6.2' }]);
});

test('the highest version across manifests wins and unknown packages fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-'));
  const a = join(dir, 'a.swift');
  const b = join(dir, 'b.swift');
  writeFileSync(a, '.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")');
  writeFileSync(b, '.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.10.1")');
  assert.deepEqual(iosLicenseList([a, b]).entries, [{ name: 'Capacitor', version: '8.10.1', license: 'MIT' }]);
  writeFileSync(b, '.package(url: "https://github.com/someone/else.git", exact: "1.0.0")');
  assert.throws(() => iosLicenseList([a, b]), /no reviewed license/);
});

test('AboutLibraries output converts to the shared shape', () => {
  const doc = {
    libraries: [
      { uniqueId: 'androidx.core:core', artifactVersion: '1.17.0', licenses: ['Apache-2.0'] },
      { uniqueId: 'a:b', artifactVersion: '1', licenses: [] },
    ],
    licenses: { 'Apache-2.0': { name: 'Apache License 2.0', spdxId: 'Apache-2.0' } },
  };
  assert.deepEqual(convertAboutLibraries(doc).entries, [
    { name: 'a:b', version: '1', license: 'UNKNOWN' },
    { name: 'androidx.core:core', version: '1.17.0', license: 'Apache-2.0' },
  ]);
});
