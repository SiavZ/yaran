/**
 * Tests for the bundle license plugin's module-to-package mapping.
 *
 * <module-headers:begin>
 * Uses:
 * src/test/bundleLicenses.test.ts
 * └── scripts/bundleLicenses.d.mts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { describe, expect, it } from 'vitest';

import { packageDirOf } from '../../scripts/bundleLicenses.mjs';

describe('packageDirOf', () => {
  it('maps plain, scoped, nested and query-suffixed ids', () => {
    expect(packageDirOf('/a/node_modules/react/index.js')).toBe('/a/node_modules/react');
    expect(packageDirOf('/a/node_modules/@base-ui/react/esm/x.js')).toBe('/a/node_modules/@base-ui/react');
    expect(packageDirOf('/a/node_modules/@yaran/protocol/node_modules/jose/dist/a.js')).toBe('/a/node_modules/@yaran/protocol/node_modules/jose');
    expect(packageDirOf('\0/a/node_modules/zxing-wasm/reader/zxing_reader.wasm?url')).toBe('/a/node_modules/zxing-wasm');
  });
  it('ignores first-party sources', () => {
    expect(packageDirOf('/repo/mobile/app/src/App.tsx')).toBeNull();
  });
});
