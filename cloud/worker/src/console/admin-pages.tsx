/**
 * Admin console pages, part one: users, machines, phones, and their confirm pages.
 *
 * Tables carry the fields of 02's `AdminUser`, `AdminMachine` and `AdminDevice`; actions
 * are small forms for reversible changes (promote, demote, enable) and confirm pages for
 * destructive ones (disable, revoke, rotate, remove). Admin pages show the update banner.
 */
import type { AdminDevice, AdminMachine, AdminUser, UpdateStatus } from "@yaran/protocol";
import type { Child } from "hono/jsx";
import { Button, Checkbox, Chip, EmptyState, LinkButton, Notice, PostForm, RelativeTime, Table } from "./ui/components.tsx";
import { AlreadyRemoved, ConfirmBody } from "./ui/confirm.tsx";
import { ADMIN_NAV, Shell } from "./ui/shell.tsx";
import { S } from "./ui/strings.ts";
import { FlashNotice } from "./flash-notice.tsx";
import type { Flash } from "./flash.ts";

export interface AdminBase {
  orgName: string;
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
    <Shell title={p.title} orgName={p.orgName} nav={ADMIN_NAV} current={p.current} banner={<UpdateBanner update={p.update} />}>
      <FlashNotice flash={p.flash} />
      {p.children}
    </Shell>
  );
}

const enc = encodeURIComponent;

export function UsersPage(p: AdminBase & { users: readonly AdminUser[]; nextCursor: string | null }) {
  return (
    <AdminShell {...p} title={S.nav.users} current="/admin/users">
      <Table caption="Everyone who has signed in" headers={["Email", "Role", "Status", "Machines", "Phones", "Last seen", "Actions"]}>
        {p.users.map((u) => (
          <tr>
            <td>
              <Chip>{u.email}</Chip>
            </td>
            <td>{u.role}</td>
            <td>{u.disabled ? "disabled" : "active"}</td>
            <td>{u.machines}</td>
            <td>{u.devices}</td>
            <td>
              <RelativeTime iso={u.last_seen_at} />
            </td>
            <td class="row">
              <PostForm action={`/admin/users/${enc(u.id)}/role`} class="row">
                <input type="hidden" name="role" value={u.role === "admin" ? "user" : "admin"} />
                <Button variant="outline">{u.role === "admin" ? "Make user" : "Make admin"}</Button>
              </PostForm>
              {u.disabled ? (
                <PostForm action={`/admin/users/${enc(u.id)}/enable`} class="row">
                  <Button variant="outline">Enable</Button>
                </PostForm>
              ) : (
                <LinkButton href={`/admin/users/${enc(u.id)}/disable`} confirm>
                  Disable…
                </LinkButton>
              )}
            </td>
          </tr>
        ))}
      </Table>
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

export function AdminMachinesPage(p: AdminBase & { machines: readonly AdminMachine[]; staleIds: ReadonlySet<string>; nextCursor: string | null }) {
  return (
    <AdminShell {...p} title="Machines" current="/admin/machines">
      {p.machines.length === 0 ? (
        <EmptyState>No machines are paired in this org yet.</EmptyState>
      ) : (
        <Table caption="Every paired machine" headers={["Machine", "Owner", "Status", "Key fingerprint", "Origin port", "Provisioning", "Token", "Paired", "Protocol", "Actions"]}>
          {p.machines.map((m) => (
            <tr>
              <td>
                <Chip>{m.name}</Chip>
                {p.staleIds.has(m.id) ? <span class="muted"> ({S.machines.stale})</span> : null}
              </td>
              <td>
                <Chip>{m.owner_email}</Chip>
              </td>
              <td>{m.status}</td>
              <td>
                <Chip>{m.key_fingerprint}</Chip>
              </td>
              <td>{m.origin_port}</td>
              <td>
                {m.provisioning.state}
                {m.provisioning.last_error_code ? <Chip>{m.provisioning.last_error_code}</Chip> : null}
              </td>
              <td>v{m.token_version}</td>
              <td>
                <RelativeTime iso={m.paired_at} />
              </td>
              <td>{m.reported_protocol ?? "unknown"}</td>
              <td class="row">
                <LinkButton href={`/admin/machines/${enc(m.id)}/revoke`} confirm>
                  Revoke…
                </LinkButton>
                <LinkButton href={`/admin/machines/${enc(m.id)}/rotate`} confirm>
                  Rotate tunnel token…
                </LinkButton>
              </td>
            </tr>
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

export function AdminDevicesPage(p: AdminBase & { devices: readonly AdminDevice[]; nextCursor: string | null }) {
  return (
    <AdminShell {...p} title="Phones" current="/admin/devices">
      {p.devices.length === 0 ? (
        <EmptyState>No phones are registered in this org yet.</EmptyState>
      ) : (
        <Table caption="Every registered phone" headers={["Phone", "Owner", "Platform", "Push", "App", "Last seen", "Actions"]}>
          {p.devices.map((d) => (
            <tr>
              <td>
                <Chip>{d.label}</Chip>
              </td>
              <td>
                <Chip>{d.owner_email}</Chip>
              </td>
              <td>
                {d.platform} ({d.flavor})
              </td>
              <td>
                {d.push.channel ?? "none"}: {S.pushState[d.push_state]}
              </td>
              <td>{d.app_version}</td>
              <td>
                <RelativeTime iso={d.last_seen_at} />
              </td>
              <td>
                <LinkButton href={`/admin/devices/${enc(d.id)}/remove`} confirm>
                  Remove…
                </LinkButton>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {p.nextCursor ? <LinkButton href={`/admin/devices?cursor=${enc(p.nextCursor)}`}>Next page</LinkButton> : null}
    </AdminShell>
  );
}
