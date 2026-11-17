/**
 * Setup wizard pages, part one: the frame, the secret checks, the code gate and the token step.
 *
 * Server-rendered, script-free forms (the wizard works with JavaScript off). Each page
 * names the step it is on, says what the step does in plain words, and shows refusals with
 * their 02 error code and the way forward.
 *
 * - Copy is the English baseline in the house voice; names render as chips.
 *
 * <module-headers:begin>
 * Uses:
 * src/setup/pages.tsx
 * ├── src/console/ui/components.tsx
 * ├── src/console/ui/shell.tsx
 * ├── src/console/ui/strings.ts
 * ├── src/security/rate-limit.ts
 * ├── src/setup/capability-probe.ts
 * ├── src/setup/setup-gate.ts
 * ├── src/setup/token-template.ts
 * └── src/setup/wizard-state.ts
 * External: hono
 *
 * Used by:
 * src/setup/pages.tsx
 * ├── src/console/admin-pages-2.tsx
 * ├── src/setup/pages-steps.tsx
 * ├── src/setup/routes.ts
 * └── test/node/ui-kit.test.tsx
 * <module-headers:end>
 */
import type { Child } from "hono/jsx";
import { Button, Chip, ErrorCode, Field, LinkButton, Notice, PostForm, Status } from "../console/ui/components.tsx";
import type { StatusTone } from "../console/ui/strings.ts";
import { Shell } from "../console/ui/shell.tsx";
import type { ProbeRow } from "./capability-probe.ts";
import type { SetupLockReason } from "../security/rate-limit.ts";
import type { SecretProblem } from "./setup-gate.ts";
import { tokenTemplateUrl } from "./token-template.ts";
import { SETUP_STEPS, type SetupStep } from "./wizard-state.ts";

export const STEP_LABEL: Record<SetupStep, string> = {
  locked: "Setup code",
  token: "API token",
  org: "Zero Trust",
  zone: "Hostname",
  access: "Access",
  domain: "Custom domain",
  idp: "Sign-in methods",
  keys: "Push keys",
  claim: "Claim admin",
  closed: "Done",
};

/** The progress list: done steps carry a check, the current one is filled, later ones are outlined. */
export function SetupFrame(props: { step: SetupStep; children: Child }) {
  const at = SETUP_STEPS.indexOf(props.step);
  return (
    <Shell title="Set up yaran cloud">
      <nav aria-label="Setup progress">
        <ol class="steps">
          {SETUP_STEPS.map((s, i) => (
            <li
              aria-current={i === at ? "step" : undefined}
              class={i < at ? "step-done" : i === at ? "step-current" : "step-todo"}
              data-total={i === at ? String(SETUP_STEPS.length) : undefined}
            >
              {i < at ? <span class="sr-only">Done: </span> : null}
              <span class="step-label">{STEP_LABEL[s]}</span>
            </li>
          ))}
        </ol>
      </nav>
      <h2 data-setup-step={props.step}>{STEP_LABEL[props.step]}</h2>
      {props.children}
    </Shell>
  );
}

const SECRET_TEXT: Record<SecretProblem, string> = {
  setup_code_missing: "The SETUP_CODE secret is not set.",
  setup_code_short: "The SETUP_CODE secret is shorter than 24 characters, which is too easy to guess while setup is open.",
  data_key_missing: "The DATA_KEY secret is not set.",
  data_key_malformed: "The DATA_KEY secret is not base64 of at least 32 random bytes.",
};

export function SecretsPage(props: { problems: readonly SecretProblem[] }) {
  return (
    <SetupFrame step="locked">
      {props.problems.map((p) => (
        <Notice tone="error">{SECRET_TEXT[p]}</Notice>
      ))}
      <p>
        A Worker cannot set its own secrets, so set them in the Cloudflare dashboard: Workers &amp; Pages, this Worker, Settings, Variables and Secrets.
        Generate a setup code with <Chip>openssl rand -base64 24</Chip> and a data key with <Chip>openssl rand -base64 32</Chip>, keep a copy of the data key
        somewhere safe, then reload this page. Nothing else happens until both are set.
      </p>
    </SetupFrame>
  );
}

export function LockedPage(props: { reason: SetupLockReason }) {
  const why =
    props.reason === "failures"
      ? "after 20 wrong setup codes from your address"
      : "because your address entered a wrong setup code after more than 100 wrong codes from many addresses today, which looks like someone guessing";
  return (
    <SetupFrame step="locked">
      <Notice tone="error">
        Setup is locked for your address {why}. An address that has not entered a wrong code can still start setup with the right one. To unlock this
        address, change the SETUP_CODE secret in the dashboard (Workers &amp; Pages, this Worker, Settings, Variables and Secrets), then reload this page.
        <ErrorCode code="setup_locked" />
      </Notice>
    </SetupFrame>
  );
}

