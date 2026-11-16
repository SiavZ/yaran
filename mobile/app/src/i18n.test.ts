/**
 * i18n completeness: every English message has a translation and the catalog is current.
 *
 * Runs `lingui extract --clean` against a temp copy of the catalog (via LINGUI_CATALOG_PATH)
 * and fails if the copy changes, which means a message was added, changed or removed in the
 * source without `npm run extract`.
 *
 * <module-headers:begin>
 * Uses:
 * src/i18n.test.ts
 * └── src/lib/i18n.ts
 * External: node:child_process, node:fs, node:os, node:path, node:url, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LOCALES } from './lib/i18n.ts';

const APP = join(fileURLToPath(new URL('.', import.meta.url)), '..');

describe('i18n catalog', () => {
  it('has no empty translation in any shipped locale', () => {
    for (const locale of Object.keys(LOCALES)) {
      const po = readFileSync(join(APP, 'src', 'locales', locale, 'messages.po'), 'utf8');
      const empty = po.split('\n\n').filter((block) => /^msgid "(?!")/m.test(block) && /^msgstr ""$/m.test(block) && !/^"/m.test(block.split('msgstr')[1] ?? ''));
      expect(empty).toEqual([]);
    }
  });

  it('is current: extract --clean changes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingui-'));
    for (const locale of Object.keys(LOCALES)) {
      mkdirSync(join(dir, locale), { recursive: true });
      copyFileSync(join(APP, 'src', 'locales', locale, 'messages.po'), join(dir, locale, 'messages.po'));
    }
    execFileSync(join(APP, 'node_modules', '.bin', 'lingui'), ['extract', '--clean', '--workers', '1'], {
      cwd: APP,
      env: { ...process.env, LINGUI_CATALOG_PATH: join(dir, '{locale}', 'messages') },
      stdio: 'pipe',
    });
    for (const locale of Object.keys(LOCALES)) {
      expect(readFileSync(join(dir, locale, 'messages.po'), 'utf8')).toBe(readFileSync(join(APP, 'src', 'locales', locale, 'messages.po'), 'utf8'));
    }
  }, 60_000);
});
