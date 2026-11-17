/**
 * The user console (02 W30): my machines, my phones, connect a phone, connect a machine.
 *
 * Built on 06's view models (`MachineSummary`, `Device`) and QR helper. Each destructive
 * action is a confirm page; each outcome comes back as a flash notice naming the target.
 * Machines cannot be renamed, and the page says how to get a new name instead.
 *
 * <module-headers:begin>
 * Uses:
 * src/console/user-pages.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── src/console/flash-notice.tsx
 * ├── src/console/flash.ts
 * ├── src/console/ui/components.tsx
 * ├── src/console/ui/confirm.tsx
 * ├── src/console/ui/shell.tsx
 * └── src/console/ui/strings.ts
 * External: hono
 *
 * Used by:
 * src/console/user-pages.tsx
 * ├── src/console/admin-pages.tsx
 * ├── src/console/admin-routes.ts
 * ├── src/console/routes.ts
 * └── test/node/ui-kit.test.tsx
 * <module-headers:end>
 */
import type { AdminDevice, AdminMachine } from "@yaran/protocol";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { CopyField, EmptyState, LinkButton, MachineState, RelativeTime, Row, Status, Table, Checkbox } from "./ui/components.tsx";
import { AlreadyRemoved, ConfirmBody } from "./ui/confirm.tsx";
import { Shell, USER_NAV } from "./ui/shell.tsx";
import { S } from "./ui/strings.ts";
import { FlashNotice } from "./flash-notice.tsx";
import type { Flash } from "./flash.ts";

export interface UserPageBase {
  orgName: string;
  signedInAs?: string;
  flash: Flash | null;
  isAdmin: boolean;
}

const nav = (isAdmin: boolean) => (isAdmin ? [...USER_NAV, { href: "/admin/users", label: S.nav.admin }] : USER_NAV);

const MACHINE_COLS = ["Machine", "Status", "Last seen", "Address", S.actions] as const;
const PHONE_COLS = ["Phone", "Platform", "Push", "Mutes", "App", "Last seen", S.actions] as const;

export function MachinesPage(p: UserPageBase & { machines: readonly AdminMachine[]; staleIds: ReadonlySet<string> }) {
  return (
    <Shell title={S.nav.machines} orgName={p.orgName} signedInAs={p.signedInAs} nav={nav(p.isAdmin)} current="/console">
      <FlashNotice flash={p.flash} />
      <p class="muted">{S.machines.renameHint}</p>
      {p.machines.length === 0 ? (
        <EmptyState action={<LinkButton href="/console/connect#connect-machine" variant="primary">{S.machines.emptyAction}</LinkButton>}>{S.machines.empty}</EmptyState>
      ) : (
        <Table caption="Machines paired to your account" headers={MACHINE_COLS}>
          {p.machines.map((m) => (
            <Row
              headers={MACHINE_COLS}
              cells={[
                <>
                  <strong class="name">{m.name}</strong>
                  {p.staleIds.has(m.id) ? <span class="muted"> ({S.machines.stale})</span> : null}
                </>,
                <MachineState status={m.status} />,
                <RelativeTime iso={m.last_seen_at ?? null} />,
                <a class="name" href={m.url}>
                  {m.hostname}
                </a>,
                <LinkButton href={`/console/machines/${encodeURIComponent(m.id)}/unpair`} confirm>
                  {S.machines.unpair}
                </LinkButton>,
              ]}
            />
          ))}
        </Table>
      )}
    </Shell>
  );
}

export function UnpairConfirmPage(p: { orgName: string; signedInAs?: string; machine: AdminMachine | null; id: string }) {
  return (
    <Shell title={S.machines.unpair.replace("…", "")} orgName={p.orgName} signedInAs={p.signedInAs} nav={USER_NAV}>
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

/** "Android, F-Droid build"; shared by the user and admin phone lists. */
export function platformWords(d: AdminDevice): string {
  return `${S.platform[d.platform] ?? d.platform}, ${S.flavor[d.flavor] ?? d.flavor}`;
}

/** The push state as a status, with the channel it uses as a quiet second line. */
export function PushCell(props: { device: AdminDevice }) {
  const d = props.device;
  return (
    <>
      <Status tone={S.pushTone[d.push_state] ?? "off"}>{S.pushState[d.push_state] ?? d.push_state}</Status>
      {d.push.channel ? <span class="muted sub">via {S.pushChannel[d.push.channel] ?? d.push.channel}</span> : null}
    </>
  );
}

export function muteWords(d: Pick<AdminDevice, "mute_all" | "muted_until" | "muted_machine_ids">): Child {
  if (d.mute_all) return "all machines muted";
  if (d.muted_until) {
    return (
      <>
        muted until <RelativeTime iso={d.muted_until} />
      </>
    );
  }
  const n = d.muted_machine_ids.length;
  return n ? `${n} ${n === 1 ? "machine" : "machines"} muted` : "not muted";
}

export function PhonesPage(p: UserPageBase & { devices: readonly AdminDevice[] }) {
  return (
    <Shell title={S.nav.phones} orgName={p.orgName} signedInAs={p.signedInAs} nav={nav(p.isAdmin)} current="/console/phones">
      <FlashNotice flash={p.flash} />
      {p.devices.length === 0 ? (
        <EmptyState action={<LinkButton href="/console/connect" variant="primary">{S.phones.emptyAction}</LinkButton>}>{S.phones.empty}</EmptyState>
      ) : (
        <Table caption="Phones registered to your account" headers={PHONE_COLS}>
          {p.devices.map((d) => (
            <Row
              headers={PHONE_COLS}
              cells={[
                <strong class="name">{d.label}</strong>,
                platformWords(d),
                <PushCell device={d} />,
                muteWords(d),
                d.app_version,
                <RelativeTime iso={d.last_seen_at} />,
                <LinkButton href={`/console/phones/${encodeURIComponent(d.id)}/remove`} confirm>
                  {S.phones.remove}
                </LinkButton>,
              ]}
            />
          ))}
        </Table>
      )}
    </Shell>
  );
}

export function RemovePhoneConfirmPage(p: { orgName: string; signedInAs?: string; device: AdminDevice | null; id: string; action: string; backHref: string; withSignOut: boolean }) {
  return (
    <Shell title={S.phones.remove.replace("…", "")} orgName={p.orgName} signedInAs={p.signedInAs} nav={USER_NAV}>
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
    <Shell title={S.nav.connect} orgName={p.orgName} signedInAs={p.signedInAs} nav={nav(p.isAdmin)} current="/console/connect">
      <h2 id="connect-phone">{S.connect.phoneHeading}</h2>
      <CopyField id="org-url" label={S.connect.addressLabel} value={p.orgUrl} hint={S.connect.addressHint} />
      <p>{S.connect.phoneLead}</p>
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
      <h2 id="connect-machine">{S.connect.machineHeading}</h2>
      <p>{S.connect.machineLead}</p>
      <CopyField id="login-cmd" label="Command" value={`yaran cloud login ${p.orgUrl}`} />
    </Shell>
  );
}
