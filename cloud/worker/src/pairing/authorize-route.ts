/**
 * W2/W3 `/v1/pair/authorize`: the browser half of machine pairing (D7). The GET validates
 * the CLI's request and renders the confirm page; the POST approves (provisioning the
 * machine through 05, then redirecting a one-time code to the loopback callback) or denies.
 *
 * - Refusals redirect to `http://127.0.0.1:<port>/callback?error=<code>&state=<state>` once
 *   the callback and state are valid; before that they are a 400 page.
 * - Provisioning runs at approve so the claim answer is immediate; the saga is keyed by the
 *   machine id linked to the request, so Retry never creates a second machine.
 * - The per-user cap is checked at GET and again atomically when the machine row is inserted.
 *
 * <module-headers:begin>
 * Uses:
 * src/pairing/authorize-route.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/machines/machine-rows.ts
 * ├── src/pairing/authorize-page.ts
 * ├── src/pairing/authorize-params.ts
 * ├── src/pairing/pair-requests.ts
 * ├── src/pairing/pkce.ts
 * ├── src/seams/context.ts
 * └── src/seams/foundation.ts
 * External: none
 *
 * Used by:
 * src/pairing/authorize-route.ts
 * ├── src/routes/pairing-and-sessions.ts
 * └── test/pairing/authorize-route.test.ts
 * <module-headers:end>
 */
import { errorEntry, machineKeyFingerprint, utf8Decode, validate, type ErrorCode, type PairConsent, type Settings } from "@yaran/protocol";
import { getOwnedMachine, insertProvisioningMachine, liveMachineNames } from "../machines/machine-rows.ts";
import type { Phase06Ctx, RouteCall, RouteRow } from "../seams/context.ts";
import { ApiError, type UserIdentity } from "../seams/foundation.ts";
import { callbackUrl, parseAuthorizeQuery } from "./authorize-params.ts";
import { confirmPage, pairErrorPage } from "./authorize-page.ts";
import { randomToken } from "./pkce.ts";
import * as requests from "./pair-requests.ts";

/** Inline drive budget for the provisioning saga (05 design §4, driver 1). */
export const PROVISION_INLINE_BUDGET = { wallMs: 15_000, apiCalls: 20 };
const MACHINE_NAME_MAX = 32;

const statusOf = (code: ErrorCode) => errorEntry(code)?.status ?? 400;

function redirectTo(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...extra } });
}

function refuseToCallback(port: number, state: string, code: ErrorCode, details?: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  const params: Record<string, string> = { error: code, state };
  if (code === "protocol_unsupported" && details) Object.assign(params, { min: String(details["min"]), max: String(details["max"]) });
  return redirectTo(callbackUrl(port, params), headers);
}

/** `pairing_policy.mode = allowlist` admits a listed email or a listed email domain. */
export function pairingAllowed(policy: Settings["pairing_policy"], email: string): boolean {
  switch (policy.mode) {
    case "everyone":
      return true;
    case "allowlist": {
      const domain = email.slice(email.lastIndexOf("@") + 1);
      return policy.emails.some((e) => e.toLowerCase() === email) || policy.domains.some((d) => d.toLowerCase() === domain);
    }
    default: {
      const never: never = policy.mode;
      throw new Error(`unknown pairing policy ${String(never)}`);
    }
  }
}

/** The first `<base>-N` (N ≥ 2) not taken, kept a valid MachineName (≤ 32 chars). */
export function nextFreeName(base: string, taken: ReadonlySet<string>): string {
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, MACHINE_NAME_MAX - suffix.length).replace(/-+$/, "") + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

async function audit(ctx: Phase06Ctx, user: UserIdentity, action: "pair.requested" | "pair.approved" | "pair.denied" | "pair.refused" | "pair.provision_failed", o: { machineId?: string | null; outcome?: "ok" | "denied" | "failed"; errorCode?: ErrorCode; detail?: Record<string, unknown> }): Promise<void> {
  await ctx.audit.record({
    action,
    actor: { kind: user.role, id: user.userId },
    target: o.machineId ? { kind: "machine", id: o.machineId } : { kind: "user", id: user.userId },
    outcome: o.outcome ?? "ok",
    ...(o.errorCode ? { errorCode: o.errorCode } : {}),
    ...(o.detail ? { detail: o.detail } : {}),
  });
}

