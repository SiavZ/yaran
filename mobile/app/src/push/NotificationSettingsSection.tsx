/**
 * The Notifications section Phase 14's Settings screen mounts: one row per org with its push
 * state, the row's one action, mute controls per org and per machine, the off switch, and the
 * UnifiedPush distributor picker on Android.
 *
 * - Presentation only: every effect is a callback; the screen wires them to the orchestration
 *   in pushRegistration.ts, 14's destructive confirm (the off switch) and 14's toasts.
 * - Strings come through 14's translator over pushStrings.ts keys; colors are the shell's
 *   ui-kit token classes; every control keeps the 40px touch floor.
 *
 * <module-headers:begin>
 * Uses:
 * mobile/app/src/push/NotificationSettingsSection.tsx
 * ├── mobile/app/src/push/pushPermission.ts
 * └── mobile/app/src/push/pushStrings.ts
 * External: @yaran/push
 *
 * Used by:
 * mobile/app/src/push/NotificationSettingsSection.tsx
 * └── mobile/app/src/push/NotificationSettingsSection.test.tsx
 * <module-headers:end>
 */
import type { DistributorList } from "@yaran/push";
import { type OrgRowState, type RowAction, rowView } from "./pushPermission.ts";
import { DISTRIBUTORS_URL, type PushStringKey } from "./pushStrings.ts";

export interface NotificationOrgRow {
  orgId: string;
  orgName: string;
  state: OrgRowState;
  machines: { id: string; name: string; muted: boolean }[];
}

export interface NotificationSettingsProps {
  rows: NotificationOrgRow[];
  /** Android only; null hides the picker. */
  distributors: DistributorList | null;
  t: (key: PushStringKey, vars?: Record<string, string>) => string;
  onAction: (orgId: string, action: Exclude<RowAction, null>) => void;
  onTurnOff: (orgId: string) => void;
  onMuteOrg: (orgId: string, mode: "hour" | "forever") => void;
  onMuteMachine: (orgId: string, machineId: string, muted: boolean) => void;
  onSelectDistributor: (distributor: string) => void;
}

const ACTION_LABEL: Record<Exclude<RowAction, null>, PushStringKey> = {
  turn_on: "push.action.turn_on",
  allow: "push.action.allow",
  open_settings: "push.action.open_settings",
  distributors: "push.action.distributors",
  retry: "push.action.retry",
  unmute: "push.action.unmute",
};

const BUTTON = "h-10 rounded-md border border-border px-3 text-sm text-foreground hover:bg-accent";

function OrgRow({ row, props }: { row: NotificationOrgRow; props: NotificationSettingsProps }) {
  const view = rowView(row.state);
  const until = row.state.kind === "muted" && row.state.until ? row.state.until : "";
  return (
    <li className="flex flex-col gap-2 rounded-lg bg-card p-4" data-state={row.state.kind}>
      <div className="text-sm font-medium text-foreground">{row.orgName}</div>
      <div className="text-sm text-muted-foreground">{props.t(view.title, { until })}</div>
      {view.detail ? <div className="text-xs text-muted-foreground">{view.detail}</div> : null}
      {row.state.kind === "no_distributor" ? (
        <div className="text-xs text-muted-foreground">{props.t("push.row.no_distributor.detail")}</div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {view.action === "distributors" ? (
          <a className={`${BUTTON} inline-flex items-center`} href={DISTRIBUTORS_URL} target="_blank" rel="noreferrer">
            {props.t(ACTION_LABEL.distributors)}
          </a>
        ) : view.action ? (
          <button type="button" className={BUTTON} onClick={() => props.onAction(row.orgId, view.action as Exclude<RowAction, null>)}>
            {props.t(ACTION_LABEL[view.action])}
          </button>
        ) : null}
        {view.registered && row.state.kind !== "muted" ? (
          <>
            <button type="button" className={BUTTON} onClick={() => props.onMuteOrg(row.orgId, "hour")}>
              {props.t("push.action.mute_hour")}
            </button>
            <button type="button" className={BUTTON} onClick={() => props.onMuteOrg(row.orgId, "forever")}>
              {props.t("push.action.mute_forever")}
            </button>
          </>
        ) : null}
        {view.registered ? (
          <button type="button" className={BUTTON} onClick={() => props.onTurnOff(row.orgId)}>
            {props.t("push.action.turn_off")}
          </button>
        ) : null}
      </div>
      {view.registered && row.machines.length > 0 ? (
        <ul className="flex flex-col">
          {row.machines.map((m) => (
            <li key={m.id}>
              <label className="flex h-10 items-center justify-between gap-3 text-sm text-foreground">
                <span className="truncate">{m.name}</span>
                <input
                  type="checkbox"
                  className="size-5"
                  checked={!m.muted}
                  aria-label={m.name}
                  onChange={(e) => props.onMuteMachine(row.orgId, m.id, !e.currentTarget.checked)}
                />
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function NotificationSettingsSection(props: NotificationSettingsProps) {
  const d = props.distributors;
  return (
    <section className="flex flex-col gap-3">
      {d && d.distributors.length > 1 ? (
        <label className="flex h-10 items-center justify-between gap-3 text-sm text-foreground">
          <span>{props.t("push.distributor.label")}</span>
          <select
            className="h-10 rounded-md border border-border bg-background px-2"
            value={d.selected ?? ""}
            onChange={(e) => props.onSelectDistributor(e.currentTarget.value)}
          >
            {d.distributors.map((name) => (
              <option key={name} value={name}>
                {name === d.embedded ? props.t("push.distributor.embedded") : name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <ul className="flex flex-col gap-3">
        {props.rows.map((row) => (
          <OrgRow key={row.orgId} row={row} props={props} />
        ))}
      </ul>
    </section>
  );
}
