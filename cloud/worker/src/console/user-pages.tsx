/**
 * The user console (02 W30): my machines, my phones, connect a phone, connect a machine.
 *
 * Built on 06's view models (`MachineSummary`, `Device`) and QR helper. Each destructive
 * action is a confirm page; each outcome comes back as a flash notice naming the target.
 * Machines cannot be renamed, and the page says how to get a new name instead.
 */
import type { AdminDevice, AdminMachine } from "@yaran/protocol";
import { raw } from "hono/html";
import { Chip, CopyField, EmptyState, LinkButton, RelativeTime, Table, Checkbox } from "./ui/components.tsx";
import { AlreadyRemoved, ConfirmBody } from "./ui/confirm.tsx";
import { Shell, USER_NAV } from "./ui/shell.tsx";
import { S } from "./ui/strings.ts";
import { FlashNotice } from "./flash-notice.tsx";
import type { Flash } from "./flash.ts";

export interface UserPageBase {
  orgName: string;
  flash: Flash | null;
  isAdmin: boolean;
}

const nav = (isAdmin: boolean) => (isAdmin ? [...USER_NAV, { href: "/admin/users", label: "Admin" }] : USER_NAV);

export function MachinesPage(p: UserPageBase & { machines: readonly AdminMachine[]; staleIds: ReadonlySet<string> }) {
  return (
    <Shell title={S.nav.machines} orgName={p.orgName} nav={nav(p.isAdmin)} current="/console">
      <FlashNotice flash={p.flash} />
      <p class="muted">{S.machines.renameHint}</p>
      {p.machines.length === 0 ? (
        <EmptyState>{S.machines.empty}</EmptyState>
      ) : (
        <Table caption="Machines paired to your account" headers={["Machine", "Status", "Last seen", "Address", "Actions"]}>
          {p.machines.map((m) => (
            <tr>
              <td>
                <Chip>{m.name}</Chip>
                {p.staleIds.has(m.id) ? <span class="muted"> ({S.machines.stale})</span> : null}
              </td>
              <td>{m.status}</td>
              <td>
                <RelativeTime iso={m.last_seen_at ?? null} />
              </td>
              <td>
                <a href={m.url}>{m.hostname}</a>
              </td>
              <td>
                <LinkButton href={`/console/machines/${encodeURIComponent(m.id)}/unpair`} confirm>
                  {S.machines.unpair}
                </LinkButton>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Shell>
  );
}

export function UnpairConfirmPage(p: { orgName: string; machine: AdminMachine | null; id: string }) {
  return (
    <Shell title={S.machines.unpair.replace("…", "")} orgName={p.orgName} nav={USER_NAV}>
      {p.machine ? (
        <ConfirmBody
          lead={S.machines.unpairLead}
          target={p.machine.name}
          consequence={S.machines.unpairConsequence}
          action={`/console/machines/${encodeURIComponent(p.id)}/unpair`}
          cancelHref="/console"
          confirmLabel="Unpair"
        />
      ) : (
        <AlreadyRemoved what="The machine" target={p.id} backHref="/console" />
      )}
    </Shell>
  );
}

function pushWords(d: AdminDevice): string {
  return S.pushState[d.push_state];
}

function muteWords(d: AdminDevice): string {
  if (d.mute_all) return "all machines muted";
  if (d.muted_until) return `muted until ${d.muted_until}`;
  return d.muted_machine_ids.length ? `${d.muted_machine_ids.length} machines muted` : "not muted";
}

export function PhonesPage(p: UserPageBase & { devices: readonly AdminDevice[] }) {
  return (
    <Shell title={S.nav.phones} orgName={p.orgName} nav={nav(p.isAdmin)} current="/console/phones">
      <FlashNotice flash={p.flash} />
      {p.devices.length === 0 ? (
        <EmptyState>{S.phones.empty}</EmptyState>
      ) : (
        <Table caption="Phones registered to your account" headers={["Phone", "Platform", "Push", "Mutes", "App", "Last seen", "Actions"]}>
          {p.devices.map((d) => (
            <tr>
              <td>
                <Chip>{d.label}</Chip>
              </td>
              <td>
                {d.platform} ({d.flavor})
              </td>
              <td>
                {d.push.channel ?? "none"}: {pushWords(d)}
              </td>
              <td>{muteWords(d)}</td>
              <td>{d.app_version}</td>
              <td>
                <RelativeTime iso={d.last_seen_at} />
              </td>
              <td>
                <LinkButton href={`/console/phones/${encodeURIComponent(d.id)}/remove`} confirm>
                  {S.phones.remove}
                </LinkButton>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Shell>
  );
}

export function RemovePhoneConfirmPage(p: { orgName: string; device: AdminDevice | null; id: string; action: string; backHref: string; withSignOut: boolean }) {
  return (
    <Shell title={S.phones.remove.replace("…", "")} orgName={p.orgName} nav={USER_NAV}>
      {p.device ? (
        <ConfirmBody
          lead={S.phones.removeLead}
          target={p.device.label}
          consequence={S.phones.removeConsequence}
          action={p.action}
          cancelHref={p.backHref}
          confirmLabel="Remove"
          extra={p.withSignOut ? <Checkbox id="sign_out_everywhere" label={S.phones.signOut} hint={S.phones.signOutHint} /> : undefined}
        />
      ) : (
        <AlreadyRemoved what="The phone" target={p.id} backHref={p.backHref} />
      )}
    </Shell>
  );
}

export interface ConnectProps extends UserPageBase {
  orgUrl: string;
  qrSvg: string;
  storeLinks: readonly { label: string; href: string }[];
}

export function ConnectPage(p: ConnectProps) {
  return (
    <Shell title={S.nav.connect} orgName={p.orgName} nav={nav(p.isAdmin)} current="/console/connect">
      <h2>{S.connect.phoneHeading}</h2>
      <p>
        {S.connect.phoneLead} <Chip>{p.orgUrl}</Chip>
      </p>
      {/* 06's phoneQrSvg emits a static SVG with no script or style attribute (06 tests that). */}
      <div class="qr" role="img" aria-label={`QR code for ${p.orgUrl}`}>
        {raw(p.qrSvg)}
      </div>
      <h3>{S.connect.stores}</h3>
      <ul>
        {p.storeLinks.map((l) => (
          <li>
            <a href={l.href}>{l.label}</a>
          </li>
        ))}
      </ul>
      <h2>{S.connect.machineHeading}</h2>
      <p>{S.connect.machineLead}</p>
      <CopyField id="login-cmd" label="Command" value={`yaran cloud login ${p.orgUrl}`} />
    </Shell>
  );
}