async function getAuthorize({ req, ctx, user }: RouteCall): Promise<Response> {
  const me = user!;
  const parsed = await parseAuthorizeQuery(new URL(req.url).searchParams);
  if (!parsed.ok) {
    if (!parsed.redirect) return pairErrorPage(parsed.code, { status: statusOf(parsed.code) });
    await audit(ctx, me, "pair.refused", { outcome: "denied", errorCode: parsed.code, detail: { reason: "invalid" } });
    return refuseToCallback(parsed.redirect.port, parsed.redirect.state, parsed.code, parsed.details);
  }
  const q = parsed.q;
  const settings = await ctx.settings.read();
  if (!pairingAllowed(settings.pairing_policy, me.email)) {
    await audit(ctx, me, "pair.refused", { outcome: "denied", errorCode: "pairing_not_allowed", detail: { reason: "policy" } });
    return refuseToCallback(q.callbackPort, q.state, "pairing_not_allowed");
  }
  const limited = await ctx.rateLimit("pair", me.email);
  if (!limited.ok) return refuseToCallback(q.callbackPort, q.state, "rate_limited", undefined, { "Retry-After": String(limited.retryAfterS) });

  const live = await liveMachineNames(ctx, me.userId);
  const same = live.find((m) => m.status === "active" && m.name === q.machineName) ?? null;
  if (!same && live.length >= settings.machine_cap_per_user) {
    await audit(ctx, me, "pair.refused", { outcome: "denied", errorCode: "machine_cap_reached", detail: { reason: "cap", limit: settings.machine_cap_per_user } });
    return refuseToCallback(q.callbackPort, q.state, "machine_cap_reached");
  }
  const csrf = randomToken(16);
  const requestId = await requests.createPending(ctx, {
    userId: me.userId,
    state: q.state,
    codeChallenge: q.codeChallenge,
    machinePublicKey: q.machinePubkey,
    machineName: q.machineName,
    callbackPort: q.callbackPort,
    originPort: q.originPort,
    yaranVersion: q.yaranVersion,
    csrf,
  });
  await audit(ctx, me, "pair.requested", { detail: { machine_name: q.machineName, origin_port: q.originPort } });
  return confirmPage({
    requestId,
    csrf,
    machineName: q.machineName,
    email: me.email,
    fingerprint: await machineKeyFingerprint(q.machinePubkey),
    callbackPort: q.callbackPort,
    sameName: same ? { id: same.id, nextName: nextFreeName(q.machineName, new Set(live.map((m) => m.name))) } : null,
  });
}

/** The W3 form as 02's `PairConsent`, or null when it is not one. */
export function parsePairConsent(body: Uint8Array): PairConsent | null {
  const text = utf8Decode(body);
  if (text === null) return null;
  const form = new URLSearchParams(text);
  const out: Record<string, string> = {};
  for (const [k, v] of form) {
    if (k in out) return null;
    out[k] = v;
  }
  return validate("PairConsent", out).valid ? (out as unknown as PairConsent) : null;
}

