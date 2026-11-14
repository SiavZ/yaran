/**
 * The setup wizard's routes (02 W29): `/setup*`, HTML only, auth class `setup`.
 *
 * Every request first checks the deploy secrets and the lockout; every step after the code
 * needs the setup cookie, and every POST must come from this origin. GET renders the
 * current step; POST runs one step through its module and advances the reducer, then
 * redirects back (post/redirect/get), so a reload never repeats a Cloudflare write.
 *
 * - Cloudflare failures render as a notice on the step, never a stack trace.
 *
 * <module-headers:begin>
 * Uses:
 * src/setup/routes.ts
 * ├── src/admin/api-token.ts
 * ├── src/admin/ports.ts
 * ├── src/admin/settings-schema.ts
 * ├── src/admin/settings-store.ts
 * ├── src/cloudflare/errors.ts
 * ├── src/console/route-types.ts
 * ├── src/console/ui/security-headers.ts
 * ├── src/console/ui/shell.tsx
 * ├── src/http/host-guard.ts
 * ├── src/security/rate-limit.ts
 * ├── src/setup/capability-probe.ts
 * ├── src/setup/pages-steps.tsx
 * ├── src/setup/pages.tsx
 * ├── src/setup/setup-gate.ts
 * ├── src/setup/steps/access.ts
 * ├── src/setup/steps/claim.ts
 * ├── src/setup/steps/common.ts
 * ├── src/setup/steps/domain.ts
 * ├── src/setup/steps/idp.ts
 * ├── src/setup/steps/keys.ts
 * ├── src/setup/steps/org.ts
 * ├── src/setup/steps/zone.ts
 * └── src/setup/wizard-state.ts
 * External: none
 *
 * Used by:
 * src/setup/routes.ts
 * ├── src/phase07.ts
 * └── test/setup-flow.test.ts
 * <module-headers:end>
 */
import { CfApiError } from "../cloudflare/errors.ts";
import { renderPage } from "../console/ui/shell.tsx";
import { formOriginOk, htmlResponse, redirect } from "../console/ui/security-headers.ts";
import type { RouteCtx, RouteRow } from "../console/route-types.ts";
import { storeToken, storedCf } from "../admin/api-token.ts";
import { readSettings } from "../admin/settings-schema.ts";
import { writeKeys } from "../admin/settings-store.ts";
import { assertNever } from "../admin/ports.ts";
import { probeCapabilities, probePassed, resolveAccount } from "./capability-probe.ts";
import { checkSetupCode, codeId, hasSetupSession, issueSetupCookie, lockReason, secretProblems } from "./setup-gate.ts";
import { scriptNameFromHost } from "../http/host-guard.ts";
import { setupAttempt } from "../security/rate-limit.ts";
import { CodePage, LockedPage, SecretsPage, TokenPage } from "./pages.tsx";
import { AccessPage, ClaimInvalidPage, ClaimPage, DomainPage, DonePage, IdpPage, KeysPage, OrgPage, ZonePage, type StepProblem } from "./pages-steps.tsx";
import { advance, loadRecord } from "./steps/common.ts";
import { createOrg, readOrg } from "./steps/org.ts";
import { chooseHostname, listZones } from "./steps/zone.ts";
import { ensureAccess } from "./steps/access.ts";
import { attachDomain, checkDomain } from "./steps/domain.ts";
import { addIdp, finishIdp, listIdps, type IdpKind } from "./steps/idp.ts";
import { ensureVapidKey } from "./steps/keys.ts";
import { issueClaim, redeemClaim } from "./steps/claim.ts";
import type { SetupEvent, SetupRecord } from "./wizard-state.ts";

type Node = Parameters<typeof renderPage>[0];

const page = async (node: Node, status = 200, headers: Record<string, string> = {}) => htmlResponse(await renderPage(node), status, headers);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clientIp = (ctx: RouteCtx) => ctx.request.headers.get("CF-Connecting-IP") ?? "unknown";

/** Secrets, lockout, session and origin checks shared by every setup route. */
async function gate(ctx: RouteCtx, needSession: boolean): Promise<Response | { record: SetupRecord; code: string }> {
  const { deps } = ctx;
  const problems = secretProblems(deps.env, deps.dataKeyValid);
  if (problems.length > 0) return page(SecretsPage({ problems }), 503);
  const code = deps.env.SETUP_CODE!;
  const record = await loadRecord(deps.db);
  if (record.step === "closed") return htmlResponse("Setup is closed.", 410);
  const locked = await lockReason(deps.db, code, clientIp(ctx));
  if (locked) return page(LockedPage({ reason: locked }), 403);
  if (ctx.request.method === "POST" && !formOriginOk(ctx.request, ctx.url.origin)) return htmlResponse("This form was submitted from another site.", 403);
  if (needSession && !(await hasSetupSession(ctx.request, code, deps.now()))) return redirect("/setup");
  return { record, code };
}

