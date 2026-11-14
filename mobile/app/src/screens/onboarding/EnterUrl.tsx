/**
 * Enter URL: one single-line field for the org address; Enter submits.
 *
 * Typed input is normalised (`https://` added when absent) and checked by the host rules
 * before Confirm org runs the protocol check. In `e2e` builds the field is prefilled with the
 * test control plane (Phase 19 hook H6).
 *
 * - Single-line field, so there is no confirm button requirement beyond the submit.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/onboarding/EnterUrl.tsx
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/input.tsx
 * ├── src/lib/buildInfo.ts
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
import { Input } from '@yaran/ui-kit/input';
import { useEffect, useId, useState, type FormEvent } from 'react';

import { loadBuildInfo } from '../../lib/buildInfo.ts';
import { normalizeTypedOrgUrl, refusalMessage } from '../../lib/orgUrl.ts';
import { navigate } from '../../lib/route.ts';
import { Page } from '../Page.tsx';

export function EnterUrl() {
  const { i18n } = useLingui();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();

  useEffect(() => {
    let live = true;
    void loadBuildInfo().then((b) => {
      if (live && b.e2eControlPlaneUrl !== '') setValue((v) => (v === '' ? b.e2eControlPlaneUrl : v));
    });
    return () => {
      live = false;
    };
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    const result = normalizeTypedOrgUrl(value);
    if (!result.ok) {
      setError(i18n._(refusalMessage(result.refused)));
      return;
    }
    navigate({ name: 'confirm', url: result.value });
  }

  return (
    <Page title={<Trans>Type the org address</Trans>}>
      <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
        <label htmlFor={fieldId} className="text-sm font-medium">
          <Trans>Org address</Trans>
        </label>
        <Input
          id={fieldId}
          className="h-10"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="cp.example.com"
          value={value}
          aria-invalid={error !== null}
          aria-describedby={error ? `${fieldId}-error` : undefined}
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
        <Button type="submit" className="h-10">
          <Trans>Continue</Trans>
        </Button>
        <Button type="button" variant="ghost" className="h-10" onClick={() => navigate({ name: 'scan' })}>
          <Trans>Scan a QR code instead</Trans>
        </Button>
      </form>
    </Page>
  );
}
