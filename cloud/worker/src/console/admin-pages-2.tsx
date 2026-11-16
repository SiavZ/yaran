/**
 * Admin console pages, part two: audit log, settings, health (with the push key rotation
 * confirm) and updates.
 *
 * The settings form is generated from `SETTINGS_FIELDS` (02's `Settings`), so it renders
 * exactly the contract with each field's range as its hint. Health re-reads Cloudflare and
 * re-runs the wiring self-test. Updates shows `UpdateStatus` honestly: a failed check reads
 * "couldn't check", never "up to date".
 *
 * <module-headers:begin>
 * Uses:
 * src/console/admin-pages-2.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── src/admin/audit-query.ts
 * ├── src/admin/health.ts
 * ├── src/admin/ports.ts
 * ├── src/admin/settings-schema.ts
 * ├── src/console/admin-pages.tsx
 * ├── src/console/ui/components.tsx
 * ├── src/console/ui/confirm.tsx
 * ├── src/setup/capability-probe.ts
 * ├── src/setup/pages-steps.tsx
 * └── src/setup/pages.tsx
 * External: none
 *
 * Used by:
 * src/console/admin-pages-2.tsx
 * └── src/console/admin-routes.ts
 * <module-headers:end>
 */
import type { AuditEntry, Settings, UpdateStatus } from "@yaran/protocol";
import { Button, Checkbox, Chip, EmptyState, Field, LinkButton, Notice, PostForm, RelativeTime, Table } from "./ui/components.tsx";
import { SelfTest } from "../setup/pages-steps.tsx";
import { ProbeChecklist } from "../setup/pages.tsx";
import type { ProbeRow } from "../setup/capability-probe.ts";
import { getPath, SETTINGS_FIELDS } from "../admin/settings-schema.ts";
import type { HealthCheck } from "../admin/health.ts";
import type { AuditFilter } from "../admin/audit-query.ts";
import { assertNever } from "../admin/ports.ts";
import { AdminShell, type AdminBase } from "./admin-pages.tsx";
import { ConfirmBody } from "./ui/confirm.tsx";

const enc = encodeURIComponent;

export function AuditPage(p: AdminBase & { filter: AuditFilter; items: readonly AuditEntry[]; nextCursor: string | null }) {
  const qs = new URLSearchParams(Object.entries(p.filter).filter(([, v]) => v) as [string, string][]).toString();
  return (
    <AdminShell {...p} title="Audit log" current="/admin/audit">
      <form method="get" action="/admin/audit" class="stack">
        <div class="row">
          <Field id="actor" label="Actor (email or id)" value={p.filter.actor ?? ""} />
          <Field id="action" label="Action" value={p.filter.action ?? ""} hint="For example machine.revoked." />
          <Field id="target" label="Target" value={p.filter.target ?? ""} hint="kind or kind:id, for example user:1234." />
          <Field id="since" label="From (UTC)" value={p.filter.since ?? ""} hint="2026-11-01T00:00:00Z" />
          <Field id="until" label="To (UTC)" value={p.filter.until ?? ""} />
        </div>
        <div class="row">
          <Button variant="outline">Filter</Button>
          <LinkButton href={`/admin/audit/export${qs ? `?${qs}` : ""}`}>Export JSON Lines</LinkButton>
        </div>
      </form>
      {p.items.length === 0 ? (
        <EmptyState>No audit entries match this filter.</EmptyState>
      ) : (
        <Table caption="Audit entries, newest first" headers={["When", "Actor", "Action", "Target", "Result"]}>
          {p.items.map((e) => (
            <tr>
              <td>
                <RelativeTime iso={e.ts} />
              </td>
              <td>{e.actor.email ? <Chip>{e.actor.email}</Chip> : e.actor.kind}</td>
              <td>
                <Chip>{e.action}</Chip>
              </td>
              <td>
                {e.target.kind}
                {e.target.id ? <Chip>{e.target.id}</Chip> : null}
              </td>
              <td>{e.result === "ok" ? "ok" : `error ${e.error_code ?? ""}`}</td>
            </tr>
          ))}
        </Table>
      )}
      {p.nextCursor ? <LinkButton href={`/admin/audit?${qs ? `${qs}&` : ""}cursor=${enc(p.nextCursor)}`}>Older entries</LinkButton> : null}
    </AdminShell>
  );
}

function fieldValue(v: unknown): string {
  if (Array.isArray(v)) return v.join("\n");
  return v === null || v === undefined ? "" : String(v);
}

export function SettingsPage(p: AdminBase & { settings: unknown; zoneName: string; errors?: readonly { path: string; message: string }[] }) {
  const errorFor = (path: string) => p.errors?.find((e) => e.path === `/${path.replaceAll(".", "/")}` || e.path.startsWith(`/${path.replaceAll(".", "/")}/`))?.message;
  return (
    <AdminShell {...p} title="Settings" current="/admin/settings">
      {p.errors?.length ? <Notice tone="error">Nothing was saved: fix the fields marked below (validation_failed).</Notice> : null}
      <p>
        Zone: <Chip>{p.zoneName}</Chip>. It is fixed once setup closes, because every machine hostname lives under it; moving zones means a new control plane.
      </p>
      <PostForm action="/admin/settings">
        {SETTINGS_FIELDS.map((f) => {
          const v = getPath(p.settings, f.path);
          const error = errorFor(f.path);
          switch (f.kind) {
            case "checkbox":
              return <Checkbox id={f.path} label={f.label} hint={f.hint} checked={v === true} />;
            case "select":
              return <Field id={f.path} label={f.label} hint={f.hint} options={f.options ?? []} value={fieldValue(v)} {...(error ? { error } : {})} />;
            case "lines":
              return <Field id={f.path} label={f.label} hint={f.hint} multiline value={fieldValue(v)} {...(error ? { error } : {})} />;
            case "number":
            case "nullable_number":
              return <Field id={f.path} label={f.label} hint={f.hint} type="number" value={fieldValue(v)} {...(error ? { error } : {})} />;
            case "text":
              return <Field id={f.path} label={f.label} hint={f.hint} value={fieldValue(v)} {...(error ? { error } : {})} />;
            default:
              return assertNever(f.kind);
          }
        })}
        <div class="row">
          <Button>Save settings</Button>
        </div>
      </PostForm>
    </AdminShell>
  );
}

