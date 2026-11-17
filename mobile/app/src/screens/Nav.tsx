/**
 * The bottom navigation between the three home screens: Machines, Orgs and Settings.
 *
 * - Navigation, not action: quieter styling, a 48 px floor, `aria-current` on the active tab.
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
      className={`flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-2 py-3 text-xs font-medium transition-colors ${active === name ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted'}`}
      onClick={() => navigate({ name } as Route)}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <nav className="phone-nav sticky bottom-0 z-10 mx-auto flex w-full max-w-xl gap-1 border-t border-border bg-background px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
      {tab('machines', <MonitorIcon aria-hidden className="size-5" />, <Trans>Machines</Trans>)}
      {tab('orgs', <UsersIcon aria-hidden className="size-5" />, <Trans>Orgs</Trans>)}
      {tab('settings', <SettingsIcon aria-hidden className="size-5" />, <Trans>Settings</Trans>)}
    </nav>
  );
}
