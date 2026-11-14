/**
 * Setup wizard pages, part two: Zero Trust, hostname, Access, domain, sign-in, keys, claim.
 *
 * Each page shows what the step will do before it does it, and each fallback (G8, G10,
 * G14) names the dashboard path and offers Check again. The final page reports the close,
 * whether workers.dev was turned off, and runs the wiring self-test in the browser.
 *
 * <module-headers:begin>
 * Uses:
 * src/setup/pages-steps.tsx
 * ├── src/cloudflare/setup-endpoints.ts
 * ├── src/console/ui/components.tsx
 * ├── src/console/ui/shell.tsx
 * ├── src/setup/pages.tsx
 * ├── src/setup/steps/idp.ts
 * ├── src/setup/steps/zone.ts
 * └── src/setup/wizard-state.ts
 * External: none
 *
 * Used by:
 * src/setup/pages-steps.tsx
 * ├── src/console/admin-pages-2.tsx
 * ├── src/setup/routes.ts
 * └── test/ui-kit.test.tsx
 * <module-headers:end>
 */
import { Button, Chip, CopyField, Field, LinkButton, Notice, PostForm } from "../console/ui/components.tsx";
import { Shell } from "../console/ui/shell.tsx";
import type { CfIdp, CfZone } from "../cloudflare/setup-endpoints.ts";
import { SetupFrame } from "./pages.tsx";
import { DEFAULT_LABEL } from "./steps/zone.ts";
import { callbackUrl, IDP_SETUP_LINKS, usableIdps } from "./steps/idp.ts";
import type { SetupRecord } from "./wizard-state.ts";

export type StepProblem =
  | "no_org"
  | "onboarding_required"
  | "invalid_team_name"
  | "invalid_label"
  | "unknown_zone"
  | "hostname_conflict"
  | "dashboard_required"
  | "not_found_yet"
  | "taken_by_other_worker"
  | "client_fields_required"
  | "no_usable_idp"
  | "cloudflare_error";

const PROBLEM_TEXT: Record<StepProblem, string> = {
  no_org: "This account has no Zero Trust organization yet.",
  onboarding_required:
    "Cloudflare refused to create the organization. Open the dashboard, Zero Trust, and choose the Free plan (it asks for a payment method but does not charge for up to 50 users), then press Check again.",
  invalid_team_name: "A team name is lowercase letters, digits and hyphens, up to 63 characters.",
  invalid_label: "The label must be one DNS label of 1 to 63 lowercase letters or digits, with no hyphen.",
  unknown_zone: "That zone is not visible to the token. Pick one from the list.",
  hostname_conflict: "That hostname is already used by a DNS record or a Worker custom domain (hostname_conflict). Choose another label.",
  dashboard_required:
    "Cloudflare refused to attach the domain by API. In the dashboard open Workers & Pages, this Worker, Settings, Domains & Routes, Add, Custom Domain, enter the hostname below, then press Check again.",
  not_found_yet: "The hostname is not attached to this Worker yet. Attach it in the dashboard, wait a minute, then press Check again.",
  taken_by_other_worker: "The hostname is attached to another Worker. Remove it there or go back and choose another label.",
  client_fields_required: "Both the client ID and the client secret are required.",
  no_usable_idp: "Add at least one sign-in method other than Cloudflare account login before continuing.",
  cloudflare_error: "Cloudflare did not answer as expected. Wait a minute and try the step again; nothing was half-applied that a retry will not repair.",
};

export function ProblemNotice(props: { problem?: StepProblem | undefined }) {
  return props.problem ? <Notice tone={props.problem === "no_org" ? "info" : "error"}>{PROBLEM_TEXT[props.problem]}</Notice> : null;
}

