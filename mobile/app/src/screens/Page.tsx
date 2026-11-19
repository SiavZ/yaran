/**
 * The shell's page frame: a plain title on the raised top surface, and the page's content on a
 * sheet with rounded top corners below it (the look the user asked to match: T3 Code's phone app).
 *
 * - SystemBars runs in CSS insets mode, so every page pads by `env(safe-area-inset-*)`.
 * - `brand` puts the yaran mark beside the title; only the home and welcome screens ask for it.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/Page.tsx
 * ├── src/lib/route.ts
 * └── src/screens/BrandMark.tsx
 * External: @lingui/react, lucide-react, react
 *
 * Used by:
 * src/screens/Page.tsx
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/MachineRoutes.tsx
 * ├── src/screens/machines/ShareTarget.tsx
 * ├── src/screens/machines/states/PhoneRemoved.tsx
 * ├── src/screens/onboarding/ConfirmMachine.tsx
 * ├── src/screens/onboarding/ConfirmOrg.tsx
 * ├── src/screens/onboarding/EnterUrl.tsx
 * ├── src/screens/onboarding/ScanQr.tsx
 * ├── src/screens/onboarding/Welcome.tsx
 * ├── src/screens/orgs/OrgList.tsx
 * ├── src/screens/settings/Diagnostics.tsx
 * ├── src/screens/settings/LanguageSettings.tsx
 * ├── src/screens/settings/Licenses.tsx
 * ├── src/screens/settings/LockScreen.tsx
 * ├── src/screens/settings/SecuritySettings.tsx
 * └── src/screens/settings/Settings.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { ArrowLeftIcon } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import { navigate, type Route } from '../lib/route.ts';
import { BrandMark } from './BrandMark.tsx';

export function Page({ title, children, actions, back, backDisabled = false, brand = false, className = '' }: {
  title: ReactNode;
  brand?: boolean;
  children: ReactNode;
  actions?: ReactNode;
  back?: Route;
  backDisabled?: boolean;
  className?: string;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Keep an explicit autofocus (for example Unlock); otherwise announce the new screen.
    if (document.activeElement === document.body || document.activeElement?.closest('.phone-nav')) heading.current?.focus();
  }, []);
  return (
    <main className={`phone-page mx-auto flex w-full min-w-0 max-w-xl flex-1 flex-col pt-3 ${className}`}>
      {back && (
        <button
          type="button"
          className="-ml-3 flex min-h-12 self-start items-center gap-2 rounded-full px-3 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
          disabled={backDisabled}
          onClick={() => navigate(back)}
        >
          <ArrowLeftIcon aria-hidden className="size-4" /><Trans>Back</Trans>
        </button>
      )}
      <header className="flex min-h-14 items-center justify-between gap-[12px] pb-4">
        <div className="flex min-w-0 items-center gap-3">
          {brand && <BrandMark />}
          <h1 ref={heading} tabIndex={-1} className="min-w-0 text-[1.75rem] font-normal leading-tight tracking-tight outline-none [overflow-wrap:anywhere]">{title}</h1>
        </div>
        {actions && <div className="-me-[12px] flex shrink-0 items-center">{actions}</div>}
      </header>
      <div className="phone-sheet flex flex-1 flex-col gap-6 rounded-t-[1.75rem] bg-background pt-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
        {children}
      </div>
    </main>
  );
}
