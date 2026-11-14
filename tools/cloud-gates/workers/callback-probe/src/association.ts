/**
 * Association files for gate G13: assetlinks.json and apple-app-site-association built from vars.
 *
 * Android App Links and iOS universal links / webcredentials verify an app against files
 * served from the callback host's /.well-known/. The probe generates both from Worker vars
 * so no real team ID, bundle ID or signing-certificate fingerprint is ever committed; the
 * gate script passes the spike's values with --var at deploy time.
 *
 * - The AASA covers exactly /auth/callback and /oauth/callback, the shapes Phase 21 hosts.
 * - Fingerprints are split on commas, trimmed and uppercased; empties are dropped.
 * - Pure: returns plain objects, unit-tested in Node.
 *
 * <module-headers:begin>
 * Uses:
 * src/association.ts
 * External: (none)
 *
 * Used by:
 * src/association.ts
 * ├── src/index.ts
 * └── test/association.test.ts
 * <module-headers:end>
 */

export const CALLBACK_PATHS = ['/auth/callback', '/oauth/callback'] as const;

export function assetLinks(packageName: string, certFingerprintsCsv: string) {
  const fingerprints = certFingerprintsCsv
    .split(',')
    .map((f) => f.trim().toUpperCase())
    .filter(Boolean);
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: packageName, sha256_cert_fingerprints: fingerprints },
    },
  ];
}

export function appleAppSiteAssociation(appId: string) {
  return {
    applinks: { details: [{ appIDs: [appId], components: CALLBACK_PATHS.map((path) => ({ '/': path })) }] },
    webcredentials: { apps: [appId] },
  };
}
