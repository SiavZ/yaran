/**
 * One machine row: name, status dot and word, last seen, and a `⋯` menu with Open and Remove….
 *
 * Follows the web's row-menu idiom (one ellipsis trigger, leading icons, a trailing `…` on the
 * item that opens a confirmation) with the 40 px touch floor. Every `MachineStatus`, plus any
 * value this build does not know, renders a word, never color alone.
 *
 * - Machine names come from the org; React text only.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/MachineRow.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/ui-kit:src/dropdown-menu.tsx
 * └── src/lib/assertNever.ts
 * External: @lingui/core, @lingui/react, lucide-react, react
 *
 * Used by:
 * src/screens/machines/MachineRow.tsx
 * ├── src/screens/machines/MachineList.tsx
 * └── src/screens/machines/machines.test.tsx
 * <module-headers:end>
 */
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import type { MachineStatus, MachineSummary } from '@yaran/protocol';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@yaran/ui-kit/dropdown-menu';
import { EllipsisIcon, ExternalLinkIcon, Trash2Icon } from 'lucide-react';
import { useRef } from 'react';

import { assertNever } from '../../lib/assertNever.ts';

const KNOWN: readonly MachineStatus[] = ['online', 'degraded', 'offline', 'never_connected', 'provisioning', 'tearing_down', 'unknown'];

/** The word and dot tone for a status; an unrecognised value reads as unknown. */
export function statusLook(raw: string): { word: MessageDescriptor; dot: string } {
  const status = (KNOWN as readonly string[]).includes(raw) ? (raw as MachineStatus) : 'unknown';
  switch (status) {
    case 'online':
      return { word: msg`Online`, dot: 'bg-emerald-500' };
    case 'degraded':
      return { word: msg`Degraded`, dot: 'bg-amber-500' };
    case 'offline':
      return { word: msg`Offline`, dot: 'bg-muted-foreground' };
    case 'never_connected':
      return { word: msg`Never connected`, dot: 'bg-muted-foreground' };
    case 'provisioning':
      return { word: msg`Setting up`, dot: 'bg-sky-500' };
    case 'tearing_down':
      return { word: msg`Being removed`, dot: 'bg-destructive' };
    case 'unknown':
      return { word: msg`Status unknown`, dot: 'bg-muted-foreground' };
    default:
      return assertNever(status);
  }
}

export function MachineRow({ machine, onOpen, onRemove }: { machine: MachineSummary; onOpen: () => void; onRemove: () => void }) {
  const { i18n } = useLingui();
  const look = statusLook(machine.status);
  const lastSeen = machine.last_seen_at ? i18n.date(new Date(machine.last_seen_at), { dateStyle: 'medium', timeStyle: 'short' }) : null;
  const canOpen = machine.status !== 'tearing_down';
  // Remove… opens a dialog whose Cancel takes focus; the closing menu must not pull it back.
  const dialogNext = useRef(false);
  return (
    <li className="flex min-h-14 items-center gap-3 rounded-lg border border-border px-3 py-2">
      <button type="button" className="flex min-h-10 flex-1 flex-col items-start text-left disabled:opacity-60" disabled={!canOpen} onClick={onOpen}>
        <span className="font-medium">{machine.name}</span>
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <span aria-hidden className={`inline-block size-2 rounded-full ${look.dot}`} />
          {i18n._(look.word)}
          {lastSeen && <span>· {i18n._(msg`last seen ${lastSeen}`)}</span>}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          onClick={() => (dialogNext.current = false)}
          render={
            <button
              type="button"
              aria-label={i18n._(msg`Actions for ${machine.name}`)}
              className="flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            />
          }
        >
          <EllipsisIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" finalFocus={() => !dialogNext.current}>
          <DropdownMenuItem disabled={!canOpen} onClick={onOpen}>
            <ExternalLinkIcon />
            {i18n._(msg`Open`)}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              dialogNext.current = true;
              onRemove();
            }}
          >
            <Trash2Icon />
            {i18n._(msg`Remove…`)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
