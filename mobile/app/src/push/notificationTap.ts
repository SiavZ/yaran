/**
 * Routes a notification tap: validates it, resolves the machine against this org's paired
 * machines, opens the agent in machine-view, and clears that agent's delivered notifications.
 *
 * - Trust boundary (T42): a tap never names a host. The machine id must be one this phone has
 *   paired with that org; an unknown one toasts and opens the Machines list instead of loading
 *   anything. The host is resolved by Phase 15's open path from the local machine list.
 * - Agent and tab ids are percent-encoded into the hash, so `/` or `#` in an id can never
 *   change the route. A payload without `t` opens the bare agent hash (its first tab).
 *
 * <module-headers:begin>
 * Uses:
 * mobile/app/src/push/notificationTap.ts
 * └── mobile/app/src/push/pushStrings.ts
 * External: @yaran/push
 *
 * Used by:
 * mobile/app/src/push/notificationTap.ts
 * └── mobile/app/src/push/notificationTap.test.ts
 * <module-headers:end>
 */
import { isNotificationTappedEvent, type PushPlugin } from "@yaran/push";
import type { PushStringKey } from "./pushStrings.ts";

export interface TapDeps {
  push: PushPlugin;
  /** Paired machine ids for the org, from the shell's last authenticated machine list. */
  pairedMachineIds(orgId: string): string[];
  /** Phase 15's open path (`openMachine.ts`): resolves the host locally, then `MachineView.open`. */
  openAgent(options: { orgId: string; machineId: string; route: string }): Promise<void>;
  showMachines(orgId: string): void;
  /** Applies "Mute this machine" through the mute sync and toasts the outcome. */
  muteMachine(orgId: string, machineId: string): Promise<void>;
  toast(key: PushStringKey): void;
}

export type TapOutcome = "invalid" | "unpaired" | "opened" | "muted";

/** `#/agent/<sid>` or `#/agent/<sid>/tab/<tab>`, each segment encoded (web store.ts grammar). */
export function agentRoute(agentId: string, tabId?: string): string {
  const base = `#/agent/${encodeURIComponent(agentId)}`;
  return tabId === undefined ? base : `${base}/tab/${encodeURIComponent(tabId)}`;
}

export async function handleTap(deps: TapDeps, event: unknown): Promise<TapOutcome> {
  if (!isNotificationTappedEvent(event)) return "invalid";
  if (!deps.pairedMachineIds(event.orgId).includes(event.machineId)) {
    deps.toast("push.toast.machine_unpaired");
    deps.showMachines(event.orgId);
    return "unpaired";
  }
  if (event.action === "mute_machine") {
    await deps.muteMachine(event.orgId, event.machineId);
    return "muted";
  }
  const agentId = event.agentId as string;
  await deps.openAgent({ orgId: event.orgId, machineId: event.machineId, route: agentRoute(agentId, event.tabId) });
  await deps.push.clearDelivered({
    orgId: event.orgId,
    machineId: event.machineId,
    agentId,
    ...(event.tabId === undefined ? {} : { tabId: event.tabId }),
  });
  return "opened";
}
