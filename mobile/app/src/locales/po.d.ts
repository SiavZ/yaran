/**
 * Type of a `.po` catalog imported through the Lingui Vite plugin.
 *
 * - Ambient declaration only.
 *
 * <module-headers:begin>
 * Uses: none
 * External: @lingui/core
 *
 * Used by: entry point (ambient types read by tsc in mobile/app)
 * <module-headers:end>
 */
declare module '*.po' {
  import type { Messages } from '@lingui/core';
  export const messages: Messages;
}
