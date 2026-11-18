/**
 * Checks one HTTPS host for a direct machine, then signs in and approves it on request.
 *
 * Shared by Confirm machine (G1) and the "another way to reach it" step of Ways to reach it
 * (G2). It probes `Session.directStatus` (public status, no redirect followed), shows the
 * host, the machine's identity, whether the last hop is encrypted and whether a password is
 * needed, and only an explicit press continues. A password is typed into the native sheet
 * (`Session.directSignIn`); the shell never sees it or the session it buys.
 *
 * - With `expectInstance`, a host answering as another instance is refused: the instance is
 *   public, so it only groups routes the user approves and authorizes nothing.
 * - A sign-in whose instance differs from the one shown is signed out again and refused.
 * - When `onApproved` fails after a sign-in this check made, that session is ended again.
 * - Unmounting the check, or Erase everything, cancels a pending approval at once: nothing it
 *   would do afterwards is saved, shown or navigated to (a save already being written is undone
 *   in its turn), and a sign-in it minted is ended unless a saved machine owns the host.
 * - The approval runs as one same-host turn (`withHost`): no other direct sign-in or sign-out on
 *   the host starts until its sign-in, save and clean-up are all done, and erase waits for it.
 * - A rate limit disables Try again until the machine's own wait is over.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/DirectCheck.tsx
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── src/lib/diagnostics.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/erasure.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/notify.ts
 * ├── src/lib/openMachine.ts
 * ├── src/screens/machines/directText.tsx
 * └── src/screens/machines/states/Offline.tsx
 * External: @lingui/react, lucide-react, react
 *
 * Used by:
 * src/screens/machines/DirectCheck.tsx
 * ├── src/screens/machines/MachineRoutes.tsx
 * └── src/screens/onboarding/ConfirmMachine.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { Button } from '@yaran/ui-kit/button';
import { InlineCode } from '@yaran/ui-kit/inline-code';
import { LoaderCircleIcon, ShieldCheckIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { log } from '../../lib/diagnostics.ts';
import { notify } from '../../lib/notify.ts';
import { addDirect, directGeneration, findDirectByHost, withHost } from '../../lib/directStore.ts';
import { erasing } from '../../lib/erasure.ts';
import { Session, type DirectStatus } from '../../lib/native/machineView.ts';
import { machineChoices, rejectionCode } from '../../lib/openMachine.ts';
import { Offline } from './states/Offline.tsx';
import { probeFailureText, signInFailureText, type ProbeFailure, type SignInFailure } from './directText.tsx';

type Yaran = Extract<DirectStatus, { kind: 'yaran' }>;

type Probe = { kind: 'loading' } | { kind: 'ready'; status: Yaran } | { kind: 'failed'; failure: ProbeFailure };
type Approval =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'sign_in_failed'; failure: SignInFailure; waiting: boolean }
  | { kind: 'mismatch' }
  | { kind: 'save_failed'; code: string };

function Identity({ instance }: { instance: string | null }) {
  if (instance === null) {
    return <Trans>It doesn't report an identity, so the app can't add other ways to reach it or notice a different yaran at this address.</Trans>;
  }
  return <Trans>Identity <InlineCode>{instance}</InlineCode>. The app checks it each time it opens the machine.</Trans>;
}

export function DirectCheck({
  host,
  expectInstance,
  approveLabel,
  onApproved,
}: {
  host: string;
  /** The instance the host must answer as (adding a route); undefined when adding a machine. */
  expectInstance?: string;
  approveLabel: ReactNode;
  /**
   * Saves what was approved. `cancelled` turns true once this check is abandoned (unmounted, or
   * everything erased): nothing may be saved, shown or navigated to after that.
   */
  onApproved: (instance: string | null, cancelled: () => boolean) => Promise<void>;
}) {
  const [probe, setProbe] = useState<Probe>({ kind: 'loading' });
  const [approval, setApproval] = useState<Approval>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const abandoned = useRef(false);
  useEffect(() => {
    abandoned.current = false;
    return () => {
      abandoned.current = true;
    };
  }, []);
  const recheck = useCallback(() => {
    setProbe({ kind: 'loading' });
    setApproval({ kind: 'idle' });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let live = true;
    Session.directStatus({ host }).then(
      (s) => live && setProbe(s.kind === 'yaran' ? { kind: 'ready', status: s } : { kind: 'failed', failure: s }),
      (err: unknown) => live && setProbe({ kind: 'failed', failure: { kind: 'rejected', code: rejectionCode(err) } }),
    );
    return () => {
      live = false;
    };
  }, [host, attempt]);

  // A rate limit holds Try again for the machine's own wait, then gives it back by itself.
  const waitSeconds = approval.kind === 'sign_in_failed' && approval.waiting && approval.failure.kind === 'rate_limited' ? approval.failure.retryAfterSeconds : 0;
  useEffect(() => {
    if (waitSeconds <= 0) return;
    const t = setTimeout(() => setApproval((a) => (a.kind === 'sign_in_failed' ? { ...a, waiting: false } : a)), waitSeconds * 1000);
    return () => clearTimeout(t);
  }, [waitSeconds]);

  async function approve(status: Yaran) {
    const asOf = directGeneration();
    // Abandon on erase, teardown, a new address or a newer machine choice.
    // A link changes the address before React cleanup; an open can leave it unchanged.
    const from = window.location.hash;
    const choices = machineChoices();
    const cancelled = () => abandoned.current || asOf !== directGeneration() || window.location.hash !== from || machineChoices() !== choices;
    setApproval({ kind: 'running' });
    try {
      // The whole approval is one same-host turn: sign-in, save, and the clean-up of a sign-in
      // it minted but cannot keep. The next sign-in on this host starts only after it.
      await withHost(host, async () => {
        if (cancelled()) return;
        let signedHere = false;
        let minted: string | null = null;
        let signInId = '';
        // Ends the session this approval minted and cannot keep. When native cannot delete it,
        // the machine is listed after all, so the session has a row to Remove it from, and a
        // toast says so even after this screen is gone. An erase owns the list and wipes it.
        const endMine = async () => {
          // A saved machine at this host now owns the session (a failed undo keeps it listed).
          if (!signedHere || findDirectByHost(host)) return;
          // Only this approval's own sign-in: a newer one on the host (the machine window's, say) is `not_current` and stays.
          const out = await Session.directSignOut({ host, signInId }).catch((err: unknown) => ({ kind: 'rejected' as const, code: rejectionCode(err) }));
          if (out.kind === 'signed_out' || out.kind === 'not_current' || out.kind === 'refused') return;
          const code = out.kind === 'rejected' ? out.code : out.kind;
          log('error', `could not end an abandoned direct sign-in (${code})`);
          if (asOf !== directGeneration() || erasing()) return;
          const chip = <InlineCode>{host}</InlineCode>;
          const why = <InlineCode>{code}</InlineCode>;
          try {
            await addDirect({ host, instance: minted });
            notify('error', <Trans>The app couldn't end the sign-in to {chip} ({why}), so it is listed under Machines. Remove it there to end it.</Trans>, { sticky: true });
          } catch (err) {
            const saved = <InlineCode>{rejectionCode(err)}</InlineCode>;
            notify('error', <Trans>The app couldn't end the sign-in to {chip} ({why}) or list it ({saved}). Erase everything in Settings removes it from this phone.</Trans>, { sticky: true });
          }
        };
        let instance = status.instance;
        if (status.requiredHere && !status.signedIn) {
          const out = await Session.directSignIn({ host }).catch((err: unknown): SignInFailure => ({ kind: 'rejected', code: rejectionCode(err) }));
          signedHere = out.kind === 'signed_in';
          if (out.kind === 'signed_in') {
            minted = out.instance;
            signInId = out.signInId;
          }
          if (cancelled()) return endMine();
          if (out.kind === 'signed_in') {
            if (out.instance !== status.instance) {
              log('warn', 'a direct sign-in answered as a different instance than the status check; signed out again');
              await endMine();
              return setApproval({ kind: 'mismatch' });
            }
            instance = out.instance;
          } else if (out.kind !== 'not_required') {
            return setApproval({ kind: 'sign_in_failed', failure: out, waiting: out.kind === 'rate_limited' && out.retryAfterSeconds > 0 });
          }
        }
        if (cancelled()) return endMine();
        try {
          await onApproved(instance, cancelled);
          if (!cancelled()) setApproval({ kind: 'idle' });
        } catch (err) {
          const code = rejectionCode(err);
          // The undo of an abandoned save failed: the machine and its sign-in stay listed. Said
          // here, before the abandoned return, because nobody may be on this screen any more.
          if (code === 'rollback_failed') {
            const chip = <InlineCode>{host}</InlineCode>;
            notify('error', <Trans>The app couldn't undo adding {chip} (<InlineCode>{code}</InlineCode>), so it stays listed under Machines with its sign-in. Remove it there if you didn't mean to add it.</Trans>, { sticky: true });
          }
          await endMine();
          if (cancelled()) return;
          log('error', `could not save a direct machine (${code})`);
          setApproval({ kind: 'save_failed', code });
        }
      });
    } catch (err) {
      // Refused before it began (an erase is running): nothing was signed in.
      if (!cancelled()) setApproval({ kind: 'save_failed', code: rejectionCode(err) });
    }
  }

  if (probe.kind === 'loading') {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        <Trans>Checking the machine…</Trans>
      </p>
    );
  }
  if (probe.kind === 'failed') {
    if (probe.failure.kind === 'offline') return <Offline onRetry={recheck} />;
    const { text, retry } = probeFailureText(probe.failure, host);
    return (
      <div role="alert" className="state-card">
        <p>{text}</p>
        {retry && (
          <Button className="min-h-12" variant="outline" onClick={recheck}>
            <Trans>Try again</Trans>
          </Button>
        )}
      </div>
    );
  }

  const { status } = probe;
  const chip = <InlineCode>{host}</InlineCode>;
  if (expectInstance !== undefined && status.instance !== expectInstance) {
    return (
      <div role="alert" className="state-card">
        <p>
          <Trans>A different yaran answers at {chip}, so it can't be a way to reach this machine.</Trans>
        </p>
        <Button className="min-h-12" variant="outline" onClick={recheck}>
          <Trans>Check again</Trans>
        </Button>
      </div>
    );
  }
  const needsPassword = status.requiredHere && !status.signedIn;
  const blocked = status.requiredHere && !status.passwordSet;
  return (
    <>
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 text-sm leading-relaxed [overflow-wrap:anywhere]">
        <ShieldCheckIcon aria-hidden className="size-6 text-muted-foreground" />
        <p>
          <Identity instance={status.instance} />
        </p>
        <p>
          {status.transportEncrypted ? (
            <Trans>The connection is HTTPS all the way to yaran.</Trans>
          ) : (
            <Trans>The connection is HTTPS, but yaran says the last hop to it was not encrypted. Check that the proxy in front of it runs on the same machine.</Trans>
          )}
        </p>
        <p>
          {blocked ? (
            <Trans>
              This machine needs a password and has none. Set one there with <InlineCode>yaran config set server.auth.password</InlineCode>, then check
              again.
            </Trans>
          ) : status.signedIn ? (
            <Trans>This phone is already signed in to it.</Trans>
          ) : status.requiredHere ? (
            <Trans>You'll sign in once with the machine's password, in a secure sheet the machine's page can't read.</Trans>
          ) : (
            <Trans>This machine lets this network in without a password.</Trans>
          )}
        </p>
      </section>
      {approval.kind === 'sign_in_failed' && (
        <div role="alert" className="state-card">
          <p>{signInFailureText(approval.failure, host).text}</p>
        </div>
      )}
      {approval.kind === 'mismatch' && (
        <p role="alert" className="text-sm text-destructive">
          <Trans>A different yaran answered the sign-in than the one checked above, so nothing was added. Check the address and try again.</Trans>
        </p>
      )}
      {approval.kind === 'save_failed' && (
        <p role="alert" className="text-sm text-destructive">
          <Trans>The app couldn't save this on the phone (<InlineCode>{approval.code}</InlineCode>). Try again.</Trans>
        </p>
      )}
      {blocked || approval.kind === 'mismatch' || (approval.kind === 'sign_in_failed' && !signInFailureText(approval.failure, host).retry) ? (
        <Button className="min-h-12" variant="outline" onClick={recheck}>
          <Trans>Check again</Trans>
        </Button>
      ) : (
        <Button className="min-h-12" disabled={approval.kind === 'running' || waitSeconds > 0} onClick={() => void approve(status)}>
          {approval.kind === 'running' ? (
            <>
              <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" />
              {needsPassword ? <Trans>Signing in…</Trans> : <Trans>Saving…</Trans>}
            </>
          ) : approval.kind === 'sign_in_failed' || approval.kind === 'save_failed' ? (
            <Trans>Try again</Trans>
          ) : needsPassword ? (
            <Trans>Sign in and continue</Trans>
          ) : (
            approveLabel
          )}
        </Button>
      )}
    </>
  );
}
