/**
 * Admin console pages, part one: users, machines, phones, and their confirm pages.
 *
 * Tables carry the fields of 02's `AdminUser`, `AdminMachine` and `AdminDevice`; actions
 * are small forms for reversible changes (promote, demote, enable) and confirm pages for
 * destructive ones (disable, revoke, rotate, remove). Admin pages show the update banner.
 *
 * <module-headers:begin>
 * Uses:
 * src/console/admin-pages.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── src/console/flash-notice.tsx
 * ├── src/console/flash.ts
 * ├── src/console/ui/components.tsx
 * ├── src/console/ui/confirm.tsx
 * ├── src/console/ui/shell.tsx
 * ├── src/console/ui/strings.ts
 * └── src/console/user-pages.tsx
 * External: hono
 *
 * Used by:
 * src/console/admin-pages.tsx
 * ├── src/console/admin-pages-2.tsx
 * └── src/console/admin-routes.ts
 * <module-headers:end>
 */
import type { AdminDevice, AdminMachine, AdminUser, UpdateStatus } from "@yaran/protocol";
import type { Child } from "hono/jsx";
import { Button, Checkbox, Chip, EmptyState, ErrorCode, LinkButton, MachineState, Notice, PostForm, RelativeTime, Row, Status, Table } from "./ui/components.tsx";
import { AlreadyRemoved, ConfirmBody } from "./ui/confirm.tsx";
import { ADMIN_NAV, Shell } from "./ui/shell.tsx";
import { S, type StatusTone } from "./ui/strings.ts";
import { FlashNotice } from "./flash-notice.tsx";
import type { Flash } from "./flash.ts";
import { platformWords, PushCell } from "./user-pages.tsx";

export interface AdminBase {
  orgName: string;
  signedInAs?: string;
  flash: Flash | null;
  update: UpdateStatus | null;
}

export function UpdateBanner(props: { update: UpdateStatus | null }) {
  const u = props.update;
  if (!u?.update_available || !u.latest) return null;
  return (
    <div class="banner">
      <Notice tone={u.security ? "error" : "info"}>
        {u.security ? "A security update is available: " : "An update is available: "}
        <Chip>{u.latest}</Chip> (you run <Chip>{u.current}</Chip>). <a href="/admin/updates">See how to update</a>.
      </Notice>
    </div>
  );
}

export function AdminShell(p: AdminBase & { title: string; current: string; children: Child }) {
  return (
    <Shell title={p.title} orgName={p.orgName} signedInAs={p.signedInAs} context={S.nav.adminContext} nav={ADMIN_NAV} current={p.current} banner={<UpdateBanner update={p.update} />}>
      <FlashNotice flash={p.flash} />
      {p.children}
    </Shell>
  );
}

const enc = encodeURIComponent;

type ProvisioningState = AdminMachine["provisioning"]["state"];
const PROVISIONING_WORD: Record<ProvisioningState, string> = { complete: "Set up", in_progress: "In progress", failed: "Failed", compensating: "Rolling back" };
const PROVISIONING_TONE: Record<ProvisioningState, StatusTone> = { complete: "ok", in_progress: "info", failed: "error", compensating: "warn" };

const USER_COLS = ["Email", "Role", "Status", "Machines", "Phones", "Last seen", S.actions] as const;