const CHECK_LABEL: Record<HealthCheck["id"], string> = {
  access_app: "Control-plane Access application",
  public_paths: "Public paths /v1/meta and /v1/machine/*",
  policy: "Access policy",
  custom_domain: "Custom domain",
  workers_dev_off: "workers.dev address off",
  idps: "Sign-in methods",
  quota_apps: "Access application quota",
  quota_policies: "Access policy quota",
  quota_tunnels: "Tunnel quota",
  reconcile: "Reconciliation",
};

export function HealthPage(p: AdminBase & { checks: readonly HealthCheck[]; probe?: readonly ProbeRow[] }) {
  const workersDevOn = p.checks.find((c) => c.id === "workers_dev_off")?.ok === false;
  return (
    <AdminShell {...p} title="Health" current="/admin/health">
      <ul class="checklist">
        {p.checks.map((c) => (
          <li>
            <strong>{c.ok === null ? "unknown" : c.ok ? "ok" : "needs attention"}</strong>: {CHECK_LABEL[c.id]}. {c.detail}
          </li>
        ))}
      </ul>
      <h2>Wiring self-test</h2>
      <SelfTest />
      <div class="row">
        <LinkButton href="/admin/health">Re-run checks</LinkButton>
        {workersDevOn ? (
          <PostForm action="/admin/health/disable-workers-dev" class="row">
            <Button variant="outline">Disable workers.dev</Button>
          </PostForm>
        ) : null}
      </div>
      <h2>Replace the API token</h2>
      {p.probe ? (
        <>
          <Notice tone="error">The new token is missing permissions, so the old one was kept.</Notice>
          <ProbeChecklist rows={p.probe} />
        </>
      ) : null}
      <PostForm action="/admin/health/replace-token">
        <Field id="token" label="New API token" type="password" autocomplete="off" hint="Every permission is checked before the old token is overwritten." required />
        <div class="row">
          <Button variant="outline">Check and replace</Button>
        </div>
      </PostForm>
      <h2>Rotate the push keys</h2>
      <p>Do this if the push private key may have leaked, or after a lost DATA_KEY made it unreadable. Every phone then has to register again.</p>
      <div class="row">
        <LinkButton href="/admin/push-keys/rotate" variant="outline">
          Rotate push keys…
        </LinkButton>
      </div>
    </AdminShell>
  );
}

export function PushKeysConfirm(p: AdminBase) {
  return (
    <AdminShell {...p} title="Rotate push keys" current="/admin/health">
      <ConfirmBody
        lead="Rotate the push keys of"
        target={p.orgName}
        consequence="A new key pair replaces the old one, which cannot be brought back. Every phone stops getting notifications until its app registers again with the new key, which it does by itself the next time it opens."
        action="/admin/push-keys/rotate"
        cancelHref="/admin/health"
        confirmLabel="Rotate"
      />
    </AdminShell>
  );
}

export function UpdatesPage(p: AdminBase & { status: UpdateStatus; settings: Settings }) {
  const s = p.status;
  return (
    <AdminShell {...p} title="Updates" current="/admin/updates">
      {s.error ? (
        <Notice tone="warn">
          Couldn't check for updates at <RelativeTime iso={s.checked_at} />: {s.error}. This does not mean you are up to date.
        </Notice>
      ) : s.update_available ? (
        <Notice tone={s.security ? "error" : "info"}>
          Version <Chip>{s.latest ?? ""}</Chip> is available{s.security ? " and fixes a security issue" : ""}; you run <Chip>{s.current}</Chip>.
        </Notice>
      ) : (
        <Notice tone="success">
          You run <Chip>{s.current}</Chip>, the latest release, as of <RelativeTime iso={s.checked_at} />.
        </Notice>
      )}
      {s.notes_url ? (
        <p>
          <a href={s.notes_url}>Release notes</a>
        </p>
      ) : null}
      <PostForm action="/admin/updates/check" class="row">
        <Button variant="outline">Check now</Button>
      </PostForm>
      <h2>How to update</h2>
      <p>
        Your deploy repository carries a workflow, <Chip>yaran-cloud-update</Chip>, that runs weekly: it verifies the new release's checksum and provenance,
        updates the files yaran owns, keeps your Wrangler values, and opens a pull request. Merging it deploys the update, migrations first.
      </p>
      {p.settings.deployer_repo_url ? (
        <p>
          <a href={`${p.settings.deployer_repo_url}/actions/workflows/yaran-cloud-update.yml`}>Open the update workflow</a>
        </p>
      ) : (
        <p class="muted">Set Your deploy repository in Settings to get a direct link to the workflow.</p>
      )}
      <p>
        To update by hand, run <Chip>npm run update -- --version X.Y.Z</Chip> in your deploy repository, then commit, push and merge.
      </p>
    </AdminShell>
  );
}
