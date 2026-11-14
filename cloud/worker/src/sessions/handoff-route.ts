/**
 * The control-plane handoff (W16 `GET /v1/handoff`, W16b `POST /v1/handoff`, D8, D24):
 * validates the phone's request, shows the consent interstitial (or skips it under the
 * remembered-consent rule), and seals the control-plane Access JWT to the phone's
 * ephemeral key as 02's JWE, answered as a redirect to the app's callback.
 *
 * - Runs behind the control-plane Access app; the pipeline has run `requireUser`.
 * - Nothing is ever redirected to an unlisted URL: a refusal redirects only when
 *   `build`, `redirect` and `state` are valid, and is a plain 400 otherwise.
 * - The JWT is sealed exactly as Access attached it and never logged or audited.
 * - Only an explicit Continue whose GET verified the device signature sets the consent
 *   cookie; Cancel neither sets nor clears it.
 *
 * <module-headers:begin>
 * Uses:
 * src/sessions/handoff-route.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/http/responses.ts
 * ├── src/provisioning/context.ts
 * ├── src/routes/call.ts
 * ├── src/sessions/handoff-csrf.ts
 * ├── src/sessions/handoff-page.ts
 * ├── src/sessions/handoff-params.ts
 * └── src/sessions/handoff-remembered.ts
 * External: none
 *
 * Used by:
 * src/sessions/handoff-route.ts
 * └── src/routes/pairing-and-sessions.ts
 * <module-headers:end>
 */
import { errorEntry, sealHandoff, utf8Decode, type ErrorCode, type HandoffPayload } from "@yaran/protocol";
import type { Handler, Phase06Ctx, RouteCall, RouteRow } from "../routes/call.ts";
import { errorResponse, HttpError } from "../http/responses.ts";
import { appCallbackUrls } from "../provisioning/context.ts";
import { type UserIdentity } from "../routes/call.ts";
import { consumeHandoffCsrf, mintHandoffCsrf, pkThumbprint } from "./handoff-csrf.ts";
import { consentPage, handoffErrorPage, platformFromUa } from "./handoff-page.ts";
import {
  callbackUrl,
  parseHandoffConsent,
  parseHandoffQuery,
  type HandoffCommon,
  type RedirectTarget,
  type Refusal,
} from "./handoff-params.ts";
import { consentCookieHeader, deviceSignatureVerified, readCookie, rememberedConsent } from "./handoff-remembered.ts";

const REDIRECT_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Type": "text/html; charset=utf-8",
} as const;

function redirectTo(location: string, status: 302 | 303, extra: Record<string, string> = {}): Response {
  const href = location.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return new Response(`<a href="${href}">Return to the app</a>`, { status, headers: { ...REDIRECT_HEADERS, ...extra, Location: location } });
}

function isNavigation(req: Request): boolean {
  return req.headers.get("Sec-Fetch-Mode") === "navigate" || (req.headers.get("Accept") ?? "").includes("text/html");
}

/** A refusal: a redirect to the callback when allowed, else the 400 envelope or page. */
function refuse(call: RouteCall, r: Pick<Refusal, "code" | "target" | "extra">, status: 302 | 303, retryAfterS?: number): Response {
  const extra: Record<string, string> = retryAfterS === undefined ? {} : { "Retry-After": String(retryAfterS) };
  if (r.target) return redirectTo(callbackUrl(r.target, { error: r.code, ...r.extra }), status, extra);
  if (isNavigation(call.req)) {
    const misconfigured = appCallbackUrls(call.ctx.env.APP_CALLBACK_URLS).every((u) => !u.startsWith("https://"));
    return handoffErrorPage(r.code, errorEntry(r.code)?.status ?? 400, misconfigured);
  }
  const message = r.code === "handoff_request_invalid" ? "The handoff request is malformed or names a callback this org does not allow." : `The handoff request was refused: ${r.code}.`;
  return errorResponse(new HttpError(r.code, message, Object.keys(r.extra).length ? { details: r.extra } : {}), "json", call.ctx.requestId);
}

async function controlPlaneHost(ctx: Phase06Ctx): Promise<string> {
  const host = (await ctx.settings.internal()).controlPlaneHost;
  if (!host) throw new HttpError("setup_incomplete", "Setup has not recorded the control-plane host yet.");
  return host;
}

function requireIdentity(call: RouteCall): { user: UserIdentity; jwt: string } {
  const jwt = call.req.headers.get("Cf-Access-Jwt-Assertion");
  if (!call.user || !jwt) throw new HttpError("handoff_jwt_missing", "No Access JWT reached the Worker; the control-plane Access app must cover /v1/handoff.");
  return { user: call.user, jwt };
}