async function postAuthorize({ req, ctx, user, body }: RouteCall): Promise<Response> {
  const me = user!;
  const internal = await ctx.settings.internal();
  const origin = req.headers.get("Origin");
  if (origin !== null && origin !== `https://${internal.controlPlaneHost}`) return pairErrorPage("origin_mismatch", { status: statusOf("origin_mismatch") });
  const consent = parsePairConsent(body);
  if (!consent) return pairErrorPage("pair_request_invalid", { status: 400 });
  const row = await requests.getForUser(ctx, consent.request_id, me.userId);
  if (!row || !(await requests.csrfMatches(row, consent.csrf))) return pairErrorPage("pair_request_invalid", { status: 400 });
  if (row.status === "expired" || (row.status === "pending" && row.expires_at < ctx.now())) return pairErrorPage("pair_request_expired", { status: statusOf("pair_request_expired") });
  if (row.status !== "pending") return pairErrorPage("pair_request_invalid", { status: 400 });
  const state = await requests.openState(ctx, row);
  const port = row.callback_port;

  if (consent.decision === "deny") {
    if (consent.replace_machine_id !== undefined) return pairErrorPage("pair_request_invalid", { status: 400 });
    if (await requests.deny(ctx, row.id)) await audit(ctx, me, "pair.denied", { detail: { machine_name: row.machine_name } });
    return refuseToCallback(port, state, "pair_denied");
  }

  const settings = await ctx.settings.read();
  if (!pairingAllowed(settings.pairing_policy, me.email)) {
    await audit(ctx, me, "pair.refused", { outcome: "denied", errorCode: "pairing_not_allowed", detail: { reason: "policy" } });
    return refuseToCallback(port, state, "pairing_not_allowed");
  }
  const replace = consent.replace_machine_id ?? null;
  if (replace !== null) {
    const old = await getOwnedMachine(ctx, replace, me.userId);
    if (!old || old.status !== "active" || old.name !== row.machine_name) return pairErrorPage("pair_request_invalid", { status: 400 });
  }

  // One machine per pair request: the first approve creates and links it, a Retry reuses it.
  let machineId = row.machine_id;
  if (machineId === null) {
    const candidate = crypto.randomUUID();
    const taken = new Set((await liveMachineNames(ctx, me.userId)).map((m) => m.name));
    const inserted = await insertProvisioningMachine(ctx, {
      id: candidate,
      ownerUserId: me.userId,
      name: replace !== null || !taken.has(row.machine_name) ? row.machine_name : nextFreeName(row.machine_name, taken),
      publicKey: new Uint8Array(row.machine_public_key),
      originPort: row.origin_port,
      yaranVersion: row.yaran_version ?? "unknown",
      excludeFromCap: replace,
      cap: settings.machine_cap_per_user,
    });
    if (!inserted) {
      await audit(ctx, me, "pair.refused", { outcome: "denied", errorCode: "machine_cap_reached", detail: { reason: "cap", limit: settings.machine_cap_per_user } });
      return refuseToCallback(port, state, "machine_cap_reached");
    }
    if (await requests.linkMachine(ctx, row.id, candidate, replace)) {
      machineId = candidate;
    } else {
      // A concurrent approve linked its own machine first; drop ours (nothing was provisioned for it).
      await ctx.db.prepare("DELETE FROM machines WHERE id = ? AND status = 'provisioning'").bind(candidate).run();
      machineId = (await requests.getForUser(ctx, row.id, me.userId))?.machine_id ?? null;
      if (machineId === null) return pairErrorPage("pair_request_invalid", { status: 400 });
    }
  }

  const retry = { requestId: row.id, csrf: consent.csrf, fields: (replace ? { replace_machine_id: replace } : {}) as Record<string, string>, callbackPort: port };
  let view;
  try {
    const op = await ctx.provisioning.startProvision(machineId);
    view = await ctx.provisioning.driveOp(op.opId, PROVISION_INLINE_BUDGET);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    view = { state: "failed" as const, errorCode: e.code, ...(e.details ? { details: e.details } : {}) };
  }
  switch (view.state) {
    case "complete":
      break;
    case "in_progress":
      return pairErrorPage("provisioning_in_progress", { status: statusOf("provisioning_in_progress"), retry });
    case "failed":
    case "compensating": {
      const code = view.errorCode ?? "provisioning_failed";
      if (code === "account_quota_reached") {
        await audit(ctx, me, "pair.refused", { machineId, outcome: "denied", errorCode: code, detail: { reason: "quota" } });
      } else {
        await audit(ctx, me, "pair.provision_failed", { machineId, outcome: "failed", errorCode: code });
      }
      return pairErrorPage(code, { status: statusOf(code), retry, ...(view.details ? { details: view.details } : {}) });
    }
    default: {
      const never: never = view.state;
      throw new Error(`unknown op state ${String(never)}`);
    }
  }

  const code = randomToken(32);
  if (!(await requests.approve(ctx, row.id, code))) return pairErrorPage("pair_request_expired", { status: statusOf("pair_request_expired") });
  await audit(ctx, me, "pair.approved", { machineId, detail: { machine_name: row.machine_name, replace: replace !== null } });
  return redirectTo(callbackUrl(port, { code, state }));
}

export const PAIR_AUTHORIZE_ROUTES: RouteRow[] = [
  { method: "GET", path: "/v1/pair/authorize", auth: { kind: "user" }, kind: "html", handler: getAuthorize, rateLimit: "RL_AUTH", bodyLimit: 0 },
  { method: "POST", path: "/v1/pair/authorize", auth: { kind: "user" }, kind: "html", handler: postAuthorize, rateLimit: "RL_AUTH", bodyLimit: 4096 },
];
