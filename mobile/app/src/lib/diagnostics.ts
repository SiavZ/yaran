/**
 * The shell's diagnostics logger: forwards lines to the native sanitized log.
 *
 * The native core sanitizes every entry (query strings, JWT-shaped strings, cookie and
 * authorization values, terminal escapes) before keeping it; this wrapper only makes logging
 * fire-and-forget so a failing log never breaks a screen.
 *
 * - Never throws; never logs from inside its own error path.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/diagnostics.ts
 * └── @yaran/secure-store:src/index.ts
 * External: none
 *
 * Used by:
 * src/lib/diagnostics.ts
 * ├── src/lib/api.ts
 * ├── src/lib/deepLinks.ts
 * ├── src/lib/diagnostics.test.ts
 * ├── src/lib/lifecycle.ts
 * └── src/lib/orgStore.ts
 * <module-headers:end>
 */
import { Diagnostics, type DiagnosticsLevel } from '@yaran/secure-store';

export function log(level: DiagnosticsLevel, message: string): void {
  Diagnostics.append({ level, message }).catch(() => {});
}