function limitText(limit: "window" | "day", retryAfter: number): string {
  if (limit === "window") {
    const minutes = Math.ceil(retryAfter / 60);
    return `Too many tries from your address: setup accepts 5 setup codes per 15 minutes from one address, right or wrong. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
  }
  const hours = Math.ceil(retryAfter / 3600);
  return `Your address has used its 30 setup-code tries for today, right or wrong. Try again in ${hours} ${hours === 1 ? "hour" : "hours"}.`;
}

export function CodePage(props: { error?: "setup_code_invalid" | "rate_limited"; limit?: "window" | "day"; retryAfter?: number }) {
  return (
    <SetupFrame step="locked">
      {props.error === "setup_code_invalid" && (
        <Notice tone="error">
          That setup code is wrong. Type the SETUP_CODE you set when you deployed; after 20 wrong codes setup locks for your address.
          <ErrorCode code="setup_code_invalid" />
        </Notice>
      )}
      {props.error === "rate_limited" && <Notice tone="warn">{limitText(props.limit ?? "window", props.retryAfter ?? 60)}</Notice>}
      <p>Until setup finishes this page is the only thing the Worker serves. Enter the setup code you chose at deploy time to start.</p>
      <PostForm action="/setup/code">
        <Field id="code" label="Setup code" type="password" autocomplete="off" required />
        <div class="row">
          <Button>Start setup</Button>
        </div>
      </PostForm>
    </SetupFrame>
  );
}

const OUTCOME: Record<ProbeRow["outcome"], readonly [string, StatusTone]> = { ok: ["passed", "ok"], missing: ["missing", "error"], unchecked: ["could not be checked", "warn"] };

export function ProbeChecklist(props: { rows: readonly ProbeRow[] }) {
  return (
    <ul class="checklist">
      {props.rows.map((r) => (
        <li data-permission={r.permission.name} data-outcome={r.outcome}>
          <Status tone={OUTCOME[r.outcome][1]}>{OUTCOME[r.outcome][0]}</Status>
          <strong>
            {r.permission.name} <span class="muted">({r.permission.scope})</span>
          </strong>
          <span class="muted">
            {r.permission.purpose}
            {r.reason && ` Cloudflare answered ${r.reason}; try again in a minute.`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface TokenPageProps {
  envToken: boolean;
  probe?: readonly ProbeRow[];
  accountProblem?: "none" | "several" | "unverified";
  error?: "token_required" | "email_required" | "not_workers_dev";
  adminEmail?: string;
}

const ACCOUNT_TEXT = {
  none: "The token cannot list accounts, so type the account ID (dashboard, Account home, the account's menu, Copy account ID).",
  several: "The token sees several accounts; type the ID of the one this Worker runs in.",
  unverified: "The token could not be verified against that account ID. Check the ID and that the token belongs to that account.",
} as const;

export function TokenPage(p: TokenPageProps) {
  const missing = p.probe?.some((r) => r.outcome !== "ok");
  return (
    <SetupFrame step="token">
      {p.error && <span hidden data-setup-problem={p.error} />}
      {p.accountProblem && <span hidden data-setup-problem={`account_${p.accountProblem}`} />}
      {p.error === "token_required" && <Notice tone="error">Paste the API token: the CF_API_TOKEN secret is empty.</Notice>}
      {p.error === "email_required" && <Notice tone="error">Type the email you will sign in with; it becomes the first admin.</Notice>}
      {p.error === "not_workers_dev" && <Notice tone="error">Open this page on the Worker's workers.dev address, which is how setup learns the Worker's script name.</Notice>}
      {p.accountProblem && <Notice tone="error">{ACCOUNT_TEXT[p.accountProblem]}</Notice>}
      {missing && <span hidden data-setup-problem="missing_permissions" />}
      {missing && (
        <Notice tone="error">
          The token is missing permissions. Create a token from the template below, or add the missing rows to yours, then try again.
          <ErrorCode code="cloudflare_permission_denied" />
        </Notice>
      )}
      {p.probe && <ProbeChecklist rows={p.probe} />}
      <p>
        The Worker manages tunnels, DNS records and Access applications with one account-owned API token. The template link pre-fills exactly the permissions
        it needs; limit the two zone permissions to the zone you will use.
      </p>
      <p>
        <LinkButton href={tokenTemplateUrl()}>Open the token template</LinkButton>
      </p>
      <PostForm action="/setup/token">
        <Field
          id="token"
          label="API token"
          type="password"
          autocomplete="off"
          hint={p.envToken ? "Leave empty to use the CF_API_TOKEN secret you set at deploy time." : "No CF_API_TOKEN secret is set, so paste the token here."}
          required={!p.envToken}
        />
        <Field id="account_id" label="Account ID (only if asked)" hint="Leave empty unless this page asked for it." />
        <Field id="admin_email" label="Your email" type="email" value={p.adminEmail ?? ""} hint="The address you sign in with; it becomes the first admin." required />
        <div class="row">
          <Button>Check the token</Button>
        </div>
      </PostForm>
    </SetupFrame>
  );
}
