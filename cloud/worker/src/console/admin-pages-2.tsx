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
 * ├── src/console/admin-routes.ts
 * └── test/node/ui-kit.test.tsx
 * <module-headers:end>
 */
import type { AuditEntry, Settings, UpdateStatus } from "@yaran/protocol";
import { breakable, Button, Checkbox, Chip, EmptyState, ErrorCode, Field, LinkButton, Notice, PostForm, RelativeTime, Row, Status, Table } from "./ui/components.tsx";
import { SelfTest } from "../setup/pages-steps.tsx";
import { ProbeChecklist } from "../setup/pages.tsx";
import type { ProbeRow } from "../setup/capability-probe.ts";
import { getPath, SETTINGS_FIELDS, type SettingField } from "../admin/settings-schema.ts";
import type { HealthCheck } from "../admin/health.ts";
import type { AuditFilter } from "../admin/audit-query.ts";
import { assertNever } from "../admin/ports.ts";
import { AdminShell, type AdminBase } from "./admin-pages.tsx";
import { ConfirmBody } from "./ui/confirm.tsx";

const enc = encodeURIComponent;

const AUDIT_COLS = ["When", "Actor", "Action", "Target", "Result"] as const;

export function AuditPage(p: AdminBase & { filter: AuditFilter; items: readonly AuditEntry[]; nextCursor: string | null }) {
  const qs = new URLSearchParams(Object.entries(p.filter).filter(([, v]) => v) as [string, string][]).toString();
  return (
    <AdminShell {...p} title="Audit log" current="/admin/audit">
      <form method="get" action="/admin/audit" class="stack filters">
        <div class="row">
          <Field id="actor" label="Actor (email or id)" value={p.filter.actor ?? ""} />
          <Field id="action" label="Action" value={p.filter.action ?? ""} hint="For example machine.revoked." />
          <Field id="target" label="Target" value={p.filter.target ?? ""} hint="kind or kind:id, for example user:1234." />
          <Field id="since" label="From (UTC)" value={p.filter.since ?? ""} hint="For example 2026-11-01T00:00:00Z." />
          <Field id="until" label="To (UTC)" value={p.filter.until ?? ""} />
        </div>
        <div class="row">
          <Button variant="outline">Filter</Button>
          <LinkButton href={`/admin/audit/export${qs ? `?${qs}` : ""}`}>Export JSON Lines</LinkButton>
        </div>
      </form>
      {p.items.length === 0 ? (
        <EmptyState action={qs ? <LinkButton href="/admin/audit">Clear the filter</LinkButton> : undefined}>
          {qs ? "No audit entries match this filter." : "Nothing has been recorded yet."}
        </EmptyState>
      ) : (
        <Table caption="Audit entries, newest first" headers={AUDIT_COLS}>
          {p.items.map((e) => (
            <Row
              headers={AUDIT_COLS}
              cells={[
                <RelativeTime iso={e.ts} />,
                e.actor.email ? <span class="name">{breakable(e.actor.email)}</span> : e.actor.kind,
                <span class="mono">{e.action}</span>,
                <>
                  {e.target.kind}
                  {e.target.id ? <span class="mono name"> {e.target.id}</span> : null}
                </>,
                e.result === "ok" ? (
                  <Status tone="ok">OK</Status>
                ) : (
                  <>
                    <Status tone="error">Error</Status>
                    {e.error_code ? <ErrorCode code={e.error_code} /> : null}
                  </>
                ),
              ]}
            />
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

/** The settings form's sections, in page order; a test holds every field to exactly one. */
export const SETTINGS_GROUPS: readonly { legend: string; paths: readonly string[] }[] = [
  { legend: "Organization", paths: ["org_name"] },
  { legend: "Sign-in and pairing", paths: ["session_duration", "pairing_policy.mode", "pairing_policy.emails", "pairing_policy.domains", "pairing_policy.access_group_ids"] },
  { legend: "Limits per person", paths: ["machine_cap_per_user", "device_cap_per_user"] },
  { legend: "Push notifications", paths: ["push.enabled", "push.detail", "push.ttl_seconds", "push.relay_allowed", "push.allowed_relays"] },
  { legend: "Offline machines and records", paths: ["stale_machine_policy.notify_after_days", "stale_machine_policy.revoke_after_days", "audit_retention_days", "orphan_cleanup"] },
  { legend: "Cloudflare account limits", paths: ["quota_limits.access_apps", "quota_limits.access_policies", "quota_limits.tunnels"] },
  { legend: "Updates", paths: ["deployer_repo_url"] },
];

type SettingsError = { path: string; message: string };

const fieldOf = (e: SettingsError): SettingField | undefined =>
  SETTINGS_FIELDS.find((f) => e.path === `/${f.path.replaceAll(".", "/")}` || e.path.startsWith(`/${f.path.replaceAll(".", "/")}/`));

export function SettingsPage(p: AdminBase & { settings: unknown; zoneName: string; errors?: readonly SettingsError[] }) {
  const errorFor = (path: string) => p.errors?.find((e) => fieldOf(e)?.path === path)?.message;
  return (
    <AdminShell {...p} title="Settings" current="/admin/settings">
      {p.errors?.length ? (
        <Notice tone="error">
          <p class="notice-title">Nothing was saved. Fix these settings, then save again:</p>
          <ul class="error-summary">
            {p.errors.map((e) => {
              const f = fieldOf(e);
              return <li>{f ? <a href={`#${f.path}`}>{`${f.label}: ${e.message}`}</a> : e.message}</li>;
            })}
          </ul>
          <ErrorCode code="validation_failed" />
        </Notice>
      ) : null}
      <p>
        Zone: <Chip>{p.zoneName}</Chip>. It is fixed once setup closes, because every machine hostname lives under it; moving zones means a new control plane.
      </p>
      <PostForm action="/admin/settings">
        {SETTINGS_GROUPS.map((g) => (
          <fieldset class="group">
            <legend>{g.legend}</legend>
            {g.paths.map((path) => SETTINGS_FIELDS.find((f) => f.path === path)).map((f) => f && settingControl(f, p.settings, errorFor(f.path)))}
          </fieldset>
        ))}
        {/* Pinned to the screen's bottom while the form scrolls: one Save for a long page. */}
        <div class="row sticky-actions">
          <Button>Save settings</Button>
        </div>
      </PostForm>
    </AdminShell>
  );
}

/** Display names only; the existing wire values remain the option values. */
const OPTION_LABELS: Record<string, string> = {
  allowlist: "Only allowed people", everyone: "Everyone accepted by your sign-in methods",
  names: "Include project and agent names", minimal: "Hide project and agent names",
  delete: "Delete untracked objects", report: "Report untracked objects only",
};

/** One settings control; checkboxes carry no error because a boolean cannot be invalid. */
function settingControl(f: SettingField, settings: unknown, error: string | undefined) {
  const v = getPath(settings, f.path);
  switch (f.kind) {
    case "checkbox":
      return <Checkbox id={f.path} label={f.label} hint={f.hint} checked={v === true} />;
    case "select":
      return <Field id={f.path} label={f.label} hint={f.hint} options={(f.options ?? []).map((value) => ({ value, label: OPTION_LABELS[value] ?? value }))} value={fieldValue(v)} {...(error ? { error } : {})} />;
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
            {c.ok === null ? <Status tone="off">Unknown</Status> : c.ok ? <Status tone="ok">OK</Status> : <Status tone="warn">Needs attention</Status>}
            <strong>{CHECK_LABEL[c.id]}</strong>
            <span class="muted">{c.detail}</span>
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
