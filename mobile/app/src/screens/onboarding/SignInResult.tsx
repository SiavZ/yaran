/**
 * Sign-in result: one sentence and one action per outcome of Phase 15's handoff matrix.
 *
 * Phase 15's native client runs the sealed handoff; the shell turns its `SignInOutcome` into
 * words. Names (hosts, domains, emails, machines) render as chips.
 *
 * - Exhaustive over `SignInOutcome`; a new variant fails to compile here.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/onboarding/SignInResult.tsx
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── src/lib/assertNever.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/protocolCompat.ts
 * └── src/lib/route.ts
 * External: @lingui/react, react
 *
 * Used by:
 * src/screens/onboarding/SignInResult.tsx
 * └── src/screens/onboarding/ConfirmOrg.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { Button } from '@yaran/ui-kit/button';
import { InlineCode } from '@yaran/ui-kit/inline-code';
import type { ReactNode } from 'react';

import { assertNever } from '../../lib/assertNever.ts';
import type { SignInOutcome } from '../../lib/native/machineView.ts';
import { updateFor } from '../../lib/protocolCompat.ts';
import { navigate } from '../../lib/route.ts';

type Failure = Exclude<SignInOutcome, { kind: 'signed_in' }>;

// The 15 failure matrix, in the shell's catalog; `host` is the org being signed in to.
function sentence(o: Failure, host: string): { text: ReactNode; retry: boolean } {
  switch (o.kind) {
    case 'cancelled':
      return { text: <Trans>Sign-in was cancelled.</Trans>, retry: true };
    case 'declined':
      return { text: <Trans>You chose Cancel on the sign-in page, so this phone wasn't signed in.</Trans>, retry: true };
    case 'interrupted':
      return { text: <Trans>The app was closed while you were signing in, so that sign-in can't finish. Start it again.</Trans>, retry: true };
    case 'verification_failed':
      return {
        text: (
          <Trans>
            This copy of the app couldn't prove it owns the sign-in link for <InlineCode>{o.domain}</InlineCode>. Install the
            app from an official channel, or try again later.
          </Trans>
        ),
        retry: true,
      };
    case 'rate_limited':
      return { text: <Trans>Too many sign-ins in a short time. Wait a minute and try again.</Trans>, retry: true };
    case 'protocol_unsupported':
      return updateFor(o) === 'client'
        ? { text: <Trans>This app is too old for the org's control plane. Update the app.</Trans>, retry: false }
        : { text: <Trans>The org's control plane is too old for this app. Ask your admin to update it.</Trans>, retry: false };
    case 'clock_skewed':
      return {
        text: (
          <Trans>
            This phone's clock is more than five minutes off from <InlineCode>{host}</InlineCode>, so the sign-in was
            refused. Set the clock automatically and try again.
          </Trans>
        ),
        retry: true,
      };
    case 'device_key_rejected':
    case 'refused':
      return { text: <Trans>The sign-in page refused this request (<InlineCode>{o.code}</InlineCode>). Update the app.</Trans>, retry: false };
    case 'no_browser':
      return { text: <Trans>Install or enable a browser (Chrome, Firefox, Brave, Vanadium…) to sign in.</Trans>, retry: true };
    case 'mismatch':
      return { text: <Trans>That sign-in reply didn't match a sign-in from this phone, so it was ignored.</Trans>, retry: true };
    case 'decrypt_failed':
      return { text: <Trans>The sign-in reply couldn't be decrypted. Update the app and yaran on the machine.</Trans>, retry: true };
    case 'envelope_expired':
      return { text: <Trans>The sign-in reply had already expired. Check that this phone's clock is right, then try again.</Trans>, retry: true };
    case 'not_owner': {
      const email = o.email;
      return {
        text: email ? (
          <Trans>
            <InlineCode>{email}</InlineCode> isn't the owner of <InlineCode>{host}</InlineCode>.
          </Trans>
        ) : (
          <Trans>
            The account you signed in with isn't the owner of <InlineCode>{host}</InlineCode>.
          </Trans>
        ),
        retry: false,
      };
    }
    case 'offline':
      return { text: <Trans>No connection. Check your network and try again.</Trans>, retry: true };
    case 'tls_error':
      return { text: <Trans>The connection to <InlineCode>{host}</InlineCode> isn't secure, so the app stopped.</Trans>, retry: false };
    case 'vault_locked':
      return { text: <Trans>Unlock the app first, then sign in.</Trans>, retry: true };
    default:
      return assertNever(o);
  }
}

export function SignInResult({ outcome, host, onRetry }: { outcome: Failure; host: string; onRetry: () => void }) {
  const { text, retry } = sentence(outcome, host);
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-border p-4">
      <p>{text}</p>
      {retry ? (
        <Button className="h-10" onClick={onRetry}>
          <Trans>Try again</Trans>
        </Button>
      ) : (
        <Button className="h-10" variant="outline" onClick={() => navigate({ name: 'welcome' })}>
          <Trans>Back</Trans>
        </Button>
      )}
    </div>
  );
}
