/**
 * Points zxing-wasm's reader at the wasm binary bundled with the app, never a CDN.
 *
 * zxing-wasm fetches its `.wasm` from jsDelivr unless `locateFile` is overridden. The shell's
 * CSP (`connect-src 'self'`) would block that fetch anyway; this makes the bundled asset the
 * only path, resolved by Vite's `?url` import to a hashed file inside `dist/`.
 *
 * - Idempotent: the module is prepared once per page; later calls reuse it.
 *
 * <module-headers:begin>
 * Uses: none
 * External: zxing-wasm
 *
 * Used by:
 * src/wasm.ts
 * ├── src/index.ts
 * ├── src/scanner.ts
 * └── test/wasm.test.ts
 * <module-headers:end>
 */
import { prepareZXingModule } from 'zxing-wasm/reader';
import readerWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

/** The bundled wasm URL for a file Emscripten asks for; everything else stays relative. */
export function locateZXingFile(path: string, prefix: string, wasmUrl: string = readerWasmUrl): string {
  return path.endsWith('.wasm') ? wasmUrl : prefix + path;
}

let prepared = false;

/** Configures the reader module to load the bundled wasm. */
export function prepareBundledReader(): void {
  if (prepared) return;
  prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => locateZXingFile(path, prefix) } });
  prepared = true;
}

export { readerWasmUrl };
