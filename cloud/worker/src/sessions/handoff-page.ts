/**
 * The control-plane handoff pages: the one-tap consent interstitial W16 renders and the
 * minimal error page a browser navigation gets when nothing may be redirected.
 *
 * The interstitial is what stops a silent SSO auto-approve from signing a device in:
 * it names the device, its platform, the host and the signed-in email, and only an
 * explicit Continue completes the handoff.
 *
 * - No script. `form-action` is widened to exactly the validated redirect's origin
 *   (`yaranapp:` for a dev build) because CSP checks it on the 303 the POST answers.
 * - The platform comes from the system browser's User-Agent; a 02 §11 app token wins.
 *
 * <module-headers:begin>
 * Uses:
 * src/sessions/handoff-page.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/seams/ui-kit.ts
 * └── src/sessions/handoff-params.ts
 * External: none
 *
 * Used by:
 * src/sessions/handoff-page.ts
 * └── src/sessions/handoff-route.ts
 * <module-headers:end>
 */
import { parseYaranAppUa, type ErrorCode } from "@yaran/protocol";
import { button, chip, form, heading, notice, page, prose, type Html } from "../seams/ui-kit.ts";
import type { HandoffGet } from "./handoff-params.ts";

/** Android, iOS or iPadOS from a User-Agent, or null when unrecognised. */
export function platformFromUa(ua: string | null): string | null {
  if (!ua) return null;
  const app = parseYaranAppUa(ua);
  if (app) return app.os === "android" ? "Android" : app.form === "tablet" ? "iPadOS" : "iOS";
  if (/\bAndroid\b/.test(ua)) return "Android";
  if (/\biPad\b/.test(ua)) return "iPadOS";
  if (/\b(?:iPhone|iPod)\b/.test(ua)) return "iOS";
  return null;
}

/** The CSP `form-action` source for the redirect a consent POST answers with. */
export function formActionFor(q: Pick<HandoffGet, "build" | "redirect">): string {
  return q.build === "dev" ? "yaranapp:" : new URL(q.redirect).origin;
}

export interface ConsentPageInput {
  q: HandoffGet;
  host: string;
  email: string;
  platform: string | null;
  csrf: string;
}

export function consentPage(i: ConsentPageInput): Response {
  const { q } = i;
  const who: (Html | string)[] = [chip(q.device, { label: "Device" })];
  if (i.platform) who.push(" on ", chip(i.platform, { label: "Platform" }));
  who.push(" wants to sign in to ", chip(i.host, { label: "Host" }), " as ", chip(i.email, { label: "Signed-in email" }), ".");
  const body: Html[] = [
    heading("Sign this device in to ", chip(i.host), "?"),
    prose(...who),
    prose("Continue only if you just started signing in on this phone. If you did not, choose Cancel and nothing is shared."),
  ];
  if (q.build === "dev") {
    body.push(
      notice("warning", "This request comes from a development build of the yaran app. Continue only if you built or installed that build yourself."),
    );
  }
  body.push(
    form(
      "/v1/handoff",
      { v: String(q.v), pk: q.pk, state: q.state, redirect: q.redirect, build: q.build, mode: q.mode, device: q.device, dk: q.dk, csrf: i.csrf },
      [
        button({ name: "decision", value: "continue", text: "Continue", primary: true, focus: true }),
        button({ name: "decision", value: "cancel", text: "Cancel" }),
      ],
      "Sign-in consent",
    ),
  );
  return page(body, { title: "Sign this device in", formAction: formActionFor(q) });
}

/** A browser navigation's answer to a refusal that has no callback to go to. */
export function handoffErrorPage(code: ErrorCode, status: number, misconfigured = false): Response {
  const body = [
    heading("This sign-in link can't be used"),
    prose("The app sent a request this server won't complete. Go back to the app and start signing in again. If it keeps happening, tell your admin this code: ", chip(code), "."),
  ];
  if (misconfigured) {
    body.push(notice("error", "This org has no https app callback configured, so release builds of the app can't sign in. An admin sets ", chip("APP_CALLBACK_URLS"), " in the Worker's deploy configuration."));
  }
  return page(body, { title: "Sign-in refused", status });
}
