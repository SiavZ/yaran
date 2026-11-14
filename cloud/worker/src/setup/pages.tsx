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
import { Button, Chip, Field, LinkButton, Notice, PostForm } from "../console/ui/components.tsx";
import { Shell } from "../console/ui/shell.tsx";
import type { ProbeRow } from "./capability-probe.ts";
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

export function SetupFrame(props: { step: SetupStep; children: Child }) {
  return (
    <Shell title="Set up yaran cloud">
      <nav aria-label="Setup progress">
        <ol class="row">
          {SETUP_STEPS.map((s) => (
            <li aria-current={s === props.step ? "step" : undefined} class={s === props.step ? "" : "muted"}>
              {STEP_LABEL[s]}
            </li>
          ))}
        </ol>
      </nav>
      <h2>{STEP_LABEL[props.step]}</h2>
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

export function LockedPage() {
  return (
    <SetupFrame step="locked">
      <Notice tone="error">
        Setup is locked (<Chip>setup_locked</Chip>) after 20 wrong setup codes. Change the SETUP_CODE secret in the dashboard (Workers &amp; Pages, this
        Worker, Settings, Variables and Secrets) to unlock it, then reload this page.
      </Notice>
    </SetupFrame>
  );
}

export function CodePage(props: { error?: "setup_code_invalid" | "rate_limited" }) {
  return (
    <SetupFrame step="locked">
      {props.error === "setup_code_invalid" && (
        <Notice tone="error">
          That setup code is wrong (<Chip>setup_code_invalid</Chip>). Type the SETUP_CODE you set when you deployed; after 20 wrong codes setup locks.
        </Notice>
      )}
      {props.error === "rate_limited" && <Notice tone="warn">Too many attempts from your address. Wait a minute and try again.</Notice>}
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

const OUTCOME_TEXT = { ok: "passed", missing: "missing", unchecked: "could not be checked" } as const;

export function ProbeChecklist(props: { rows: readonly ProbeRow[] }) {
  return (
    <ul class="checklist">
      {props.rows.map((r) => (
        <li>
          <strong>{OUTCOME_TEXT[r.outcome]}</strong>: <Chip>{r.permission.name}</Chip> ({r.permission.scope}). {r.permission.purpose}
          {r.reason && <span class="muted"> Cloudflare answered {r.reason}; try again in a minute.</span>}
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
      {p.error === "token_required" && <Notice tone="error">Paste the API token: the CF_API_TOKEN secret is empty.</Notice>}
      {p.error === "email_required" && <Notice tone="error">Type the email you will sign in with; it becomes the first admin.</Notice>}
      {p.error === "not_workers_dev" && <Notice tone="error">Open this page on the Worker's workers.dev address, which is how setup learns the Worker's script name.</Notice>}
      {p.accountProblem && <Notice tone="error">{ACCOUNT_TEXT[p.accountProblem]}</Notice>}
      {missing && (
        <Notice tone="error">
          The token is missing permissions (<Chip>cloudflare_permission_denied</Chip>). Create a token from the template below, or add the missing rows to
          yours, then try again.
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
