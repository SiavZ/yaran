/**
 * Package entry of `@yaran/qr`: the scanner, the payload parser and the bundled-wasm hook.
 *
 * - The shell imports only this root.
 *
 * <module-headers:begin>
 * Uses:
 * src/index.ts
 * ├── src/payload.ts
 * ├── src/scanner.ts
 * └── src/wasm.ts
 * External: none
 *
 * Used by:
 * src/index.ts
 * ├── @yaran/mobile-shell:src/screens/onboarding/ScanQr.tsx
 * └── @yaran/mobile-shell:src/screens/onboarding/onboarding.test.tsx
 * <module-headers:end>
 */
export { parseAddOrgPayload, type AddOrgPayload } from './payload.ts';
export { ScanError, startScan, type ScanFailure, type ScanHandle } from './scanner.ts';
export { prepareBundledReader, readerWasmUrl } from './wasm.ts';
