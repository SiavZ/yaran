/**
 * The offline overlay's sign-in and server-problem faces: what it says for an
 * access-session verdict that is not `ok`, and which controls it offers.
 *
 * In a browser, Sign in is a link to `/__yaran/signed-in` in a new tab: Access intercepts
 * that navigation, the user signs in there, and this tab's probe sees `ok` with no reload.
 * Inside the app it navigates to `yaranapp://reauth?host=<hostname>`, which machine-view
 * intercepts before navigation and answers with its sealed handoff.
 *
 * - Names (the host, a command) are chips, never quotations.
 * - "Cloudflare Access" is named only on the machine's cloud hostname.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/native/accessFace.ts
 * ├── src/lib/assertNever.ts
 * ├── src/lib/native/accessSession.ts
 * └── src/lib/prose.tsx
 * External: none
 *
 * Used by:
 * src/lib/native/accessFace.ts
 * └── src/components/OfflineOverlay.tsx
 * <module-headers:end>
 */
import { assertNever } from "@/lib/assertNever"
import { chip, type Prose } from "@/lib/prose"
import type { AccessSnapshot } from "./accessSession"

export type AccessFace = {
  title: string
  body: Prose
  signIn: boolean
  reconnect: boolean
}

export type AccessFaceContext = {
  /** `location.hostname`: never `host`, which carries a port. */
  hostname: string
  /** Whether the page is on the machine's cloud hostname. */
  onCloudHostname: boolean
  native: boolean
}

/** The face for a verdict, or null for `ok` (the ordinary reconnect faces apply). */
export function accessFaceFor(s: AccessSnapshot, ctx: AccessFaceContext): AccessFace | null {
  const host = chip(ctx.hostname)
  const signInWord = ctx.onCloudHostname ? "Cloudflare Access sign-in" : "sign-in"
  switch (s.state) {
    case "ok":
      return null
    case "signin_needed":
      return {
        title: "Sign in again",
        body: ctx.native
          ? [`Your ${signInWord} for `, host, " has expired. Sign in again to keep working; yaran picks up where it left off."]
          : [`Your ${signInWord} for `, host, " has expired, so yaran can't reach this machine. Sign in in a new tab, then come back here. yaran reconnects on its own."],
        signIn: true,
        reconnect: false,
      }
    case "signin_maybe":
      return {
        title: "Can't reach yaran",
        body: ["yaran can't reach ", host, `. The server may be down, or your ${signInWord} may have expired. Reconnect, or sign in again.`],
        signIn: true,
        reconnect: true,
      }
    case "server_problem": {
      const refusal = s.refusal
      switch (refusal) {
        case "access-keys-unavailable":
          return {
            title: "yaran can't check your sign-in",
            body: [host, " can't reach Cloudflare's key service to check your sign-in, so signing in again won't help. Reconnect in a moment."],
            signIn: false,
            reconnect: true,
          }
        case "host-not-served":
        case "host-missing":
          return {
            title: "This machine is no longer connected",
            body: [host, " is no longer connected to the cloud, so yaran can't reach it here. Connect it again on the machine with ", chip("yaran cloud login"), ", then reconnect."],
            signIn: false,
            reconnect: true,
          }
        default:
          return assertNever(refusal)
      }
    }
    default:
      return assertNever(s)
  }
}
