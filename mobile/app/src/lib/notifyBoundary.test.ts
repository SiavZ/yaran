/**
 * The import boundary that keeps `lib/notify.ts` the shell's only toast raiser.
 *
 * Asserted as an exact set, as in the web UI's `notifyBoundary.test.ts`: no production module
 * but `lib/notify.ts` may import sonner (the Toaster component itself lives in the kit). Tests
 * that mock sonner to read its spy are listed by name. A text scan, so it catches accidents,
 * not evasions; review handles the rest.
 *
 * <module-headers:begin>
 * Uses: none
 * External: node:fs, node:path, node:url, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PRODUCTION = ['lib/notify.ts'];
// Each mocks sonner's `toast` to assert which tone a flow raised; none raises a toast itself.
const TESTS = [
  'lib/deepLinks.test.ts',
  'lib/notify.test.ts',
  'screens/machines/machines.test.tsx',
  'screens/settings/settings.test.tsx',
];
const IMPORTS_SONNER = /(?:from\s*|import\(\s*)['"]sonner['"]/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

describe('notify boundary', () => {
  it('only lib/notify.ts raises toasts', () => {
    const importers = walk(SRC)
      .filter((f) => IMPORTS_SONNER.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f).split(sep).join('/'))
      .sort();
    expect(importers.filter((f) => !/\.test\.tsx?$/.test(f))).toEqual(PRODUCTION);
    expect(importers.filter((f) => /\.test\.tsx?$/.test(f))).toEqual([...TESTS].sort());
  });
});