async function showStep(ctx: RouteCtx, record: SetupRecord, problem?: StepProblem): Promise<Response> {
  const cf = () => storedCf(ctx.deps);
  try {
    switch (record.step) {
      case "locked":
      case "token":
        return page(TokenPage({ envToken: !!ctx.deps.env.CF_API_TOKEN }));
      case "org":
        return page(OrgPage({ problem }));
      case "zone":
        return page(ZonePage({ zones: await listZones(await cf()), problem }));
      case "access":
        return page(AccessPage({ record, problem }));
      case "domain":
        return page(DomainPage({ record, problem }));
      case "idp":
        return page(IdpPage({ idps: await listIdps(await cf(), record.account_id!), teamDomain: record.team_domain!, problem }));
      case "keys":
        return page(KeysPage());
      case "claim":
        return page(ClaimPage({ record }));
      case "closed":
        return htmlResponse("Setup is closed.", 410);
      default:
        return assertNever(record.step);
    }
  } catch (e) {
    if (e instanceof CfApiError && problem !== "cloudflare_error") return showStep(ctx, record, "cloudflare_error");
    throw e;
  }
}

async function getSetup(ctx: RouteCtx): Promise<Response> {
  const g = await gate(ctx, false);
  if (g instanceof Response) return g;
  if (!(await hasSetupSession(ctx.request, g.code, ctx.deps.now()))) return page(CodePage({}));
  return showStep(ctx, g.record);
}

async function postCode(ctx: RouteCtx): Promise<Response> {
  const g = await gate(ctx, false);
  if (g instanceof Response) return g;
  // 04's per-address policy: 5 tries per 15 min and 30 a day, right or wrong, then the
  // code check, whose wrong answers count toward locking this address (never the wizard).
  const ip = clientIp(ctx);
  const nowS = Math.floor(ctx.deps.now().getTime() / 1000);
  const attempt = await setupAttempt(ctx.deps.db, ip, await codeId(g.code), nowS);
  if (attempt.kind === "locked") return page(LockedPage({ reason: attempt.reason }), 403);
  if (attempt.kind === "limited") {
    const retryAfter = Math.max(1, attempt.retryAfter);
    return page(CodePage({ error: "rate_limited", limit: attempt.reason, retryAfter }), 429, { "Retry-After": String(retryAfter) });
  }
  const input = String((await ctx.request.formData()).get("code") ?? "");
  const verdict = await checkSetupCode(ctx.deps.db, input, g.code, ip, nowS);
  if (verdict.kind === "setup_locked") return page(LockedPage({ reason: verdict.reason }), 403);
  if (verdict.kind === "setup_code_invalid") return page(CodePage({ error: "setup_code_invalid" }), 401);
  if (g.record.step === "locked") await advance(ctx.deps.db, g.record, { kind: "code_ok" }, ctx.deps.now());
  return redirect("/setup", { "Set-Cookie": await issueSetupCookie(g.code, ctx.deps.now()) });
}

async function postToken(ctx: RouteCtx): Promise<Response> {
  const g = await gate(ctx, true);
  if (g instanceof Response) return g;
  const form = await ctx.request.formData();
  const token = String(form.get("token") ?? "").trim() || ctx.deps.env.CF_API_TOKEN || "";
  const adminEmail = String(form.get("admin_email") ?? "").trim().toLowerCase();
  const envToken = !!ctx.deps.env.CF_API_TOKEN;
  if (!token) return page(TokenPage({ envToken, error: "token_required", adminEmail }), 400);
  if (!EMAIL.test(adminEmail)) return page(TokenPage({ envToken, error: "email_required", adminEmail }), 400);
  const script = scriptNameFromHost(ctx.url.host);
  if (!script) return page(TokenPage({ envToken, error: "not_workers_dev", adminEmail }), 400);
  const cf = ctx.deps.cfFor(token);
  const account = await resolveAccount(cf, String(form.get("account_id") ?? "").trim() || undefined);
  if (!account.ok) return page(TokenPage({ envToken, accountProblem: account.reason, adminEmail }), 400);
  const rows = await probeCapabilities(cf, account.id, script);
  if (!probePassed(rows)) return page(TokenPage({ envToken, probe: rows, adminEmail }), 502);
  await storeToken(ctx.deps, token, "setup");
  const s = await readSettings(ctx.deps.db);
  await writeKeys(ctx.deps.db, { pairing_policy: { ...s.pairing_policy, emails: [adminEmail] } }, "setup", ctx.deps.now());
  await advance(ctx.deps.db, g.record, { kind: "probe_ok", account_id: account.id, admin_email: adminEmail, script_name: script }, ctx.deps.now());
  return redirect("/setup");
}

type StepRun = (ctx: RouteCtx, record: SetupRecord, form: FormData) => Promise<{ ok: true; event: SetupEvent } | { ok: false; problem: StepProblem } | { ok: "stay" }>;

