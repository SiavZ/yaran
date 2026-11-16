/**
 * Runs every shared host-rules case against the TS twin.
 *
 * - The same fixture is read by the Kotlin and Swift core suites.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/hostRules.test.ts
 * ├── mobile/plugins/core/fixtures/host-rules-cases.json
 * └── src/lib/hostRules.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { describe, expect, it } from 'vitest';

import fixture from '../../../plugins/core/fixtures/host-rules-cases.json' with { type: 'json' };
import { hostname, orgUrl, type HostResult } from './hostRules.ts';

type Case = { input: string; expect: { ok: string } | { refused: string } };
const asResult = (e: Case['expect']): HostResult => ('ok' in e ? { ok: true, value: e.ok } : { ok: false, refused: e.refused as never });

describe('host rules fixture', () => {
  for (const c of fixture.orgUrl as Case[]) {
    it(`orgUrl ${JSON.stringify(c.input)}`, () => expect(orgUrl(c.input)).toEqual(asResult(c.expect)));
  }
  for (const c of fixture.host as Case[]) {
    it(`host ${JSON.stringify(c.input)}`, () => expect(hostname(c.input)).toEqual(asResult(c.expect)));
  }
});
