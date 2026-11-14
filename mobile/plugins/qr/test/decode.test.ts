/**
 * Decode test: a QR code carrying an add-org payload round-trips through zxing-wasm.
 *
 * The image is rendered by zxing's own writer at test time (no binary fixture), then read
 * back by the reader build the app ships, restricted to QR codes, and parsed.
 *
 * - Loads both wasm binaries from node_modules through `instantiateWasm`; no network.
 *
 * <module-headers:begin>
 * Uses:
 * test/decode.test.ts
 * └── src/payload.ts
 * External: node:fs, node:module, vitest, zxing-wasm
 *
 * Used by: entry point (vitest, via npm test in the plugin package)
 * <module-headers:end>
 */
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';
import { prepareZXingModule as prepareReader, readBarcodes } from 'zxing-wasm/reader';
import { prepareZXingModule as prepareWriter, writeBarcode } from 'zxing-wasm/writer';

import { parseAddOrgPayload } from '../src/payload.ts';

const require = createRequire(import.meta.url);
const wasm = (name: string) => readFileSync(require.resolve(`zxing-wasm/${name}`));

function instantiateFrom(bytes: Buffer) {
  return {
    instantiateWasm(imports: WebAssembly.Imports, done: (i: WebAssembly.Instance) => void) {
      void WebAssembly.instantiate(new Uint8Array(bytes), imports).then(({ instance }) => done(instance));
      return {};
    },
  };
}

describe('QR decode', () => {
  it('reads back an add-org payload', async () => {
    prepareWriter({ overrides: instantiateFrom(wasm('writer/zxing_writer.wasm')) });
    prepareReader({ overrides: instantiateFrom(wasm('reader/zxing_reader.wasm')) });
    const payload = 'yaranapp://add-org?u=https%3A%2F%2Fcp.example.com';
    const written = await writeBarcode(payload, { format: 'QRCode', scale: 4 });
    expect(written.error).toBe('');
    const png = new Uint8Array(await written.image!.arrayBuffer());
    const [hit] = await readBarcodes(png, { formats: ['QRCode'], maxNumberOfSymbols: 1 });
    expect(hit?.text).toBe(payload);
    expect(parseAddOrgPayload(hit!.text)).toEqual({ ok: true, orgUrl: 'https://cp.example.com' });
  });
});
