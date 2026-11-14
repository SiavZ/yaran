/**
 * Confirm org: the one gate every new org passes, however its URL arrived.
 *
 * Re-checks the URL with the host rules (it may come from a deep link or QR, T42), shows it as
 * a chip, fetches `/v1/meta` through Phase 15's native client, runs the protocol verdict,
 * stops on `setup: open`, discloses that Cloudflare decrypts traffic at its edge (D17), warns
 * that the browser will ask to sign this device in (the consent page, D8), and only then
 * offers Sign in. The org is added after a successful sign-in, never before.
 *
 * - The org name and team domain come from the org and render as React text.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/onboarding/ConfirmOrg.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── src/lib/hostRules.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/protocolCompat.ts
 * ├── src/lib/route.ts
 * ├── src/screens/Page.tsx
 * ├── src/screens/machines/states/Offline.tsx
 * ├── src/screens/machines/states/ProtocolMismatch.tsx
 * ├── src/screens/machines/states/SetupIncomplete.tsx
 * └── src/screens/onboarding/SignInResult.tsx
 * External: @lingui/react, react
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
import { useCallback, useEffect, useState } from 'react';

import { orgUrl } from '../../lib/hostRules.ts';
import { refreshMachines } from '../../lib/machinesStore.ts';
import { Session, rejectionCode, type MetaFailure, type SignInOutcome } from '../../lib/native/machineView.ts';
import { addOrg } from '../../lib/orgStore.ts';
import { protocolVerdict } from '../../lib/protocolCompat.ts';
import { navigate } from '../../lib/route.ts';
import { Page } from '../Page.tsx';
import { Offline } from '../machines/states/Offline.tsx';
import { ProtocolMismatch } from '../machines/states/ProtocolMismatch.tsx';
import { SetupIncomplete } from '../machines/states/SetupIncomplete.tsx';
import { SignInResult } from './SignInResult.tsx';

type MetaState = { kind: 'loading' } | { kind: 'ready'; meta: Meta } | { kind: 'failed'; code: MetaFailure };
type SignInState = { kind: 'idle' } | { kind: 'running' } | { kind: 'failed'; outcome: Exclude<SignInOutcome, { kind: 'signed_in' }> };

const META_FAILURES: readonly MetaFailure[] = ['offline', 'tls_error', 'not_json', 'access_redirect', 'invalid', 'refused'];

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
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-border p-4">
      <p>{text}</p>
      <Button className="h-10" variant="outline" onClick={onRetry}>
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
  const retry = useCallback(() => {
    setMeta({ kind: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    if (org === null) return;
    let live = true;
    Session.meta({ orgUrl: org }).then(
      (m) => live && setMeta({ kind: 'ready', meta: m }),
      (err: unknown) => {
        const code = rejectionCode(err);
        if (live) setMeta({ kind: 'failed', code: (META_FAILURES as readonly string[]).includes(code ?? '') ? (code as MetaFailure) : 'invalid' });
      },
    );
    return () => {
      live = false;
    };
  }, [org, attempt]);

  if (org === null) {
    return (
      <Page title={<Trans>Add org</Trans>}>
        <p role="alert">
          <Trans>That org address isn't valid, so it can't be added.</Trans>
        </p>
        <Button className="h-10" onClick={() => navigate({ name: 'enter-url' })}>
          <Trans>Type the org address</Trans>
        </Button>
      </Page>
    );
  }

  async function startSignIn(m: Meta) {
    setSignIn({ kind: 'running' });
    const outcome = await Session.signIn({ orgId: org!, target: 'control-plane' }).catch((): SignInOutcome => ({ kind: 'offline' }));
    if (outcome.kind !== 'signed_in') return setSignIn({ kind: 'failed', outcome });
    await addOrg({ id: org!, name: m.org?.name ?? host, teamDomain: m.access?.team_domain ?? null });
    void refreshMachines(org!);
    navigate({ name: 'machines' }, { replace: true });
  }

  const verdict = meta.kind === 'ready' ? protocolVerdict(meta.meta) : null;
  return (
    <Page title={<Trans>Add this org?</Trans>}>
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
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">
              <Trans>Org</Trans>
            </dt>
            <dd>{meta.meta.org?.name ?? host}</dd>
            {meta.meta.access && (
              <>
                <dt className="text-muted-foreground">
                  <Trans>Sign-in team</Trans>
                </dt>
                <dd>{meta.meta.access.team_domain}</dd>
              </>
            )}
          </dl>
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
            <SignInResult outcome={signIn.outcome} onRetry={() => void startSignIn(meta.meta)} />
          ) : (
            <Button className="h-10" disabled={signIn.kind === 'running'} onClick={() => void startSignIn(meta.meta)}>
              <Trans>Sign in</Trans>
            </Button>
          )}
        </>
      )}
    </Page>
  );
}
