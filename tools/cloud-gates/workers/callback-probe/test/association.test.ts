/**
 * Association file tests: assetlinks.json and apple-app-site-association have the keys and paths the OSes verify.
 *
 * Round-trips both through JSON (what the Worker serves) and checks the exact structure
 * Android's verifier and Apple's CDN expect, covering /auth/callback and /oauth/callback.
 *
 * - Pure; no Worker runtime.
 *
 * <module-headers:begin>
 * Uses:
 * test/association.test.ts
 * └── src/association.ts
 * External: vitest
 *
 * Used by:
 * test/association.test.ts
 * └── entry point (vitest)
 * <module-headers:end>
 */
import { describe, expect, it } from 'vitest';
import { appleAppSiteAssociation, assetLinks } from '../src/association';

const roundTrip = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe('assetLinks', () => {
  it('names the package and every fingerprint, uppercased', () => {
    const body = roundTrip(assetLinks('invalid.example.gate', 'aa:bb , CC:DD,')) as unknown[];
    expect(body).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: 'invalid.example.gate', sha256_cert_fingerprints: ['AA:BB', 'CC:DD'] },
      },
    ]);
  });
});

describe('appleAppSiteAssociation', () => {
  it('covers both callback paths for applinks and lists webcredentials', () => {
    const body = roundTrip(appleAppSiteAssociation('TEAMID0000.invalid.example.gate')) as {
      applinks: { details: { appIDs: string[]; components: Record<string, string>[] }[] };
      webcredentials: { apps: string[] };
    };
    expect(Object.keys(body).sort()).toEqual(['applinks', 'webcredentials']);
    const [detail] = body.applinks.details;
    expect(detail?.appIDs).toEqual(['TEAMID0000.invalid.example.gate']);
    expect(detail?.components.map((c) => c['/'])).toEqual(['/auth/callback', '/oauth/callback']);
    expect(body.webcredentials.apps).toEqual(['TEAMID0000.invalid.example.gate']);
  });
});
