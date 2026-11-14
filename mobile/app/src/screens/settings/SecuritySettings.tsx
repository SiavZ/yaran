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
 * ├── src/lib/notify.ts
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
import { useEffect, useState } from 'react';

import { notify } from '../../lib/notify.ts';
import { Page } from '../Page.tsx';
import { RadioGroup, SwitchRow } from './SettingRow.tsx';

export function SecuritySettings() {
  const [lock, setLock] = useState<AppLockStatus | null>(null);
  const [privacy, setPrivacy] = useState(false);

  useEffect(() => {
    void AppLock.status().then(setLock);
    void ScreenPrivacy.get().then((p) => setPrivacy(p.enabled));
  }, []);

  async function toggleLock(on: boolean) {
    if (!lock) return;
    if (on) {
      const { outcome } = await AppLock.enable({ allowPasscode: lock.allowPasscode });
      if (outcome === 'enabled') notify('success', <Trans>App lock is on. yaran asks for your biometrics after the lock delay.</Trans>);
      else if (outcome === 'unavailable') notify('warning', <Trans>App lock needs biometrics set up on this phone. Add a fingerprint or face in the phone's settings first.</Trans>);
      else notify('info', <Trans>App lock stayed off because the prompt was cancelled.</Trans>);
    } else {
      const { outcome } = await AppLock.disable();
      if (outcome === 'disabled') notify('success', <Trans>App lock is off.</Trans>);
      else notify('info', <Trans>App lock stayed on because the prompt was cancelled.</Trans>);
    }
    setLock(await AppLock.status());
  }

  async function setOptions(patch: { grace?: LockGrace; allowPasscode?: boolean }) {
    try {
      await AppLock.setOptions(patch);
      notify('success', <Trans>Lock setting saved.</Trans>);
    } catch {
      // The passcode fallback is fixed into the lock key when it is created.
      notify('warning', <Trans>That setting can't change while app lock is on. Turn app lock off, change it, then turn the lock back on.</Trans>);
    }
    setLock(await AppLock.status());
  }

  async function togglePrivacy(on: boolean) {
    await ScreenPrivacy.set({ enabled: on });
    setPrivacy(on);
    notify(
      'success',
      on ? <Trans>Screen content is now hidden from screenshots and the app switcher.</Trans> : <Trans>Screen content is visible in screenshots and the app switcher again.</Trans>,
    );
  }

  const noBiometry = lock !== null && lock.biometry !== 'available';
  return (
    <Page title={<Trans>Security</Trans>}>
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
      <SwitchRow
        label={<Trans>Hide screen content</Trans>}
        description={<Trans>Block screenshots and blank yaran in the app switcher.</Trans>}
        checked={privacy}
        onChange={(on) => void togglePrivacy(on)}
      />
    </Page>
  );
}
