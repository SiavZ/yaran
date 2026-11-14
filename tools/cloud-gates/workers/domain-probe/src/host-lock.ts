/**
 * Host lock for gate G14: which Host and path may reach the Worker before and after setup closes.
 *
 * Phase 04/07 will ship this rule: while setup is open the Worker is reached on its
 * workers.dev URL and answers only the setup wizard and /v1/meta; once setup closes, only the
 * recorded custom domain is served and every other Host (workers.dev included) gets
 * 421 misdirected_host. The probe implements the same rule so G14 step 8 can measure it.
 *
 * - The 421 message names no host, so a misdirected caller learns nothing about the real one.
 * - Hosts compare case-insensitively with any port stripped.
 * - While open, a Host that is neither workers.dev nor the custom host gets the workers.dev
 *   restriction (setup and meta only), the conservative reading of the rule.
 * - Pure: no I/O, unit-tested in Node.
 *
 * <module-headers:begin>
 * Uses:
 * src/host-lock.ts
 * External: (none)
 *
 * Used by:
 * src/host-lock.ts
 * ├── src/index.ts
 * └── test/host-lock.test.ts
 * <module-headers:end>
 */

export type SetupState = 'open' | 'closed';

export type LockVerdict =
  | { allow: true }
  | { allow: false; status: 404; code: 'not_found'; message: string }
  | { allow: false; status: 410; code: 'setup_closed'; message: string }
  | { allow: false; status: 421; code: 'misdirected_host'; message: string };

const normalize = (host: string): string => host.trim().toLowerCase().replace(/:\d+$/, '');

export const isSetupPath = (pathname: string): boolean => pathname === '/setup' || pathname.startsWith('/setup/');

export function hostLock(host: string, pathname: string, state: SetupState, cpHost: string): LockVerdict {
  const onCustomHost = normalize(host) === normalize(cpHost);
  const setupOrMeta = isSetupPath(pathname) || pathname === '/v1/meta';
  switch (state) {
    case 'open':
      if (onCustomHost || setupOrMeta) return { allow: true };
      return {
        allow: false,
        status: 404,
        code: 'not_found',
        message: 'Until setup is finished this address serves only the setup wizard and /v1/meta.',
      };
    case 'closed':
      if (!onCustomHost) {
        return {
          allow: false,
          status: 421,
          code: 'misdirected_host',
          message: 'This Worker does not serve requests for this hostname. Use the control-plane address you configured.',
        };
      }
      if (isSetupPath(pathname)) {
        return { allow: false, status: 410, code: 'setup_closed', message: 'Setup is already finished and cannot be run again.' };
      }
      return { allow: true };
  }
}

/** Reads the SETUP_STATE var. Anything but exactly "open" fails closed, the safe side of a typo. */
export const parseSetupState = (raw: string | undefined): SetupState => (raw === 'open' ? 'open' : 'closed');
