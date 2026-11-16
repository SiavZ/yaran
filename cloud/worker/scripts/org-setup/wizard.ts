/**
 * Drives the Worker's own setup wizard (`src/setup/routes.ts`) over HTTP, as a browser
 * would: it enters the setup code, keeps the setup cookie, posts every form with this
 * origin, and reads each page's `data-setup-step` and `data-setup-problem` markers. Every
 * guard stays in force (secrets, lockout, rate limits, same origin, the closed state), and
 * every Cloudflare change is made by the Worker's step services with the Worker's token.
 *
 * - It never sends an API token: the token step is posted empty, so the Worker uses its
 *   CF_API_TOKEN secret.
 * - It stops at the claim link. Claiming admin is a real Access sign-in, done by a person.
 * - A just-uploaded setup code that the Worker refuses is tried once more after a wait,
 *   never again: every try counts against the setup gate's per-address limits.
 * - No Node imports, so the Workers test pool can run it against the real routes.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/org-setup/wizard.ts
 * └── src/setup/token-template.ts
 * External: none
 *
 * Used by:
 * scripts/org-setup/wizard.ts
 * ├── scripts/org-setup/run.ts
 * ├── test/node/helpers/org-setup-fake.ts
 * └── test/setup-installer.test.ts
 * <module-headers:end>
 */
import { tokenTemplateUrl } from "../../src/setup/token-template.ts";

export interface WizardInput {
  /** `https://<worker>.<subdomain>.workers.dev` */
  origin: string;
  setupCode: string;
  accountId: string;
  adminEmail: string;
  zoneId: string;
  zoneName: string;
  label: string;
  team: string;
  addOneTimePin: boolean;
  /** The SETUP_CODE was uploaded in this run, so the edge may still serve the old one for a while. */
  codeJustSet?: boolean;
}

/** The one wait before a just-uploaded setup code is tried again; two tries stay inside the gate's 5 per 15 minutes. */
export const CODE_RETRY_MS = 60_000;

