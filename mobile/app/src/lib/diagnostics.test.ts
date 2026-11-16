/**
 * Tests that diagnostics logging forwards to the native log and never throws.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/diagnostics.test.ts
 * ├── @yaran/secure-store:src/index.ts
 * └── src/lib/diagnostics.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { Diagnostics } from '@yaran/secure-store';
import { describe, expect, it, vi } from 'vitest';

import { log } from './diagnostics.ts';

describe('log', () => {
  it('forwards to Diagnostics.append', () => {
    log('warn', 'machine list refresh failed: offline');
    expect(Diagnostics.append).toHaveBeenCalledWith({ level: 'warn', message: 'machine list refresh failed: offline' });
  });
  it('swallows a native failure', async () => {
    vi.mocked(Diagnostics.append).mockRejectedValueOnce(new Error('unavailable'));
    expect(() => log('error', 'x')).not.toThrow();
    await Promise.resolve();
  });
});
