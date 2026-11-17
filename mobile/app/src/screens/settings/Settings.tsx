/**
 * Settings: the list of setting groups, the reopen-last-machine switch and Erase everything….
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/settings/Settings.tsx
 * ├── @yaran/ui-kit:src/button.tsx
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
import { ChevronRightIcon, FileTextIcon, LanguagesIcon, ShieldCheckIcon, StethoscopeIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { navigate, type SettingsPage } from '../../lib/route.ts';
import { settingsStore, updateSettings } from '../../lib/settingsStore.ts';
import { useStore } from '../../lib/store.ts';
import { Page } from '../Page.tsx';
import { EraseDialog } from './EraseDialog.tsx';
import { NotificationSettings } from './NotificationSettings.tsx';
import { SwitchRow } from './SettingRow.tsx';

function Link({ page, children, icon }: { page: SettingsPage; children: ReactNode; icon: ReactNode }) {
  return (
    <button
      type="button"
      className="flex min-h-12 w-full items-center justify-between rounded-md text-left font-medium hover:bg-muted"
      onClick={() => navigate({ name: 'settings-page', page })}
    >
      <span className="flex min-w-0 items-center gap-3"><span className="text-muted-foreground">{icon}</span>{children}</span>
      <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
    </button>
  );
}

export function Settings() {
  const { reopenLastMachine } = useStore(settingsStore);
  const [erasing, setErasing] = useState(false);
  return (
    <Page title={<Trans>Settings</Trans>}>
      <section>
        <h2 className="settings-heading">
          <Trans>Notifications</Trans>
        </h2>
        <div className="rounded-xl border border-border bg-card p-4"><NotificationSettings /></div>
      </section>
      <section>
        <h2 className="settings-heading"><Trans>Preferences</Trans></h2>
        <div className="settings-group">
          <Link page="security" icon={<ShieldCheckIcon aria-hidden className="size-5" />}><Trans>Security</Trans></Link>
          <div className="pl-8"><SwitchRow label={<Trans>Reopen last machine on launch</Trans>} checked={reopenLastMachine} onChange={(on) => void updateSettings({ reopenLastMachine: on })} /></div>
          <Link page="language" icon={<LanguagesIcon aria-hidden className="size-5" />}><Trans>Language</Trans></Link>
        </div>
      </section>
      <section>
        <h2 className="settings-heading"><Trans>Support</Trans></h2>
        <div className="settings-group">
          <Link page="diagnostics" icon={<StethoscopeIcon aria-hidden className="size-5" />}><Trans>Diagnostics</Trans></Link>
          <Link page="licenses" icon={<FileTextIcon aria-hidden className="size-5" />}><Trans>About and licenses</Trans></Link>
        </div>
      </section>
      <section className="mt-3">
        <h2 className="settings-heading"><Trans>Local data</Trans></h2>
        <p className="mb-3 text-sm text-muted-foreground"><Trans>Remove this phone's saved orgs, sign-ins and preferences.</Trans></p>
        <Button className="min-h-12 w-full text-destructive" variant="outline" onClick={() => setErasing(true)}><Trans>Erase everything on this phone…</Trans></Button>
      </section>
      <EraseDialog open={erasing} onClose={() => setErasing(false)} onErased={() => navigate({ name: 'welcome' }, { replace: true })} />
    </Page>
  );
}
