/**
 * Tests for the publisher build-config loader (work item 17, Phase 19 hook H6).
 *
 * Pins the xcconfig keys to the properties keys, the publisher.json → publisherDomain copy
 * (placeholder and absence both mean empty), the entitlements switch on the domain, the
 * xcconfig URL escape, and drift detection in `--check` mode, all against temp copies.
 *
 * - Hermetic: works in a temp directory, never touches the real files.
 *
 * <module-headers:begin>
 * Uses:
 * mobile/scripts/publisher-config.test.mjs
 * └── mobile/scripts/publisher-config.mjs
 * External: node:assert/strict, node:fs, node:os, node:path, node:test
 *
 * Used by: entry point (node --test mobile/scripts/<name>.test.mjs)
 * <module-headers:end>
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PATHS, domainFromPublisherJson, parseProperties, plan, renderXcconfigs, run } from './publisher-config.mjs';

function sandbox(publisherJson) {
  const dir = mkdtempSync(join(tmpdir(), 'pubcfg-'));
  const paths = {
    publisherJson: join(dir, 'publisher.json'),
    properties: join(dir, 'publisher.properties'),
    publisherXcconfig: join(dir, 'Config', 'Publisher.xcconfig'),
    e2eXcconfig: join(dir, 'Config', 'E2E.xcconfig'),
  };
  writeFileSync(paths.properties, readFileSync(PATHS.properties, 'utf8'));
  if (publisherJson !== undefined) writeFileSync(paths.publisherJson, JSON.stringify(publisherJson));
  return paths;
}

test('the placeholder, an empty value and a missing file all mean no publisher domain', () => {
  assert.equal(domainFromPublisherJson(null), '');
  assert.equal(domainFromPublisherJson('{"publisher_domain":"<publisher-domain>"}'), '');
  assert.equal(domainFromPublisherJson('{"publisher_domain":""}'), '');
  assert.equal(domainFromPublisherJson('{"publisher_domain":"apps.example.org"}'), 'apps.example.org');
  assert.throws(() => domainFromPublisherJson('{"publisher_domain":"https://apps.example.org"}'));
});

test('publisherDomain is copied from publisher.json and selects the publisher entitlements', () => {
  const paths = sandbox({ publisher_domain: 'apps.example.org' });
  run({ paths });
  const props = parseProperties(readFileSync(paths.properties, 'utf8'));
  assert.equal(props.get('publisherDomain'), 'apps.example.org');
  const xc = readFileSync(paths.publisherXcconfig, 'utf8');
  assert.match(xc, /^PUBLISHER_DOMAIN = apps\.example\.org$/m);
  assert.match(xc, /^CODE_SIGN_ENTITLEMENTS = App\/App\+Publisher\.entitlements$/m);
  assert.deepEqual(run({ paths, check: true }), []);
});

test('the committed tree is a development build with the plain entitlements', () => {
  const paths = sandbox(undefined);
  const [, [, publisher]] = plan(paths);
  assert.match(publisher, /^PUBLISHER_DOMAIN = $/m);
  assert.match(publisher, /^CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements$/m);
});

test('every non-e2e property becomes a Publisher.xcconfig key and e2e keys reach only E2E', () => {
  const props = parseProperties(readFileSync(PATHS.properties, 'utf8'));
  const { publisher, e2e } = renderXcconfigs(props);
  const toXc = { appId: 'APP_ID', appleTeamId: 'APPLE_TEAM_ID', publisherDomain: 'PUBLISHER_DOMAIN', relayUrl: 'RELAY_URL', playPushTransport: 'PLAY_PUSH_TRANSPORT', 'e2e.controlPlaneUrl': 'E2E_CONTROL_PLANE_URL', 'e2e.relayUrl': 'E2E_RELAY_URL' };
  assert.deepEqual([...props.keys()].sort(), Object.keys(toXc).sort(), 'a new property needs an xcconfig mapping');
  for (const [key, xcKey] of Object.entries(toXc)) {
    const target = key.startsWith('e2e.') ? e2e : publisher;
    const other = key.startsWith('e2e.') ? publisher : e2e;
    assert.match(target, new RegExp(`^${xcKey} = `, 'm'));
    assert.doesNotMatch(other, new RegExp(`^${xcKey} = `, 'm'));
  }
  assert.match(e2e, /^#include "Publisher\.xcconfig"$/m);
});

test('URLs survive the xcconfig comment syntax', () => {
  const { publisher } = renderXcconfigs(new Map([['relayUrl', 'https://relay.example.org']]));
  assert.match(publisher, /^RELAY_URL = https:\/\$\(\)\/relay\.example\.org$/m);
});

test('check mode reports drift and writes nothing', () => {
  const paths = sandbox({ publisher_domain: 'apps.example.org' });
  const before = readFileSync(paths.properties, 'utf8');
  assert.equal(run({ paths, check: true }).length, 3);
  assert.equal(readFileSync(paths.properties, 'utf8'), before);
});

test('duplicate keys are refused', () => {
  assert.throws(() => parseProperties('a=1\na=2\n'), /duplicate/);
});