/** Wraps one step: gate, run, advance on success, re-render with the problem otherwise. */
function stepRoute(path: string, run: StepRun): RouteRow {
  return {
    method: "POST",
    path,
    auth: { kind: "setup" },
    kind: "html",
    async handler(ctx) {
      const g = await gate(ctx, true);
      if (g instanceof Response) return g;
      let out: Awaited<ReturnType<StepRun>>;
      try {
        out = await run(ctx, g.record, await ctx.request.formData());
      } catch (e) {
        if (!(e instanceof CfApiError)) throw e;
        out = { ok: false, problem: "cloudflare_error" };
      }
      if (out.ok === "stay") return redirect("/setup");
      if (!out.ok) return showStep(ctx, g.record, out.problem);
      const t = await advance(ctx.deps.db, g.record, out.event, ctx.deps.now());
      return t.ok ? redirect("/setup") : showStep(ctx, g.record);
    },
  };
}

const runOrg: StepRun = async (ctx, r, form) => {
  const cf = await storedCf(ctx.deps);
  if (form.get("action") !== "create") return readOrg(cf, r.account_id!);
  const s = await readSettings(ctx.deps.db);
  return createOrg(cf, r.account_id!, String(form.get("team") ?? "").trim().toLowerCase(), s.org_name);
};

const runZone: StepRun = async (ctx, r, form) => {
  const out = await chooseHostname(await storedCf(ctx.deps), r.account_id!, String(form.get("zone_id") ?? ""), String(form.get("label") ?? ""));
  if (out.ok && out.event.kind === "hostname_chosen") {
    const s = await readSettings(ctx.deps.db);
    if (s.org_name === "yaran") await writeKeys(ctx.deps.db, { org_name: out.event.zone_name }, "setup", ctx.deps.now());
  }
  return out;
};

const runAccess: StepRun = async (ctx, r) => {
  const s = await readSettings(ctx.deps.db);
  const input = { accountId: r.account_id!, host: r.cp_host!, adminEmail: r.admin_email!, sessionDuration: s.session_duration, pairingPolicy: s.pairing_policy };
  return { ok: true, event: await ensureAccess(await storedCf(ctx.deps), input) };
};

const runDomain: StepRun = async (ctx, r, form) => {
  const input = { accountId: r.account_id!, host: r.cp_host!, zoneId: r.zone_id!, script: r.script_name! };
  const cf = await storedCf(ctx.deps);
  return form.get("action") === "check" ? checkDomain(cf, input) : attachDomain(cf, input);
};

const runIdp: StepRun = async (ctx, r, form) => {
  const cf = await storedCf(ctx.deps);
  const action = String(form.get("action") ?? "");
  if (action === "finish") return finishIdp(cf, r.account_id!);
  if (action !== "onetimepin" && action !== "github" && action !== "google") return { ok: "stay" };
  const kind: IdpKind = action;
  const added = await addIdp(cf, r.account_id!, kind, String(form.get(`${kind}_client_id`) ?? ""), String(form.get(`${kind}_client_secret`) ?? ""));
  return added.ok ? { ok: "stay" } : added;
};

const runKeys: StepRun = async (ctx) => ({ ok: true, event: await ensureVapidKey(ctx.deps.db, ctx.deps.sealer, ctx.deps.now()) });

async function postClaimLink(ctx: RouteCtx): Promise<Response> {
  const g = await gate(ctx, true);
  if (g instanceof Response) return g;
  if (g.record.step !== "claim") return redirect("/setup");
  return page(ClaimPage({ record: g.record, link: await issueClaim(ctx.deps, g.record.cp_host!) }));
}

async function getClaim(ctx: RouteCtx): Promise<Response> {
  const record = await loadRecord(ctx.deps.db);
  if (record.step === "closed") return htmlResponse("Setup is closed.", 410);
  const identity = await ctx.deps.accessIdentity(ctx.request);
  const out = await redeemClaim(ctx.deps, record, ctx.url.searchParams.get("c") ?? "", identity?.email ?? null, () => storedCf(ctx.deps));
  if (!out.ok) return page(ClaimInvalidPage(), 403);
  return page(DonePage({ record: out.record }));
}

const setup = { kind: "setup" } as const;

export const SETUP_ROUTES: readonly RouteRow[] = [
  { method: "GET", path: "/setup", auth: setup, kind: "html", handler: getSetup },
  { method: "POST", path: "/setup/code", auth: setup, kind: "html", handler: postCode },
  { method: "POST", path: "/setup/token", auth: setup, kind: "html", handler: postToken },
  stepRoute("/setup/org", runOrg),
  stepRoute("/setup/zone", runZone),
  stepRoute("/setup/access", runAccess),
  stepRoute("/setup/domain", runDomain),
  stepRoute("/setup/idp", runIdp),
  stepRoute("/setup/keys", runKeys),
  { method: "POST", path: "/setup/claim-link", auth: setup, kind: "html", handler: postClaimLink },
  { method: "GET", path: "/setup/claim", auth: setup, kind: "html", handler: getClaim },
];