export function UsersPage(p: AdminBase & { users: readonly AdminUser[]; nextCursor: string | null }) {
  return (
    <AdminShell {...p} title={S.nav.users} current="/admin/users">
      {p.users.length === 0 ? (
        <EmptyState>Nobody has signed in yet. People appear here after their first sign-in to this console.</EmptyState>
      ) : (
        <Table caption="Everyone who has signed in" headers={USER_COLS}>
          {p.users.map((u) => (
            <Row
              headers={USER_COLS}
              cells={[
                <span class="name">{u.email}</span>,
                S.role[u.role] ?? u.role,
                u.disabled ? <Status tone="error">{S.users.disabled}</Status> : <Status tone="ok">{S.users.active}</Status>,
                u.machines,
                u.devices,
                <RelativeTime iso={u.last_seen_at} />,
                <>
                  {/* Promoting adds rights and stays one click; demoting removes them, so it confirms first. */}
                  {u.role === "admin" ? (
                    <LinkButton href={`/admin/users/${enc(u.id)}/role`} confirm>
                      {S.users.demote}
                    </LinkButton>
                  ) : (
                    <PostForm action={`/admin/users/${enc(u.id)}/role`} class="row">
                      <input type="hidden" name="role" value="admin" />
                      <Button variant="outline">Make admin</Button>
                    </PostForm>
                  )}
                  {u.disabled ? (
                    <PostForm action={`/admin/users/${enc(u.id)}/enable`} class="row">
                      <Button variant="outline">Enable</Button>
                    </PostForm>
                  ) : (
                    <LinkButton href={`/admin/users/${enc(u.id)}/disable`} confirm>
                      Disable…
                    </LinkButton>
                  )}
                </>,
              ]}
            />
          ))}
        </Table>
      )}
      {p.nextCursor ? <LinkButton href={`/admin/users?cursor=${enc(p.nextCursor)}`}>Next page</LinkButton> : null}
    </AdminShell>
  );
}

export function DisableUserConfirm(p: AdminBase & { user: AdminUser | null; id: string }) {
  return (
    <AdminShell {...p} title="Disable user" current="/admin/users">
      {p.user ? (
        <ConfirmBody
          lead="Disable"
          target={p.user.email}
          consequence="They can no longer sign in to the console or pair anything. Their machines and phones keep working unless you also revoke them below."
          action={`/admin/users/${enc(p.id)}/disable`}
          cancelHref="/admin/users"
          confirmLabel="Disable"
          extra={
            <Checkbox
              id="revoke_all"
              label="Also revoke all their machines and phones and sign them out"
              hint="Tears down every machine's tunnel and Access application, removes every phone, and ends their Access sessions. This cannot be undone; they would pair again from scratch."
            />
          }
        />
      ) : (
        <AlreadyRemoved what="The user" target={p.id} backHref="/admin/users" />
      )}
    </AdminShell>
  );
}

/** The confirm page for taking admin rights away; the POST it sends is the same role form. */
export function DemoteUserConfirm(p: AdminBase & { user: AdminUser | null; id: string; self: boolean }) {
  return (
    <AdminShell {...p} title={S.users.demoteTitle} current="/admin/users">
      {!p.user ? (
        <AlreadyRemoved what="The user" target={p.id} backHref="/admin/users" />
      ) : p.user.role !== "admin" ? (
        <div class="confirm">
          <Notice tone="info">
            <Chip>{p.user.email}</Chip> is already a member, so there is nothing to change.
          </Notice>
          <LinkButton href="/admin/users" variant="outline" autofocus>
            {S.back}
          </LinkButton>
        </div>
      ) : (
        <ConfirmBody
          lead={S.users.demoteLead}
          target={p.user.email}
          consequence={
            p.self
              ? "This is your own account: you lose the admin console as soon as you confirm, and only another admin can give it back. Your machines and phones keep working."
              : "They lose the admin console but keep their machines and phones. Any admin can make them an admin again."
          }
          action={`/admin/users/${enc(p.id)}/role`}
          cancelHref="/admin/users"
          confirmLabel={S.users.demoteTitle}
          extra={<input type="hidden" name="role" value="user" />}
        />
      )}
    </AdminShell>
  );
}

const ADMIN_MACHINE_COLS = ["Machine", "Owner", "Status", "Key fingerprint", "Origin port", "Provisioning", "Token", "Paired", "Protocol", S.actions] as const;