export function OrgPage(props: { problem?: StepProblem | undefined }) {
  return (
    <SetupFrame step="org">
      <ProblemNotice problem={props.problem} />
      <p>Access protects the control plane and every machine. This step reads your Zero Trust team domain, the address sign-ins go through.</p>
      <PostForm action="/setup/org">
        <div class="row">
          <Button name="action" value="check">
            Check again
          </Button>
        </div>
      </PostForm>
      {(props.problem === "no_org" || props.problem === "invalid_team_name") && (
        <PostForm action="/setup/org">
          <Field id="team" label="Team name" hint="Becomes <team>.cloudflareaccess.com, the sign-in address your users see." required />
          <div class="row">
            <Button name="action" value="create">
              Create the Zero Trust organization
            </Button>
          </div>
        </PostForm>
      )}
    </SetupFrame>
  );
}

export function ZonePage(props: { zones: readonly CfZone[]; problem?: StepProblem | undefined }) {
  return (
    <SetupFrame step="zone">
      <ProblemNotice problem={props.problem} />
      <p>Pick the zone the control plane and every machine hostname live under. It cannot change after setup; moving zones means a new control plane.</p>
      <PostForm action="/setup/zone">
        <Field id="zone_id" label="Zone" options={props.zones.map((z) => ({ value: z.id, label: z.name }))} required />
        <Field id="label" label="Control-plane label" value={DEFAULT_LABEL} hint="The control plane answers at <label>.<zone>. One label, letters and digits only." required />
        <div class="row">
          <Button>Use this hostname</Button>
        </div>
      </PostForm>
    </SetupFrame>
  );
}

