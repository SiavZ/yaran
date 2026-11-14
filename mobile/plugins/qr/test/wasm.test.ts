/**
 * Proves the reader wasm resolves to the bundled asset and never to a CDN.
 *
 * - `locateZXingFile` sends every `.wasm` request to the bundled URL; the `?url` import is a
 *   local path that Vite emits into `dist/` at build time.
 *
 * <module-headers:begin>
 * Uses:
 * test/wasm.test.ts
 * └── src/wasm.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in the plugin package)
 * <module-headers:end>
 */
import { describe, expect, it } from 'vitest';

import { locateZXingFile, readerWasmUrl } from '../src/wasm.ts';

describe('bundled wasm', () => {
  it('maps the wasm request to the bundled URL', () => {
    expect(locateZXingFile('zxing_reader.wasm', 'https://cdn.example/', '/assets/zxing_reader-abc.wasm')).toBe('/assets/zxing_reader-abc.wasm');
    expect(locateZXingFile('other.js', '/base/', '/x.wasm')).toBe('/base/other.js');
  });
  it('the ?url import is a local wasm path', () => {
    expect(readerWasmUrl).toMatch(/zxing_reader.*\.wasm$/);
    expect(readerWasmUrl).not.toMatch(/^https?:/);
  });
});
