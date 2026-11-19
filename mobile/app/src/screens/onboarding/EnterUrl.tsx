/**
 * Enter URL: one single-line field for an org address, or (`machine`) a direct machine's
 * HTTPS address; Enter submits.
 *
 * Typed input is normalised (`https://` added when absent) and checked by the host rules
 * before Confirm org runs the protocol check or Confirm machine probes the machine. A machine
 * must be reachable over HTTPS on the default port by name (for example `tailscale serve`). In `e2e` builds the field is prefilled with the
 * test control plane (Phase 19 hook H6).
 *
 * - Single-line field, so there is no confirm button requirement beyond the submit.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/onboarding/EnterUrl.tsx
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── @yaran/ui-kit:src/input.tsx
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/orgUrl.ts
 * ├── src/lib/route.ts
 * └── src/screens/Page.tsx
 * External: @lingui/react, react
 *
 * Used by:
 * src/screens/onboarding/EnterUrl.tsx
 * ├── src/App.tsx
 * └── src/screens/onboarding/onboarding.test.tsx
 * <module-headers:end>
 */
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { Button } from '@yaran/ui-kit/button';
import { InlineCode } from '@yaran/ui-kit/inline-code';
import { Input } from '@yaran/ui-kit/input';
import { useEffect, useId, useState, type FormEvent } from 'react';

import { loadBuildInfo } from '../../lib/buildInfo.ts';
import { directStore } from '../../lib/directStore.ts';
import { orgStore } from '../../lib/orgStore.ts';
import { machineRefusalMessage, normalizeTypedMachineHost, normalizeTypedOrgUrl, refusalMessage } from '../../lib/orgUrl.ts';
import { navigate } from '../../lib/route.ts';
import { Page } from '../Page.tsx';

export function EnterUrl({ machine = false }: { machine?: boolean }) {
  const { i18n } = useLingui();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();

  useEffect(() => {
    let live = true;
    if (machine) return;
    void loadBuildInfo().then((b) => {
      if (live && b.e2eControlPlaneUrl !== '') setValue((v) => (v === '' ? b.e2eControlPlaneUrl : v));
    });
    return () => {
      live = false;
    };
  }, [machine]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (machine) {
      const typed = normalizeTypedMachineHost(value);
      if (!typed.ok) return setError(i18n._(machineRefusalMessage(typed.refused)));
      return navigate({ name: 'confirm-machine', host: typed.host });
    }
    const result = normalizeTypedOrgUrl(value);
    if (!result.ok) {
      setError(i18n._(refusalMessage(result.refused)));
      return;
    }
    navigate({ name: 'confirm', url: result.value });
  }

  return (
    <Page
      title={machine ? <Trans>Type the machine address</Trans> : <Trans>Type the org address</Trans>}
      back={{ name: orgStore.get().orgs.length > 0 || directStore.get().machines.length > 0 ? 'machines' : 'welcome' }}
    >
      <p id={`${fieldId}-hint`} className="text-sm leading-relaxed text-muted-foreground">
        {machine ? (
          <Trans>
            The machine's HTTPS address, with no port. On a tailnet, serve yaran with <InlineCode>tailscale serve</InlineCode> and use its name, such as
            laptop.tail1234.ts.net.
          </Trans>
        ) : (
          <Trans>Get this address from your admin or your org's Cloud Connect page. It looks like cp.example.com.</Trans>
        )}
      </p>
      <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
        <label htmlFor={fieldId} className="text-sm font-medium">
          {machine ? <Trans>Machine address</Trans> : <Trans>Org address</Trans>}
        </label>
        <Input
          id={fieldId}
          className="min-h-12"
          inputMode="url"
          enterKeyHint="go"
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder={machine ? 'laptop.tail1234.ts.net' : 'cp.example.com'}
          value={value}
          aria-invalid={error !== null}
          aria-describedby={`${fieldId}-hint${error ? ` ${fieldId}-error` : ''}`}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
        />
        {error && (
          <p id={`${fieldId}-error`} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="min-h-12">
          <Trans>Continue</Trans>
        </Button>
        <Button type="button" variant="ghost" className="min-h-12" onClick={() => navigate({ name: 'scan' })}>
          <Trans>Scan a QR code instead</Trans>
        </Button>
      </form>
    </Page>
  );
}