export function AdminMachinesPage(p: AdminBase & { machines: readonly AdminMachine[]; staleIds: ReadonlySet<string>; nextCursor: string | null }) {
  return (
    <AdminShell {...p} title="Machines" current="/admin/machines">
      {p.machines.length === 0 ? (
        <EmptyState action={<LinkButton href="/console/connect#connect-machine">How to pair a machine</LinkButton>}>No machines are paired in this org yet.</EmptyState>
      ) : (
        <Table caption="Every paired machine" headers={ADMIN_MACHINE_COLS}>
          {p.machines.map((m) => (
            <Row
              headers={ADMIN_MACHINE_COLS}
              cells={[
                <>
                  <strong class="name">{m.name}</strong>
                  {p.staleIds.has(m.id) ? <span class="muted"> ({S.machines.stale})</span> : null}
                </>,
                <span class="name">{m.owner_email}</span>,
                <MachineState status={m.status} />,
                <span class="mono name">{m.key_fingerprint}</span>,
                m.origin_port,
                <>
                  <Status tone={PROVISIONING_TONE[m.provisioning.state] ?? "off"}>{PROVISIONING_WORD[m.provisioning.state] ?? m.provisioning.state}</Status>
                  {m.provisioning.last_error_code ? <ErrorCode code={m.provisioning.last_error_code} /> : null}
                </>,
                `v${m.token_version}`,
                <RelativeTime iso={m.paired_at} />,
                m.reported_protocol ?? "unknown",
                <>
                  <LinkButton href={`/admin/machines/${enc(m.id)}/revoke`} confirm>
                    Revoke…
                  </LinkButton>
                  <LinkButton href={`/admin/machines/${enc(m.id)}/rotate`} confirm>
                    Rotate tunnel token…
                  </LinkButton>
                </>,
              ]}
            />
          ))}
        </Table>
      )}
      {p.nextCursor ? <LinkButton href={`/admin/machines?cursor=${enc(p.nextCursor)}`}>Next page</LinkButton> : null}
    </AdminShell>
  );
}

export function MachineConfirm(p: AdminBase & { machine: AdminMachine | null; id: string; verb: "revoke" | "rotate" }) {
  const rotate = p.verb === "rotate";
  return (
    <AdminShell {...p} title={rotate ? "Rotate tunnel token" : "Revoke machine"} current="/admin/machines">
      {p.machine ? (
        <ConfirmBody
          lead={rotate ? "Rotate the tunnel token of" : "Revoke the machine"}
          target={p.machine.name}
          consequence={
            rotate
              ? "The machine receives a new tunnel token on its next signed call. Without the box below, open connections keep running until then."
              : "Its tunnel, DNS record and Access application are deleted, and its owner has to pair it again to use it."
          }
          action={`/admin/machines/${enc(p.id)}/${p.verb}`}
          cancelHref="/admin/machines"
          confirmLabel={rotate ? "Rotate" : "Revoke"}
          extra={rotate ? <Checkbox id="kill_connections" label="Also cut the machine's open connections now" /> : undefined}
        />
      ) : (
        <AlreadyRemoved what="The machine" target={p.id} backHref="/admin/machines" />
      )}
    </AdminShell>
  );
}

const ADMIN_PHONE_COLS = ["Phone", "Owner", "Platform", "Push", "App", "Last seen", S.actions] as const;

export function AdminDevicesPage(p: AdminBase & { devices: readonly AdminDevice[]; nextCursor: string | null }) {
  return (
    <AdminShell {...p} title="Phones" current="/admin/devices">
      {p.devices.length === 0 ? (
        <EmptyState action={<LinkButton href="/console/connect">How to connect a phone</LinkButton>}>No phones are registered in this org yet.</EmptyState>
      ) : (
        <Table caption="Every registered phone" headers={ADMIN_PHONE_COLS}>
          {p.devices.map((d) => (
            <Row
              headers={ADMIN_PHONE_COLS}
              cells={[
                <strong class="name">{d.label}</strong>,
                <span class="name">{d.owner_email}</span>,
                platformWords(d),
                <PushCell device={d} />,
                d.app_version,
                <RelativeTime iso={d.last_seen_at} />,
                <LinkButton href={`/admin/devices/${enc(d.id)}/remove`} confirm>
                  Remove…
                </LinkButton>,
              ]}
            />
          ))}
        </Table>
      )}
      {p.nextCursor ? <LinkButton href={`/admin/devices?cursor=${enc(p.nextCursor)}`}>Next page</LinkButton> : null}
    </AdminShell>
  );
}
