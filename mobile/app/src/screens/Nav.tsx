/**
 * The bottom navigation between the three home screens: Machines, Orgs and Settings.
 *
 * - Navigation, not action: quieter styling, a 48 px floor, `aria-current` on the active tab.
 * - The active tab is marked by a pill behind its icon, on the raised surface the page title sits on.
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
      className={`group flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-2 text-sm font-medium transition-colors ${active === name ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
      onClick={() => navigate({ name } as Route)}
    >
      <span className={`flex h-8 w-16 items-center justify-center rounded-full transition-colors ${active === name ? 'bg-accent' : 'group-hover:bg-muted'}`}>{icon}</span>
      {label}
    </button>
  );
  return (
    <nav className="phone-nav sticky bottom-0 z-10 mx-auto flex w-full max-w-xl gap-1 bg-card px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
      {tab('machines', <MonitorIcon aria-hidden className="size-5" />, <Trans>Machines</Trans>)}
      {tab('orgs', <UsersIcon aria-hidden className="size-5" />, <Trans>Orgs</Trans>)}
      {tab('settings', <SettingsIcon aria-hidden className="size-5" />, <Trans>Settings</Trans>)}
    </nav>
  );
}
