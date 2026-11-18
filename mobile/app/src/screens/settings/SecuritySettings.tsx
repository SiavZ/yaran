/**
 * Security settings: app lock, device-passcode fallback, lock grace and screen privacy.
 *
 * All four are native state (they must apply before the shell loads): the screen reads
 * `AppLock.status()` / `ScreenPrivacy.get()` and writes through the plugins, confirming each
 * outcome with a toast. Enabling the lock prompts once natively to prove the user can unlock.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/settings/SecuritySettings.tsx
 * ├── @yaran/secure-store:src/index.ts
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── src/lib/notify.ts
 * ├── src/lib/openMachine.ts
 * ├── src/screens/Page.tsx
 * └── src/screens/settings/SettingRow.tsx
 * External: @lingui/react, react
 *
 * Used by:
 * src/screens/settings/SecuritySettings.tsx
 * ├── src/App.tsx
 * └── src/screens/settings/settings.test.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { AppLock, ScreenPrivacy, type AppLockStatus, type LockGrace } from '@yaran/secure-store';
import { InlineCode } from '@yaran/ui-kit/inline-code';
import { useEffect, useState } from 'react';

import { notify } from '../../lib/notify.ts';
import { rejectionCode } from '../../lib/openMachine.ts';
import { Page } from '../Page.tsx';
import { RadioGroup, SwitchRow } from './SettingRow.tsx';

function failed(err: unknown) {
  const code = <InlineCode>{rejectionCode(err)}</InlineCode>;
  notify('error', <Trans>yaran couldn't confirm that security setting ({code}). Try again.</Trans>);
}

export function SecuritySettings() {
  const [lock, setLock] = useState<AppLockStatus | null>(null);
  const [privacy, setPrivacy] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    void AppLock.status().then((s) => { if (live) setLock(s); }, (err: unknown) => { if (live) failed(err); });
    void ScreenPrivacy.get().then((p) => { if (live) setPrivacy(p.enabled); }, (err: unknown) => { if (live) failed(err); });
    return () => { live = false; };
  }, []);

  async function toggleLock(on: boolean) {
    if (!lock) return;
    try {
      const { outcome } = on ? await AppLock.enable({ allowPasscode: lock.allowPasscode }) : await AppLock.disable();
      setLock(await AppLock.status());
      if (outcome === 'enabled') notify('success', <Trans>App lock is on. yaran asks for your biometrics after the lock delay.</Trans>);
      else if (outcome === 'disabled') notify('success', <Trans>App lock is off.</Trans>);
      else if (outcome === 'unavailable') notify('warning', <Trans>App lock needs biometrics set up on this phone. Add a fingerprint or face in the phone's settings first.</Trans>);
      else notify('info', on ? <Trans>App lock stayed off because the prompt was cancelled.</Trans> : <Trans>App lock stayed on because the prompt was cancelled.</Trans>);
    } catch (err) { failed(err); }
  }

  async function setOptions(patch: { grace?: LockGrace; allowPasscode?: boolean }) {
    try {
      await AppLock.setOptions(patch);
      setLock(await AppLock.status());
      notify('success', <Trans>Lock setting saved.</Trans>);
    } catch (err) { failed(err); }
  }

  async function togglePrivacy(on: boolean) {
    try {
      await ScreenPrivacy.set({ enabled: on });
      setPrivacy(on);
      notify(
        'success',
        on ? <Trans>Screen content is now hidden from screenshots and the app switcher.</Trans> : <Trans>Screen content is visible in screenshots and the app switcher again.</Trans>,
      );
    } catch (err) { failed(err); }
  }

  const noBiometry = lock !== null && lock.biometry !== 'available';
  return (
    <Page title={<Trans>Security</Trans>} back={{ name: 'settings' }}>
      <div className="settings-group">
        <SwitchRow
          label={<Trans>App lock</Trans>}
          description={
            noBiometry ? <Trans>Set up a fingerprint or face in the phone's settings to use app lock.</Trans> : <Trans>Ask for biometrics before showing yaran.</Trans>
          }
          checked={lock?.enabled ?? false}
          disabled={lock === null || (noBiometry && !lock.enabled)}
          onChange={(on) => void toggleLock(on)}
        />
        <SwitchRow
          label={<Trans>Allow device passcode</Trans>}
          description={<Trans>Unlock with the phone's passcode when biometrics fail.</Trans>}
          checked={lock?.allowPasscode ?? false}
          disabled={lock === null}
          onChange={(on) => void setOptions({ allowPasscode: on })}
        />
      </div>
      <div className="settings-group">
        <RadioGroup<LockGrace>
          legend={<Trans>Lock after</Trans>}
          value={lock?.grace ?? '1min'}
          disabled={!lock?.enabled}
          options={[
            { value: 'immediately', label: <Trans>Immediately</Trans> },
            { value: '1min', label: <Trans>1 minute in the background</Trans> },
            { value: '5min', label: <Trans>5 minutes in the background</Trans> },
            { value: '15min', label: <Trans>15 minutes in the background</Trans> },
          ]}
          onChange={(grace) => void setOptions({ grace })}
        />
      </div>
      <div className="settings-group">
        <SwitchRow
          label={<Trans>Hide screen content</Trans>}
          description={<Trans>Block screenshots and blank yaran in the app switcher.</Trans>}
          checked={privacy ?? false}
          disabled={privacy === null}
          onChange={(on) => void togglePrivacy(on)}
        />
      </div>
    </Page>
  );
}
