/**
 * The W2 pairing pages: the confirm page (one constant question, the machine, account and
 * key fingerprint in a facts panel, Approve or Deny, or Replace and Pair-as on the same-name
 * branch, each a short verb with the name it acts on described under it), the provisioning
 * error page with its Retry, and the plain refusal page for a bad callback or state.
 *
 * Built only from the console UI kit (`ui/kit.ts`), so every value is escaped there and every
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
import { button, chip, facts, form, heading, notice, page, prose, type Html } from "../ui/kit.ts";

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
    // A constant question: the names live in the panel below, so a 32-character name never
    // turns the heading or the decisions into a wall of text at enlarged sizes.
    heading("Pair this machine?"),
    prose("Approving gives this machine its own private address that only you can open."),
    facts([
      ["Machine", chip(i.machineName)],
      ["Signed in as", chip(i.email)],
      ["Machine key fingerprint", chip(i.fingerprint, { mono: true })],
    ]),
    prose("Check that this fingerprint matches the one ", chip("yaran cloud login"), " printed in your terminal. If it does not match, or you did not just run that command, choose Deny."),
  ];
  if (i.sameName) {
    body.push(
      // The name is in the panel above; the notice and the choices say what happens to it.
      notice("info", "You already have an active machine with this name."),
      // Two distinct actions, both approvals: Replace carries replace_machine_id, Pair-as omits it.
      form(
        PAIR_FORM_ACTION,
        { ...hidden, decision: "approve" },
        [
          button({
            name: "replace_machine_id",
            value: i.sameName.id,
            text: "Replace the old machine",
            primary: true,
            hint: { id: "replace-hint", parts: ["For the same computer paired again: it keeps the name, and the old machine is removed only after this one connects."] },
          }),
          button({ text: "Pair as a new machine", hint: { id: "pair-as-hint", parts: ["Adds this computer as ", chip(i.sameName.nextName), ", next to the old one."] } }),
        ],
        "Approve pairing",
      ),
      // Replacing removes a machine, so focus starts on the refusal rather than preselecting it.
      // Pinned to the screen's bottom, so that focus does not scroll the question out of view.
      form(PAIR_FORM_ACTION, hidden, [button({ name: "decision", value: "deny", text: "Deny", focus: true })], "Deny pairing", { sticky: true }),
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
