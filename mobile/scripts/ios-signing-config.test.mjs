/**
 * The iOS app and its Notification Service Extension agree on what they are signed with.
 *
 * Both entitlements files of the app and the extension's grant the one app group both
 * Info.plists name as `YaranAppGroup`, because the extension reads the push keys from the
 * keychain group the app wrote them to; the app declares `aps-environment` (development, which
 * export re-signs to production) and the remote-notification background mode its cleared-event
 * handler needs; and nothing reads an APNs environment from build config any more.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:assert/strict, node:fs, node:path, node:test, node:url
 *
 * Used by: entry point (node --test mobile/scripts/<name>.test.mjs)
 * <module-headers:end>
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(MOBILE, 'ios', 'App');
const read = (path) => readFileSync(join(APP, path), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const strings = (plist, key) => {
  const m = plist.match(new RegExp(`<key>${key}</key>\\s*(<array>[\\s\\S]*?</array>|<string>[^<]*</string>)`));
  return m ? [...m[1].matchAll(/<string>([^<]*)<\/string>/g)].map((s) => s[1]) : [];
};

const APP_ENTITLEMENTS = ['App/App.entitlements', 'App/App+Publisher.entitlements'];

test('the extension is granted the same app group the app and both Info.plists use', () => {
  const group = strings(read('App/Info.plist'), 'YaranAppGroup');
  assert.deepEqual(group, ['group.$(APP_ID)']);
  assert.deepEqual(strings(read('NotificationService/Info.plist'), 'YaranAppGroup'), group);
  assert.deepEqual(strings(read('NotificationService/NotificationService.entitlements'), 'com.apple.security.application-groups'), group);
  for (const file of APP_ENTITLEMENTS) assert.deepEqual(strings(read(file), 'com.apple.security.application-groups'), group, file);
});

test('the app can receive APNs pushes, alert and background', () => {
  for (const file of APP_ENTITLEMENTS) assert.deepEqual(strings(read(file), 'aps-environment'), ['development'], file);
  assert.ok(strings(read('App/Info.plist'), 'UIBackgroundModes').includes('remote-notification'));
});

test('the APNs environment comes from the signed entitlement, not from build config', () => {
  const config = readFileSync(join(MOBILE, 'plugins', 'push', 'ios', 'Sources', 'PushPlugin', 'PushPlugin.swift'), 'utf8');
  assert.doesNotMatch(config, /"YaranApnsEnvironment"/);
  assert.match(config, /ApnsEnvironment\.resolve\(\s*embeddedProfile: bundle\.url\(forResource: "embedded", withExtension: "mobileprovision"\)/);
});
