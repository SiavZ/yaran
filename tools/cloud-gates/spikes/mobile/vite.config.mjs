/**
 * Vite build config for the gate spike shell.
 *
 * Builds `index.html` + `src/` into `dist/`, which `cap sync` copies into both native
 * projects. Relative base so the bundle loads from the Capacitor scheme on both platforms.
 *
 * - Build-time only; nothing here ships as runtime code.
 *
 * <module-headers:begin>
 * Uses: none
 * External: vite
 *
 * Used by: entry point (read by `vite build`)
 * <module-headers:end>
 */
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
});
