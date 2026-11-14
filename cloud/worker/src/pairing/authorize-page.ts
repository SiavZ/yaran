/**
 * The W2 pairing pages: the confirm page (machine, email and key fingerprint as chips,
 * Approve or Deny, or Replace and Pair-as on the same-name branch), the provisioning
 * error page with its Retry, and the plain refusal page for a bad callback or state.
 *
 * Built only from the console UI kit seam, so every value is escaped there and every
 * page carries the strict CSP with `form-action 'self' http://127.0.0.1:<port>` and
 * `Referrer-Policy: same-origin` (02 §8).
 *
 * - Copy is actionable and names what the person should check or do next.
 * - Error text is composed here from codes and numbers, never echoed from Cloudflare.
 *
 * <module-headers:begin>
 * Uses:
 * src/pairing/authorize-page.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/ui/kit.ts
 * External: none
 *
 * Used by:
 * src/pairing/authorize-page.ts
 * └── src/pairing/authorize-route.ts
 * <module-headers:end>
 */
import type { ErrorCode } from "@yaran/protocol";
import { button, chip, form, heading, notice, page, prose, type Html } from "../ui/kit.ts";

export const PAIR_FORM_ACTION = "/v1/pair/authorize";

export interface ConfirmPageInput {
  requestId: string;
  csrf: string;
  machineName: string;
  email: string;
  fingerprint: string;
  callbackPort: number;
  /** The caller's active machine with the same name, when re-pairing it. */
  sameName: { id: string; nextName: string } | null;
}

const loopback = (port: number) => `http://127.0.0.1:${port}`;

export function confirmPage(i: ConfirmPageInput): Response {
  const hidden = { request_id: i.requestId, csrf: i.csrf };
  const body: Html[] = [
    heading("Pair ", chip(i.machineName), " with your account?"),
    prose("You are signed in as ", chip(i.email), ". Approving gives this machine its own private address that only you can open."),
    prose("Check that this key fingerprint matches the one ", chip("yaran cloud login"), " printed in your terminal:"),
    prose(chip(i.fingerprint, { mono: true, label: "Machine key fingerprint" })),
    prose("If it does not match, or you did not just run that command, choose Deny."),
  ];
  if (i.sameName) {
    body.push(
      notice("info", "You already have a machine called ", chip(i.machineName), ". Replace it if this is the same computer paired again; the old one is removed only after this one connects."),
      // Two distinct actions, both approvals: Replace carries replace_machine_id, Pair-as omits it.
      form(
        PAIR_FORM_ACTION,
        { ...hidden, decision: "approve" },
        [
          button({ name: "replace_machine_id", value: i.sameName.id, text: `Replace ${i.machineName}`, primary: true, focus: true }),
          button({ text: `Pair as ${i.sameName.nextName}` }),
        ],
        "Approve pairing",
      ),
      form(PAIR_FORM_ACTION, hidden, [button({ name: "decision", value: "deny", text: "Deny" })], "Deny pairing"),
    );
  } else {
    body.push(
      form(
        PAIR_FORM_ACTION,
        hidden,
        [button({ name: "decision", value: "approve", text: "Approve", primary: true, focus: true }), button({ name: "decision", value: "deny", text: "Deny" })],
        "Pairing decision",
      ),
    );
  }
  return page(body, { title: "Pair a machine", formAction: loopback(i.callbackPort) });
}

/** What a refusal means for the person, in words that say what to do next. */
export function refusalText(code: ErrorCode, details: Record<string, unknown> | undefined): string {
  const num = (k: string) => (typeof details?.[k] === "number" ? String(details[k]) : "?");
  switch (code) {
    case "account_quota_reached": {
      const what = { access_apps: "Access applications", access_policies: "Access policies", tunnels: "tunnels" }[String(details?.["resource"])] ?? "Cloudflare resources";
      return `This org has used ${num("used")} of ${num("limit")} ${what}. Ask an admin to remove unused machines or raise the quota, then try again.`;
    }
    case "machine_cap_reached":
      return `You already have ${num("limit")} machines, the most this org allows. Remove one you no longer use, then pair again.`;
    case "provisioning_in_progress":
      return "Setting up this machine's address is taking longer than usual. Retry in a few seconds; nothing is created twice.";
    case "hostname_conflict":
      return "Another DNS record or Access application already uses this machine's address. Ask an admin to check the zone, then retry.";
    case "cloudflare_rate_limited":
      return "Cloudflare is rate limiting this org right now. Wait a minute, then retry.";
    case "cloudflare_permission_denied":
      return "The org's Cloudflare API token is missing a permission this step needs. Ask an admin to check the token, then retry.";
    case "provisioning_failed":
      return "Setting up this machine's address failed. Retry; if it keeps failing, an admin can see the details in the admin console.";
    case "pair_request_expired":
      return "This pairing link has expired. Run the login command again in your terminal.";
    case "pair_callback_invalid":
      return "This pairing link does not point back to a yaran running on this computer, so it was refused. Run the login command again.";
    default:
      return "This pairing request is not valid. Run the login command again in your terminal.";
  }
}

/** The refusal page; `retry` re-posts the same approval (idempotent: same machine id). */
export function pairErrorPage(code: ErrorCode, o: { status: number; details?: Record<string, unknown>; retry?: { requestId: string; csrf: string; fields: Record<string, string>; callbackPort: number } }): Response {
  const body: Html[] = [heading("Pairing did not finish"), notice("error", refusalText(code, o.details)), prose("Error code: ", chip(code, { mono: true }))];
  if (o.retry) {
    body.push(
      form(PAIR_FORM_ACTION, { request_id: o.retry.requestId, csrf: o.retry.csrf, decision: "approve", ...o.retry.fields }, [button({ text: "Retry", primary: true, focus: true })], "Retry pairing"),
    );
  }
  return page(body, { title: "Pairing did not finish", status: o.status, ...(o.retry ? { formAction: loopback(o.retry.callbackPort) } : {}) });
}
