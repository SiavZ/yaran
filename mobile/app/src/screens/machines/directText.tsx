/**
 * The words for every direct-machine answer: a status probe that failed, a password sign-in
 * that did not end signed in, and a window closed because the machine's yaran is too old for
 * the app (`upgrade_required`; it says to update that machine and never removes anything).
 *
 * - Exhaustive over `DirectStatus` failures and `DirectSignInOutcome`; a new native variant
 *   fails to compile here.
 * - A machine's own `message` is untrusted text (native bounds it); it renders as React text.
 * - `rejected` is the shell's own case for a native call that rejected instead of answering:
 *   its code is shown as it is, never relabelled as a lock.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/directText.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── src/lib/assertNever.ts
 * └── src/lib/native/machineView.ts
 * External: @lingui/react, react
 *
 * Used by:
 * src/screens/machines/directText.tsx
 * ├── src/App.tsx
 * ├── src/screens/machines/DirectCheck.tsx
 * ├── src/screens/machines/DirectSection.tsx
 * ├── src/screens/machines/InstanceChangedDialog.tsx
 * └── src/screens/machines/MachineRoutes.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { InlineCode } from '@yaran/ui-kit/inline-code';
import type { ReactNode } from 'react';

import { assertNever } from '../../lib/assertNever.ts';
import type { DirectSignInOutcome, DirectStatus } from '../../lib/native/machineView.ts';

export type Rejected = { kind: 'rejected'; code: string };
export type ProbeFailure = Exclude<DirectStatus, { kind: 'yaran' }> | Rejected;
export type SignInFailure = Exclude<DirectSignInOutcome, { kind: 'signed_in' } | { kind: 'not_required' }> | Rejected;

export interface Said {
  text: ReactNode;
  /** Whether trying the same thing again can help. */
  retry: boolean;
}

export function probeFailureText(f: ProbeFailure, host: string): Said {
  const chip = <InlineCode>{host}</InlineCode>;
  switch (f.kind) {
    case 'not_yaran':
      return { text: <Trans>{chip} answered, but not like yaran. Check the address.</Trans>, retry: true };
    case 'access_required':
      return { text: <Trans>{chip} is behind Cloudflare Access. Add it through its organization instead.</Trans>, retry: false };
    case 'redirected':
      return { text: <Trans>{chip} sent the app somewhere else, so it stopped. Use the address yaran answers on directly.</Trans>, retry: true };
    case 'offline':
      return { text: <Trans>No connection to {chip}. Check your network and try again.</Trans>, retry: true };
    case 'tls_error':
      return { text: <Trans>The connection to {chip} isn't secure, so the app stopped.</Trans>, retry: false };
    case 'vault_locked':
      return { text: <Trans>Unlock the app, then try again.</Trans>, retry: true };
    case 'upgrade_required':
      // Retrying helps once that machine runs a newer yaran; nothing was kept, so nothing is lost.
      return { text: <Trans>The yaran on {chip} is too old for this app to sign in to it or show it. Update yaran on that machine, then try again.</Trans>, retry: true };
    case 'refused':
      switch (f.reason) {
        case 'invalid_host':
          return { text: <Trans>The app refused {chip}: it isn't an address the app can use.</Trans>, retry: false };
        case 'org_host':
          return { text: <Trans>{chip} belongs to an org on this phone. Open it from that org instead.</Trans>, retry: false };
        case 'response_too_large':
        case 'not_json':
          return { text: <Trans>{chip} answered, but not like yaran. Check the address.</Trans>, retry: true };
        default:
          return assertNever(f.reason);
      }
    case 'rejected': {
      const code = <InlineCode>{f.code}</InlineCode>;
      return { text: <Trans>The app couldn't reach {chip} ({code}). Try again; if it keeps happening, send diagnostics from Settings.</Trans>, retry: true };
    }
    default:
      return assertNever(f);
  }
}

/** The toast for a window closed with `upgrade_required`; `host` is the machine, when native names it. */
export function upgradeRequiredClosed(host: string | undefined): ReactNode {
  if (!host) return <Trans>That machine's yaran is too old for this app to show it, so its window closed. Update yaran on that machine, then open it again.</Trans>;
  const chip = <InlineCode>{host}</InlineCode>;
  return <Trans>The yaran on {chip} is too old for this app to show it, so its window closed. Update yaran on that machine, then open it again.</Trans>;
}

export function signInFailureText(f: SignInFailure, host: string): Said {
  const chip = <InlineCode>{host}</InlineCode>;
  switch (f.kind) {
    case 'cancelled':
      return { text: <Trans>Sign-in was cancelled.</Trans>, retry: true };
    case 'wrong_password':
      return { text: f.message || <Trans>That password isn't right.</Trans>, retry: true };
    case 'rate_limited':
      return { text: f.message || <Trans>Too many attempts. Wait, then try again.</Trans>, retry: true };
    case 'no_password': {
      const command = <InlineCode>yaran config set server.auth.password</InlineCode>;
      return { text: <Trans>{chip} has no password yet. Set one there with {command}, then try again.</Trans>, retry: true };
    }
    case 'server_refused': {
      const code = <InlineCode>{f.code}</InlineCode>;
      return { text: <>{f.message ? `${f.message} ` : null}<Trans>({chip} refused the sign-in: {code}.)</Trans></>, retry: true };
    }
    case 'secure_storage_failed':
      return {
        text: <Trans>This phone's secure storage couldn't save the sign-in to {chip}, so the machine ended it again. Try again; if it keeps failing, restart the phone.</Trans>,
        retry: true,
      };
    case 'not_yaran':
    case 'access_required':
    case 'redirected':
    case 'offline':
    case 'tls_error':
    case 'vault_locked':
    case 'upgrade_required':
    case 'refused':
      return probeFailureText(f, host);
    case 'rejected': {
      const code = <InlineCode>{f.code}</InlineCode>;
      return { text: <Trans>The app couldn't show the sign-in for {chip} ({code}). Try again; if it keeps happening, send diagnostics from Settings.</Trans>, retry: true };
    }
    default:
      return assertNever(f);
  }
}