export interface WizardIo {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export type WizardOutcome = { kind: "claim"; link: string } | { kind: "closed" };

/** A stop the deployer can act on; the message says what to do. */
export class SetupStop extends Error {
  override readonly name = "SetupStop";
}

const RESUME = "Rerun the same command to resume.";
const redirected = (status: number) => status === 302 || status === 303;
const marker = (html: string, attr: string) => html.match(new RegExp(`data-${attr}="([\\w-]+)"`))?.[1] ?? null;
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

interface Reply {
  status: number;
  html: string;
}

function permissionRows(html: string, outcome: string): string[] {
  return [...html.matchAll(/data-permission="([^"]*)" data-outcome="(\w+)"/g)].filter((m) => m[2] === outcome).map((m) => unescape(m[1]!));
}

export async function driveWizard(io: WizardIo, i: WizardInput): Promise<WizardOutcome> {
  let cookie = "";

  async function send(method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<Reply> {
    for (let attempt = 0; ; attempt++) {
      const init: RequestInit = { method, redirect: "manual", headers: { Cookie: cookie, Origin: i.origin } };
      if (form) init.body = new URLSearchParams(form);
      const res = await io.fetch(i.origin + path, init);
      const set = res.headers.get("Set-Cookie");
      if (set) cookie = set.split(";")[0]!;
      const html = await res.text();
      const wait = Number(res.headers.get("Retry-After") ?? "60");
      // The setup routes allow 20 requests a minute per address; a short wait is ordinary.
      if (res.status === 429 && wait <= 60 && attempt < 5) {
        io.log(`Setup is pacing requests; waiting ${wait}s.`);
        await io.sleep(wait * 1000);
        continue;
      }
      if (res.status === 429) throw new SetupStop(`The Worker's setup page asked to wait ${Math.ceil(wait / 60)} minutes before another try from this address. ${RESUME}`);
      return { status: res.status, html };
    }
  }

  /** GET /setup; waits out the secrets page while freshly set secrets reach the Worker. */
  async function page(): Promise<Reply | "closed"> {
    for (let tries = 0; ; tries++) {
      const r = await send("GET", "/setup");
      if (r.status === 410 || r.status === 421) return "closed";
      if (r.status === 503 && tries < 24) {
        await io.sleep(5000);
        continue;
      }
      if (r.status === 503) throw new SetupStop(`The Worker still reports missing or invalid SETUP_CODE or DATA_KEY secrets. ${RESUME}`);
      if (r.status === 403) throw new SetupStop("Setup is locked for this address after wrong setup codes. Remove setupCode from the installer's state file and rerun to set a new one, which unlocks it.");
      if (r.status !== 200) throw new SetupStop(`The setup page answered HTTP ${r.status}. ${RESUME}`);
      return r;
    }
  }

  let codeRetried = false;
  async function enterCode(): Promise<void> {
    const r = await send("POST", "/setup/code", { code: i.setupCode });
    if (redirected(r.status)) return;
    if (r.status === 401 && i.codeJustSet && !codeRetried) {
      codeRetried = true;
      io.log(`The Worker still answers with its previous setup code; trying the new one once more in ${CODE_RETRY_MS / 1000}s.`);
      await io.sleep(CODE_RETRY_MS);
      return enterCode();
    }
    if (r.status === 401) throw new SetupStop("The Worker refused the saved setup code: its SETUP_CODE secret differs from the installer's state file. Rerun to upload the saved code again.");
    throw new SetupStop(`Entering the setup code answered HTTP ${r.status}. ${RESUME}`);
  }

  /** null when the POST advanced (or stayed, post/redirect/get); else the problem marker. */
  async function post(path: string, form: Record<string, string> = {}): Promise<{ problem: string | null; html: string } | null> {
    const r = await send("POST", path, form);
    if (redirected(r.status)) return null;
    if (r.status === 410 || r.status === 421) throw new SetupStop("Setup closed while the installer was running.");
    return { problem: marker(r.html, "setup-problem"), html: r.html };
  }

  let withAccountId = false;
  let pinAdded = false;
  let last = "";
  let repeats = 0;
  for (;;) {
    const p = await page();
    if (p === "closed") return { kind: "closed" };
    const step = marker(p.html, "setup-step");
    if (!step) throw new SetupStop("The setup page carries no step marker; deploy this checkout's Worker and rerun.");
    repeats = step === last ? repeats + 1 : 0;
    last = step;
    if (repeats > 3) throw new SetupStop(`Setup did not move past the ${step} step. ${RESUME}`);
    io.log(`Setup step: ${step}`);
    let out: Awaited<ReturnType<typeof post>>;
    switch (step) {
      case "locked":
        await enterCode();
        continue;
      case "token":
        out = await post("/setup/token", { token: "", account_id: withAccountId ? i.accountId : "", admin_email: i.adminEmail });
        if (out?.problem === "account_several" || out?.problem === "account_none") {
          if (withAccountId) break;
          withAccountId = true;
          continue;
        }
        if (out?.problem === "missing_permissions") {
          const missing = permissionRows(out.html, "missing");
          const unchecked = permissionRows(out.html, "unchecked");
          if (missing.length === 0) throw new SetupStop(`Cloudflare could not check these permissions just now: ${unchecked.join("; ")}. ${RESUME}`);
          throw new SetupStop(
            `The control plane's API token (the Worker's CF_API_TOKEN secret) lacks: ${missing.join("; ")}.\nCreate a token from ${tokenTemplateUrl()}\nwith the two zone rows limited to ${i.zoneName}, then rerun with --token.`,
          );
        }
        if (out?.problem === "account_unverified")
          throw new SetupStop(`The Worker's CF_API_TOKEN could not be verified against account ${i.accountId}. It must be an account-owned token of that account.\nCreate one from ${tokenTemplateUrl()}\nwith the two zone rows limited to ${i.zoneName}, then rerun with --token.`);
        if (out?.problem === "token_required") throw new SetupStop("The Worker has no CF_API_TOKEN secret. Rerun with --token.");
        break;
      case "org":
        out = await post("/setup/org", { action: "check" });
        if (out?.problem === "no_org") out = await post("/setup/org", { action: "create", team: i.team });
        if (out?.problem === "invalid_team_name") throw new SetupStop("Pass --team with lowercase letters, digits and hyphens: it becomes <team>.cloudflareaccess.com.");
        if (out?.problem === "onboarding_required")
          throw new SetupStop(`Cloudflare would not create the Zero Trust organization by API. In the dashboard open Zero Trust and choose the Free plan (it asks for a payment method but does not charge), then rerun. If the team name is taken, rerun with --team <another name>.`);
        break;
      case "zone":
        out = await post("/setup/zone", { zone_id: i.zoneId, label: i.label });
        if (out?.problem === "hostname_conflict") throw new SetupStop(`${i.label}.${i.zoneName} already has a DNS record or Worker custom domain. Remove it or pass another --label.`);
        if (out?.problem === "invalid_label") throw new SetupStop("--label must be 1 to 63 lowercase letters or digits, with no hyphen.");
        if (out?.problem === "unknown_zone") throw new SetupStop(`The control plane's API token cannot see ${i.zoneName}. Give its Zone Read and DNS Edit rows that zone and rerun with --token.`);
        break;
      case "access":
        out = await post("/setup/access");
        break;
      case "domain":
        out = await post("/setup/domain", { action: "attach" });
        if (out?.problem === "taken_by_other_worker") throw new SetupStop(`${i.label}.${i.zoneName} is attached to another Worker. Detach it there or choose another --label before the zone step.`);
        if (out?.problem === "dashboard_required")
          throw new SetupStop(`Cloudflare refused to attach the domain by API. Add it in the dashboard (Workers & Pages, this Worker, Settings, Domains & Routes, Add, Custom Domain: ${i.label}.${i.zoneName}), then rerun.`);
        break;
      case "idp":
        out = await post("/setup/idp", { action: "finish" });
        if (out?.problem === "no_usable_idp" && i.addOneTimePin && !pinAdded) {
          pinAdded = true;
          out = await post("/setup/idp", { action: "onetimepin" });
          if (out === null) continue;
        }
        if (out?.problem === "no_usable_idp")
          throw new SetupStop(
            "Zero Trust has no sign-in method besides Cloudflare account login. Add your company identity provider under Zero Trust, Settings, Authentication and rerun, or rerun with --one-time-pin to add One-time PIN (anyone who can read mail at an address an Access policy admits can then sign in).",
          );
        break;
      case "keys":
        out = await post("/setup/keys");
        break;
      case "claim": {
        const r = await send("POST", "/setup/claim-link");
        const link = r.html.match(/id="claim-link"[^>]*\svalue="([^"]+)"/)?.[1];
        if (r.status !== 200 || !link) throw new SetupStop(`Making the claim link answered HTTP ${r.status}. ${RESUME}`);
        return { kind: "claim", link: unescape(link) };
      }
      default:
        throw new SetupStop(`Unknown setup step ${step}; update this checkout and rerun.`);
    }
    if (out === null) continue;
    if (out.problem === "cloudflare_error") {
      io.log("Cloudflare did not answer as expected; retrying in 15s.");
      await io.sleep(15_000);
      continue;
    }
    throw new SetupStop(`The ${step} step stopped${out.problem ? ` (${out.problem})` : ""}. Open ${i.origin}/setup to see why, or ${RESUME.toLowerCase()}`);
  }
}
