/**
 * Web fallback for the secure-store plugins: every call rejects with `unavailable`.
 *
 * There is no browser build of the app; this exists so Vitest has a registered
 * implementation to mock, and so a stray browser load fails loudly instead of storing
 * secrets in localStorage.
 *
 * - Never stores anything.
 *
 * <module-headers:begin>
 * Uses:
 * src/web.ts
 * └── src/definitions.ts
 * External: @capacitor/core
 *
 * Used by:
 * src/web.ts
 * ├── src/index.ts
 * └── test/contract.test.ts
 * <module-headers:end>
 */
import { CapacitorException, ExceptionCode } from '@capacitor/core';

import type { SecureStoreErrorCode } from './definitions.ts';

const code: SecureStoreErrorCode = 'unavailable';

/** A proxy whose every method rejects, standing in for any of the four plugin objects. */
export const unavailable: unknown = new Proxy(
  {},
  {
    get: (_target, prop) =>
      prop === 'then'
        ? undefined
        : () => Promise.reject(Object.assign(new CapacitorException('secure-store is native only', ExceptionCode.Unavailable), { code })),
  },
);