export function AccessPage(props: { record: SetupRecord; problem?: StepProblem | undefined }) {
  return (
    <SetupFrame step="access">
      <ProblemNotice problem={props.problem} />
      <p>
        This creates the Access policy <Chip>yaran users</Chip> (just you, <Chip>{props.record.admin_email ?? ""}</Chip>, until you widen it in Settings) and the
        Access application for <Chip>{props.record.cp_host ?? ""}</Chip>. Only <Chip>/v1/meta</Chip> and <Chip>/v1/machine/*</Chip> stay public; every other path
        needs a sign-in. It happens before the hostname exists, so the hostname is never reachable unprotected.
      </p>
      <PostForm action="/setup/access">
        <div class="row">
          <Button>Create the Access application</Button>
        </div>
      </PostForm>
    </SetupFrame>
  );
}

export function DomainPage(props: { record: SetupRecord; problem?: StepProblem | undefined }) {
  return (
    <SetupFrame step="domain">
      <ProblemNotice problem={props.problem} />
      <p>
        This attaches <Chip>{props.record.cp_host ?? ""}</Chip> to this Worker as a custom domain. Cloudflare creates the DNS record and certificate; that can
        take a few minutes.
      </p>
      <PostForm action="/setup/domain">
        <div class="row">
          <Button name="action" value="attach">
            Attach the domain
          </Button>
          <Button variant="outline" name="action" value="check">
            Check again
          </Button>
        </div>
      </PostForm>
    </SetupFrame>
  );
}

export function IdpPage(props: { idps: readonly CfIdp[]; teamDomain: string; problem?: StepProblem | undefined }) {
  const usable = usableIdps(props.idps);
  return (
    <SetupFrame step="idp">
      <ProblemNotice problem={props.problem} />
      {usable.length === 0 ? (
        <Notice tone="warn">Only Cloudflare account members can sign in right now, so teammates cannot. Add a sign-in method below.</Notice>
      ) : (
        <p>
          Sign-in methods: {usable.map((p) => <Chip>{p.name}</Chip>)}. You can add more, or continue.
        </p>
      )}
      <PostForm action="/setup/idp">
        <div class="row">
          <Button variant="outline" name="action" value="onetimepin">
            Add One-time PIN
          </Button>
        </div>
      </PostForm>
      {(["github", "google"] as const).map((kind) => (
        <PostForm action="/setup/idp">
          <h3>{kind === "github" ? "GitHub" : "Google"}</h3>
          <p class="hint">
            Create an OAuth app at <a href={IDP_SETUP_LINKS[kind]}>{IDP_SETUP_LINKS[kind]}</a> with this callback URL:
          </p>
          <CopyField id={`${kind}-callback`} label="Callback URL" value={callbackUrl(props.teamDomain)} />
          <Field id={`${kind}_client_id`} label="Client ID" />
          <Field id={`${kind}_client_secret`} label="Client secret" type="password" autocomplete="off" />
          <div class="row">
            <Button variant="outline" name="action" value={kind}>
              Add {kind === "github" ? "GitHub" : "Google"}
            </Button>
          </div>
        </PostForm>
      ))}
      <PostForm action="/setup/idp">
        <div class="row">
          <Button name="action" value="finish">
            Continue
          </Button>
        </div>
      </PostForm>
    </SetupFrame>
  );
}

export function KeysPage() {
  return (
    <SetupFrame step="keys">
      <p>This generates the org's push key pair. The private half is encrypted with your DATA_KEY and never shown; phones receive the public half.</p>
      <PostForm action="/setup/keys">
        <div class="row">
          <Button>Generate the push keys</Button>
        </div>
      </PostForm>
    </SetupFrame>
  );
}

export function ClaimPage(props: { record: SetupRecord; link?: string | undefined }) {
  return (
    <SetupFrame step="claim">
      <p>
        Last step: open the claim link and sign in as <Chip>{props.record.admin_email ?? ""}</Chip>. It goes through the new hostname and Access, so it proves the
        whole chain works, and it closes setup for good. The link works once, for 30 minutes.
      </p>
      {props.link ? <CopyField id="claim-link" label="Claim link" value={props.link} /> : null}
      {props.link ? (
        <p>
          <LinkButton href={props.link} variant="primary">
            Open the claim link
          </LinkButton>
        </p>
      ) : null}
      <PostForm action="/setup/claim-link">
        <div class="row">
          <Button variant={props.link ? "outline" : "primary"}>{props.link ? "Make a new link" : "Make the claim link"}</Button>
        </div>
      </PostForm>
    </SetupFrame>
  );
}

export function ClaimInvalidPage() {
  return (
    <Shell title="Claim link refused">
      <Notice tone="error">
        This claim link was refused (<Chip>setup_claim_invalid</Chip>): it is unknown, used, expired, or you signed in with a different email than the one typed
        during setup. Go back to the setup page on the workers.dev address and make a new link.
      </Notice>
    </Shell>
  );
}

export function SelfTest() {
  return (
    <ul class="checklist">
      <li>
        <Chip>/v1/meta</Chip> is public: <span data-selftest="meta">not run (needs JavaScript)</span>
      </li>
      <li>
        <Chip>/v1/machine/*</Chip> reaches the Worker: <span data-selftest="machine">not run (needs JavaScript)</span>
      </li>
      <li>
        <Chip>/v1/me</Chip> needs a sign-in: <span data-selftest="protected">not run (needs JavaScript)</span>
      </li>
    </ul>
  );
}

export function DonePage(props: { record: SetupRecord }) {
  const r = props.record;
  return (
    <Shell title="yaran cloud is set up">
      <Notice tone="success">
        Setup is closed for good, and <Chip>{r.admin_email ?? ""}</Chip> is the first admin.
      </Notice>
      {r.workers_dev_disabled ? (
        <Notice tone="info">The workers.dev address is turned off; only https://{r.cp_host} answers from now on.</Notice>
      ) : (
        <Notice tone="warn">
          Turning off the workers.dev address failed. It already refuses every request, and Health has a Disable workers.dev button to retry.
        </Notice>
      )}
      <h2>Wiring self-test</h2>
      <SelfTest />
      <h2>Next</h2>
      <p>
        In your deploy repository set the Actions variable <Chip>YARAN_CONTROL_PLANE_URL</Chip> to the address below, so the update workflow can turn workers.dev
        off in your Wrangler config too.
      </p>
      <CopyField id="cp-url" label="Control-plane URL" value={`https://${r.cp_host ?? ""}`} />
      <p>
        <LinkButton href="/admin/health" variant="primary">
          Open the admin console
        </LinkButton>
      </p>
    </Shell>
  );
}
