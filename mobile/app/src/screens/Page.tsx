/**
 * The shell's page frame: a titled, scrollable column with the safe-area insets applied.
 *
 * - SystemBars runs in CSS insets mode, so every page pads by `env(safe-area-inset-*)`.
 *
 * <module-headers:begin>
 * Uses: none
 * External: react
 *
 * Used by:
 * src/screens/Page.tsx
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/states/PhoneRemoved.tsx
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
import type { ReactNode } from 'react';

export function Page({ title, children, actions }: { title: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-4">
      <header className="flex min-h-10 items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{title}</h1>
        {actions}
      </header>
      {children}
    </main>
  );
}
