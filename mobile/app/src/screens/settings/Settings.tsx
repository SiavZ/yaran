/**
 * Settings: the list of setting groups, the reopen-last-machine switch and Erase everything….
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/settings/Settings.tsx
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/separator.tsx
 * ├── src/lib/route.ts
 * ├── src/lib/settingsStore.ts
 * ├── src/lib/store.ts
 * ├── src/screens/Page.tsx
 * ├── src/screens/settings/EraseDialog.tsx
 * ├── src/screens/settings/NotificationSettings.tsx
 * └── src/screens/settings/SettingRow.tsx
 * External: @lingui/react, lucide-react, react
 *
 * Used by:
 * src/screens/settings/Settings.tsx
 * ├── src/App.tsx
 * └── src/screens/settings/settings.test.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { Button } from '@yaran/ui-kit/button';
import { Separator } from '@yaran/ui-kit/separator';
import { ChevronRightIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { navigate, type SettingsPage } from '../../lib/route.ts';
import { settingsStore, updateSettings } from '../../lib/settingsStore.ts';
import { useStore } from '../../lib/store.ts';
import { Page } from '../Page.tsx';
import { EraseDialog } from './EraseDialog.tsx';
import { NotificationSettings } from './NotificationSettings.tsx';
import { SwitchRow } from './SettingRow.tsx';

function Link({ page, children }: { page: SettingsPage; children: ReactNode }) {
  return (
    <button
      type="button"
      className="flex min-h-12 w-full items-center justify-between rounded-md text-left font-medium hover:bg-muted"
      onClick={() => navigate({ name: 'settings-page', page })}
    >
      {children}
      <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
    </button>
  );
}

export function Settings() {
  const { reopenLastMachine } = useStore(settingsStore);
  const [erasing, setErasing] = useState(false);
  return (
    <Page title={<Trans>Settings</Trans>}>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">
          <Trans>Notifications</Trans>
        </h2>
        <NotificationSettings />
      </section>
      <Separator />
      <Link page="security">
        <Trans>Security</Trans>
      </Link>
      <SwitchRow
        label={<Trans>Reopen last machine on launch</Trans>}
        checked={reopenLastMachine}
        onChange={(on) => void updateSettings({ reopenLastMachine: on })}
      />
      <Link page="language">
        <Trans>Language</Trans>
      </Link>
      <Link page="diagnostics">
        <Trans>Diagnostics</Trans>
      </Link>
      <Link page="licenses">
        <Trans>About and licenses</Trans>
      </Link>
      <Separator />
      <Button className="h-10" variant="destructive" onClick={() => setErasing(true)}>
        <Trans>Erase everything on this phone…</Trans>
      </Button>
      <EraseDialog open={erasing} onClose={() => setErasing(false)} onErased={() => navigate({ name: 'welcome' }, { replace: true })} />
    </Page>
  );
}
