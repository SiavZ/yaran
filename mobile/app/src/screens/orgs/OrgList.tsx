/**
 * Orgs: the added orgs, each with a `⋯` menu holding Sign out of <org>…, plus Add an org.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/orgs/OrgList.tsx
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/dropdown-menu.tsx
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/lib/store.ts
 * ├── src/screens/Page.tsx
 * └── src/screens/orgs/SignOutOrgDialog.tsx
 * External: @lingui/core, @lingui/react, lucide-react, react
 *
 * Used by:
 * src/screens/orgs/OrgList.tsx
 * └── src/App.tsx
 * <module-headers:end>
 */
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { Button } from '@yaran/ui-kit/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@yaran/ui-kit/dropdown-menu';
import { EllipsisIcon, LogOutIcon, PlusIcon, UsersIcon } from 'lucide-react';
import { useRef, useState } from 'react';

import { orgStore, type OrgRecord } from '../../lib/orgStore.ts';
import { navigate } from '../../lib/route.ts';
import { useStore } from '../../lib/store.ts';
import { Page } from '../Page.tsx';
import { SignOutOrgDialog } from './SignOutOrgDialog.tsx';

export function OrgList() {
  const { i18n } = useLingui();
  const { orgs } = useStore(orgStore);
  const [leaving, setLeaving] = useState<OrgRecord | null>(null);
  // Sign out… opens a dialog whose Cancel takes focus; the closing menu must not pull it back.
  const dialogNext = useRef(false);
  return (
    <Page title={<Trans>Orgs</Trans>}>
      {orgs.length === 0 && (
        <p className="text-muted-foreground">
          <Trans>No org added yet.</Trans>
        </p>
      )}
      {orgs.length > 0 && <ul className="settings-group flex flex-col">
        {orgs.map((org) => (
          <li key={org.id} className="-me-2 flex min-h-14 items-center gap-[min(0.75rem,3vw)]">
            <UsersIcon aria-hidden className="mt-3.5 size-5 shrink-0 self-start" />
            <div className="flex min-w-0 flex-1 flex-col gap-1 [overflow-wrap:anywhere]">
              <span className="text-base">{org.name}</span>
              <span className="text-sm text-muted-foreground">{new URL(org.id).hostname}</span>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                onClick={() => (dialogNext.current = false)}
                render={
                  <button
                    type="button"
                    aria-label={i18n._(msg`Actions for ${org.name}`)}
                    className="phone-icon-button flex size-12 min-h-12 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                  />
                }
              >
                <EllipsisIcon className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" finalFocus={() => !dialogNext.current}>
                <DropdownMenuItem
                  onClick={() => {
                    dialogNext.current = true;
                    setLeaving(org);
                  }}
                >
                  <LogOutIcon />
                  {i18n._(msg`Sign out of ${org.name}…`)}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>}
      <Button className="min-h-12" variant="outline" onClick={() => navigate({ name: 'welcome' })}>
        <PlusIcon aria-hidden />
        <Trans>Add an org</Trans>
      </Button>
      <SignOutOrgDialog org={leaving} onClose={() => setLeaving(null)} />
    </Page>
  );
}
