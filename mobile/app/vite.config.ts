/// <reference types="vitest/config" />
//
// <module-headers:begin>
// Uses:
// vite.config.ts
// └── scripts/bundleLicenses.d.mts
// External: @lingui/vite-plugin, @tailwindcss/vite, @vitejs/plugin-react, vite
//
// Used by: entry point (read by vite/vitest, the Lingui CLI and the Capacitor CLI in mobile/app)
// <module-headers:end>
/**
 * Vite and Vitest config for the phone app shell.
 *
 * Builds `index.html` + `src/` into `dist/`, which `cap sync` copies into both native
 * projects. Lingui macros are transformed natively by the Lingui plugin and `.po` catalogs
 * compile on import. Kit and plugin packages are `file:` symlinks, so symlinks are preserved
 * and every shared peer is deduped to this package's copy (one React, work item 1).
 *
 * - Relative base: the bundle loads from `https://localhost` (Android) and
 *   `capacitor://localhost` (iOS).
 * - The zxing reader wasm is emitted as a hashed asset next to the bundle; no CDN (CSP).
 *
 * <module-headers:begin>
 * Uses:
 * vite.config.ts
 * └── scripts/bundleLicenses.mjs
 * External: @lingui/vite-plugin, @tailwindcss/vite, @vitejs/plugin-react, vite, vitest
 *
 * Used by: entry point (read by `vite build` and `vitest run`)
 * <module-headers:end>
 */
import { lingui } from '@lingui/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { bundleLicenses } from './scripts/bundleLicenses.mjs';

const SHARED_PEERS = [
  'react',
  'react-dom',
  '@base-ui/react',
  '@capacitor/core',
  'class-variance-authority',
  'clsx',
  'lucide-react',
  'sonner',
  'tailwind-merge',
  'zxing-wasm',
  '@yaran/protocol',
];

export default defineConfig({
  base: './',
  plugins: [react(), lingui({ macroTransform: true }), tailwindcss(), bundleLicenses()],
  resolve: { preserveSymlinks: true, dedupe: SHARED_PEERS },
  assetsInclude: ['**/*.wasm'],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
