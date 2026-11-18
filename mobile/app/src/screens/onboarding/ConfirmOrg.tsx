/**
 * Confirm org: the one gate every new org passes, however its URL arrived.
 *
 * Re-checks the URL with the host rules (it may come from a deep link or QR, T42), shows it as
 * a chip, fetches `/v1/meta` through Phase 15's native client, runs the protocol verdict,
 * stops on `setup: open`, discloses that Cloudflare decrypts traffic at its edge (D17), warns
 * that the browser will ask to sign this device in (the consent page, D8), and only then
 * offers Sign in. The native handoff only signs in to an org in the vault's org list, so the
 * confirmed org is written there first and put back as it was when sign-in does not succeed.
 *
 * - The org name and team domain come from the org and render as React text.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/onboarding/ConfirmOrg.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── src/lib/api.ts
 * ├── src/lib/diagnostics.ts
 * ├── src/lib/erasure.ts
 * ├── src/lib/hostRules.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/notify.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/protocolCompat.ts
 * ├── src/lib/route.ts
 * ├── src/screens/Page.tsx
 * ├── src/screens/machines/states/Offline.tsx
 * ├── src/screens/machines/states/ProtocolMismatch.tsx
 * ├── src/screens/machines/states/SetupIncomplete.tsx
 * └── src/screens/onboarding/SignInResult.tsx
 * External: @lingui/react, lucide-react, react
 *
 * Used by:
 * src/screens/onboarding/ConfirmOrg.tsx
 * ├── src/App.tsx
 * └── src/screens/onboarding/onboarding.test.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import type { Meta } from '@yaran/protocol';
import { Button } from '@yaran/ui-kit/button';
import { InlineCode } from '@yaran/ui-kit/inline-code';
import { LoaderCircleIcon, ShieldCheckIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { log } from '../../lib/diagnostics.ts';
import { eraseEpoch, erasing } from '../../lib/erasure.ts';
import { orgUrl } from '../../lib/hostRules.ts';
import { refreshMachines } from '../../lib/machinesStore.ts';
import { getMeta, type MetaFailure } from '../../lib/api.ts';
import { Session, type SignInOutcome } from '../../lib/native/machineView.ts';
import { notify } from '../../lib/notify.ts';
import { machineChoices, rejectionCode } from '../../lib/openMachine.ts';
import { orgIncarnation, ownsStaging, settleStaging, stageOrg, unstageOrg, type Staging } from '../../lib/orgStore.ts';
import { protocolVerdict } from '../../lib/protocolCompat.ts';
import { navigate } from '../../lib/route.ts';
import { Page } from '../Page.tsx';
import { Offline } from '../machines/states/Offline.tsx';
import { ProtocolMismatch } from '../machines/states/ProtocolMismatch.tsx';
import { SetupIncomplete } from '../machines/states/SetupIncomplete.tsx';
import { SignInResult, type SignInFailure } from './SignInResult.tsx';

type MetaState = { kind: 'loading' } | { kind: 'ready'; meta: Meta } | { kind: 'failed'; code: MetaFailure };
type SignInState = { kind: 'idle' } | { kind: 'running' } | { kind: 'failed'; outcome: SignInFailure };

function MetaError({ code, host, onRetry }: { code: MetaFailure; host: string; onRetry: () => void }) {
  if (code === 'offline') return <Offline onRetry={onRetry} />;
  let text;
  switch (code) {
    case 'tls_error':
      text = <Trans>The connection to <InlineCode>{host}</InlineCode> isn't secure, so the app stopped.</Trans>;
      break;
    case 'access_redirect':
      text = (
        <Trans>
          <InlineCode>{host}</InlineCode> sent the app to a sign-in page instead of answering. The control plane's public
          paths are not set up; ask your admin to check the Cloudflare Access bypass for <InlineCode>/v1/meta</InlineCode>.
        </Trans>
      );
      break;
    case 'not_json':
    case 'invalid':
      text = <Trans><InlineCode>{host}</InlineCode> answered, but not like a yaran control plane. Check the address.</Trans>;
      break;
    case 'refused':
      text = <Trans>The app refused to contact <InlineCode>{host}</InlineCode> because the address broke a safety rule.</Trans>;
      break;
  }
  return (
    <div role="alert" className="state-card">
      <p>{text}</p>
      <Button className="min-h-12" variant="outline" onClick={onRetry}>
        <Trans>Try again</Trans>
      </Button>
    </div>
  );
}

export function ConfirmOrg({ url }: { url: string }) {
  const checked = orgUrl(url);
  const org = checked.ok ? checked.value : null;
  const host = org ? new URL(org).hostname : url;
  const [meta, setMeta] = useState<MetaState>({ kind: 'loading' });
  const [signIn, setSignIn] = useState<SignInState>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const retry = useCallback(() => {
    setMeta({ kind: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    if (org === null) return;
    let live = true;
    getMeta(org).then(
      (got) => live && setMeta(got.ok ? { kind: 'ready', meta: got.meta } : { kind: 'failed', code: got.code }),
      () => live && setMeta({ kind: 'failed', code: 'invalid' }),
    );
    return () => {
      live = false;
    };
  }, [org, attempt]);

  if (org === null) {
    return (
      <Page title={<Trans>Add org</Trans>} back={{ name: 'enter-url' }}>
        <p role="alert">
          <Trans>That org address isn't valid, so it can't be added.</Trans>
        </p>
        <Button className="min-h-12" onClick={() => navigate({ name: 'enter-url' })}>
          <Trans>Type the org address</Trans>
        </Button>
      </Page>
    );
  }

  async function startSignIn(m: Meta) {
    setSignIn({ kind: 'running' });
    // This screen's effects only while it is where the person is: mounted, and still at the address
    // pressed on, with no newer machine choice. The org staging below settles regardless.
    const from = window.location.hash;
    const choices = machineChoices();
    const here = () => mounted.current && window.location.hash === from && machineChoices() === choices;
    // Everything after the sign-in is fenced: an erase meanwhile owns the org list, and a staged
    // org removed and added again is another incarnation this screen must not touch.
    const asOf = eraseEpoch();
    // The staging is this sign-in's own: an older one still out never removes or overwrites it.
    let staging: Staging;
    try {
      staging = await stageOrg({ id: org!, name: m.org?.name ?? host, teamDomain: m.access?.team_domain ?? null }, asOf);
    } catch (err) {
      // The vault refused the write: say what it said, never guess that the app is locked.
      log('error', `could not stage the org for sign-in: ${err instanceof Error ? err.message : String(err)}`);
      if (here()) setSignIn({ kind: 'failed', outcome: { kind: 'rejected', code: rejectionCode(err) } });
      return;
    }
    const staged = orgIncarnation(org!);
    const outcome: SignInOutcome | SignInFailure = here()
      ? await Session.signIn({ orgId: org!, target: 'control-plane' }).catch((err: unknown): SignInFailure => ({ kind: 'rejected', code: rejectionCode(err) }))
      : { kind: 'cancelled' };
    const erased = asOf !== eraseEpoch() || erasing();
    if (outcome.kind !== 'signed_in') {
      // After an erase there is nothing to put back: restoring would bring the erased org back.
      // Only while this screen's staging still owns the org: a sign-out (or a re-add) meanwhile wins.
      if (!erased) {
        try {
          // Only while this staging still owns the entry: the durable record before it goes back.
          await unstageOrg(org!, staging.token, asOf);
        } catch (err) {
          if (rejectionCode(err) === 'fallback_unsaved' && asOf === eraseEpoch() && !erasing()) {
            // An older sign-in to this org succeeded while this one was undone, and its details could
            // not be stored after all: what Orgs shows is what is saved, and it may be older or gone.
            const name = <InlineCode>{host}</InlineCode>;
            notify('error', <Trans>A sign-in to {name} succeeded, but the app couldn't save its details. Check Orgs, and add the org again if it is missing or out of date.</Trans>);
          } else if (asOf === eraseEpoch() && !erasing() && orgIncarnation(org!) === staged && ownsStaging(org!, staging.token)) {
            const code = <InlineCode>{rejectionCode(err)}</InlineCode>;
            const name = <InlineCode>{host}</InlineCode>;
            notify('error', <Trans>The app couldn't undo the temporary org details for {name} ({code}). Its entry is still saved; review it in Orgs or sign out to remove it.</Trans>);
          }
        }
      }
      if (here()) setSignIn(erased ? { kind: 'idle' } : { kind: 'failed', outcome });
      return;
    }
    // Signed in: this staging's record is durable now. A newer sign-in still out owns the entry
    // and the screen: this one settles quietly and moves nothing.
    if (erased || orgIncarnation(org!) !== staged) return;
    const owner = ownsStaging(org!, staging.token);
    settleStaging(org!, staging);
    if (!owner) return;
    void refreshMachines(org!);
    if (here()) navigate({ name: 'machines' }, { replace: true });
  }

  const verdict = meta.kind === 'ready' ? protocolVerdict(meta.meta) : null;
  return (
    <Page title={<Trans>Add this org?</Trans>} back={{ name: 'enter-url' }} backDisabled={signIn.kind === 'running'}>
      <p>
        <Trans>
          Address: <InlineCode>{org}</InlineCode>
        </Trans>
      </p>
      <p className="text-sm text-muted-foreground">
        <Trans>Only continue if you expected to add this org. Links and QR codes can come from anyone.</Trans>
      </p>
      {meta.kind === 'loading' && (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Checking the control plane…</Trans>
        </p>
      )}
      {meta.kind === 'failed' && <MetaError code={meta.code} host={host} onRetry={retry} />}
      {meta.kind === 'ready' && meta.meta.setup === 'open' && <SetupIncomplete />}
      {meta.kind === 'ready' && meta.meta.setup === 'closed' && verdict && !verdict.ok && <ProtocolMismatch update={verdict.update} />}
      {meta.kind === 'ready' && meta.meta.setup === 'closed' && verdict?.ok && (
        <>
          <section className="rounded-[1.75rem] bg-muted p-5 [overflow-wrap:anywhere]">
            <ShieldCheckIcon aria-hidden className="mb-4 size-6" />
            <h2 className="mb-3 text-2xl font-normal tracking-tight">{meta.meta.org?.name ?? host}</h2>
              {meta.meta.access && (
                <dl className="flex flex-col gap-1 text-sm">
                  <dt className="text-muted-foreground"><Trans>Sign-in team</Trans></dt>
                  <dd>{meta.meta.access.team_domain}</dd>
                </dl>
              )}
          </section>
          {verdict.deprecatedAfter && (
            <p className="text-sm text-muted-foreground">
              <Trans>This control plane will stop supporting this app after {verdict.deprecatedAfter}. Update the app before then.</Trans>
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            <Trans>
              Traffic to this org goes through Cloudflare, which decrypts it at its edge before passing it to your machines.
            </Trans>
          </p>
          <p className="text-sm text-muted-foreground">
            <Trans>Your browser opens next and asks "Sign this device in to {host}?". Tap Continue there.</Trans>
          </p>
          {signIn.kind === 'failed' ? (
            <SignInResult outcome={signIn.outcome} host={host} onRetry={() => void startSignIn(meta.meta)} />
          ) : (
            <Button className="min-h-12" disabled={signIn.kind === 'running'} onClick={() => void startSignIn(meta.meta)}>
              {signIn.kind === 'running' ? <><LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" /><Trans>Opening browser…</Trans></> : <Trans>Sign in</Trans>}
            </Button>
          )}
        </>
      )}
    </Page>
  );
}
