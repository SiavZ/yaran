/**
 * Capacitor configuration for the yaran phone app shell.
 *
 * Points Capacitor at the native projects beside this package (`../android`, `../ios`) and
 * hardens the one bridge-enabled page (D9): WebView debugging off (the `e2e`/`E2E` variants
 * turn it on natively, Phase 19 hook H4), no mixed content, and SystemBars insets handled in
 * CSS. No `appendUserAgent`: the shell sends no request (CSP `connect-src 'self'`), so the
 * Phase 02 §11 token has no reader here; machine-view (Phase 15) sets it natively.
 *
 * - The app id here is the repo placeholder; the real id comes from
 *   `mobile/publisher.properties` through Gradle and the generated xcconfig (D16).
 * - Plugin registration seam: local plugins are `file:` dependencies in package.json;
 *   `cap sync` writes them into `../android/capacitor.settings.gradle` and the iOS
 *   `CapApp-SPM/Package.swift`. Phase 15 adds `@yaran/machine-view`, Phase 16 `@yaran/push`
 *   the same way; nothing in this file changes for them.
 *
 * <module-headers:begin>
 * Uses: none
 * External: @capacitor/cli
 *
 * Used by: entry point (read by vite/vitest, the Lingui CLI and the Capacitor CLI in mobile/app)
 * <module-headers:end>
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.example.yaran',
  appName: 'yaran',
  webDir: 'dist',
  android: {
    path: '../android',
    flavor: 'foss',
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
  ios: {
    path: '../ios',
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SystemBars: { insetsHandling: 'css' },
  },
};

export default config;
