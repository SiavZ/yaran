/**
 * Guards the no-network-from-JS rule (D22, T60): every request is native.
 *
 * Fails on any `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon` in the
 * shell's production sources. A text scan: it catches accidents; review handles evasions.
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
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const FORBIDDEN = /\bfetch\s*\(|XMLHttpRequest|\bWebSocket\b|\bEventSource\b|sendBeacon/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

describe('no network from JS', () => {
  it('production sources never open a connection', () => {
    const offenders = walk(SRC)
      .filter((f) => !f.includes(`${join('src', 'test')}`))
      .filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
