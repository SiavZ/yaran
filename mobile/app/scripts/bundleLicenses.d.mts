/**
 * Types for the bundle license Vite plugin (a plain .mjs file).
 *
 * - Ambient declaration only.
 *
 * <module-headers:begin>
 * Uses: none
 * External: vite
 *
 * Used by:
 * scripts/bundleLicenses.d.mts
 * ├── src/test/bundleLicenses.test.ts
 * └── vite.config.ts
 * <module-headers:end>
 */
import type { Plugin } from 'vite';

export function packageDirOf(id: string): string | null;
export function bundleLicenses(outFile?: string): Plugin;
