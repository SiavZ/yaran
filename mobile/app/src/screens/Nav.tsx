/**
 * The bottom navigation between the three home screens: Machines, Orgs and Settings.
 *
 * - Navigation, not action: quieter styling, a 40 px floor, `aria-current` on the active tab.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/Nav.tsx
 * └── src/lib/route.ts
 * External: @lingui/react, lucide-react
 *
 * Used by:
 * src/screens/Nav.tsx
 * └── src/App.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { MonitorIcon, SettingsIcon, UsersIcon } from 'lucide-react';

import { navigate, type Route } from '../lib/route.ts';

type Home = 'machines' | 'orgs' | 'settings';

export function Nav({ active }: { active: Home }) {
  const tab = (name: Home, icon: React.ReactNode, label: React.ReactNode) => (
    <button
      type="button"
      aria-current={active === name ? 'page' : undefined}
      className={`flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-xs ${active === name ? 'text-foreground' : 'text-muted-foreground'}`}
      onClick={() => navigate({ name } as Route)}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <nav className="sticky bottom-0 flex border-t border-border bg-background pb-[env(safe-area-inset-bottom)]">
      {tab('machines', <MonitorIcon aria-hidden className="size-5" />, <Trans>Machines</Trans>)}
      {tab('orgs', <UsersIcon aria-hidden className="size-5" />, <Trans>Orgs</Trans>)}
      {tab('settings', <SettingsIcon aria-hidden className="size-5" />, <Trans>Settings</Trans>)}
    </nav>
  );
}