/** Rate limit, seal and redirect: shared by Continue (303) and a remembered skip (302). */
async function issue(
  call: RouteCall,
  host: string,
  q: HandoffCommon,
  target: RedirectTarget,
  status: 302 | 303,
  consent: "explicit" | "remembered",
  setCookie: string | null,
): Promise<Response> {
  const { user, jwt } = requireIdentity(call);
  const limit = await call.ctx.rateLimit("handoff", user.sub);
  if (!limit.ok) return refuse(call, { code: "rate_limited", target, extra: {} }, status, limit.retryAfterS);
  const payload: HandoffPayload = { v: 1, kind: "control_plane", host, jwt, email: user.email, exp: user.exp, iat: call.ctx.now() };
  const cfCookie = readCookie(call.req.headers.get("Cookie"), "CF_Authorization");
  if (cfCookie) payload.cookie = cfCookie;
  const jwe = await sealHandoff({ recipientPk: q.pk, host, state: q.state, payload });
  await call.ctx.audit.record({
    action: "handoff.issued",
    actor: { kind: "user", id: user.userId },
    target: { kind: "user", id: user.userId },
    outcome: "ok",
    // A thumbprint prefix identifies the envelope's recipient without a long key-like run in the log.
    detail: { consent, build: q.build, mode: q.mode, pk_kid: (await pkThumbprint(q.pk)).slice(0, 12) },
  });
  return redirectTo(callbackUrl(target, { jwe }), status, setCookie ? { "Set-Cookie": setCookie } : {});
}

const getHandoff: Handler = async (call) => {
  const { ctx, req } = call;
  const host = await controlPlaneHost(ctx);
  const parsed = parseHandoffQuery(new URL(req.url).searchParams, appCallbackUrls(ctx.env.APP_CALLBACK_URLS), ctx.now());
  if (!parsed.ok) return refuse(call, parsed, 302);
  const q = parsed.value;
  const { user } = requireIdentity(call);
  const verified = await deviceSignatureVerified(host, q);
  if (await rememberedConsent(ctx, req, host, q, verified)) return issue(call, host, q, parsed.target, 302, "remembered", null);
  const csrf = await mintHandoffCsrf(ctx, { userId: user.userId, state: q.state, pk: q.pk, dk: q.dk }, verified);
  return consentPage({ q, host, email: user.email, platform: platformFromUa(req.headers.get("User-Agent")), csrf });
};

const postHandoff: Handler = async (call) => {
  const { ctx, req } = call;
  const host = await controlPlaneHost(ctx);
  const form = new URLSearchParams(utf8Decode(call.body) ?? "");
  const parsed = parseHandoffConsent(form, appCallbackUrls(ctx.env.APP_CALLBACK_URLS));
  if (!parsed.ok) return refuse(call, parsed, 303);
  const q = parsed.value;
  const fail = (code: ErrorCode) => refuse(call, { code, target: parsed.target, extra: {} }, 303);
  const origin = req.headers.get("Origin");
  if (origin !== null && origin !== `https://${host}`) return fail("origin_mismatch");
  const { user } = requireIdentity(call);
  const csrf = await consumeHandoffCsrf(ctx, q.csrf, { userId: user.userId, state: q.state, pk: q.pk, dk: q.dk });
  if (!csrf.ok) return fail("handoff_request_invalid");
  switch (q.decision) {
    case "cancel":
      await ctx.audit.record({ action: "handoff.declined", actor: { kind: "user", id: user.userId }, target: { kind: "user", id: user.userId }, outcome: "ok", detail: { build: q.build } });
      return fail("handoff_declined");
    case "continue":
      return issue(call, host, q, parsed.target, 303, "explicit", csrf.verified ? await consentCookieHeader(ctx, host, csrf.dkFingerprint) : null);
    default: {
      const never: never = q.decision;
      throw new Error(`unhandled decision ${String(never)}`);
    }
  }
};

// Protocol "none": W16/W16b negotiate `v` themselves, so a refusal can redirect to the app.
export const HANDOFF_ROUTES: RouteRow[] = [
  { method: "GET", path: "/v1/handoff", auth: { kind: "user" }, kind: "html", protocol: "none", handler: getHandoff, rateLimit: "auth", bodyLimit: 0 },
  { method: "POST", path: "/v1/handoff", auth: { kind: "user" }, kind: "html", protocol: "none", handler: postHandoff, rateLimit: "auth", bodyLimit: 16384 },
];
