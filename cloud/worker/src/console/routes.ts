/**
 * The user console's routes (02 W30) and the helpers the admin console's routes share.
 *
 * `GET /` redirects to `/console`. Every POST must come from this origin; every
 * destructive action has a GET confirm page and a POST that does it and redirects back
 * with a flash naming the target. Auth class `user`: 04's pipeline has already verified
 * the Access JWT and the user row before a handler runs.
 *
 * <module-headers:begin>
 * Uses:
 * src/console/routes.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/admin/settings-schema.ts
 * ├── src/admin/settings-store.ts
 * ├── src/admin/stale-policy.ts
 * ├── src/console/flash.ts
 * ├── src/console/route-types.ts
 * ├── src/console/ui/security-headers.ts
 * ├── src/console/ui/shell.tsx
 * ├── src/console/ui/strings.ts
 * └── src/console/user-pages.tsx
 * External: none
 *
 * Used by:
 * src/console/routes.ts
 * ├── src/console/admin-routes.ts
 * ├── src/phase07.ts
 * └── test/console.test.ts
 * <module-headers:end>
 */
import type { AdminMachine } from "@yaran/protocol";
import { readSettings } from "../admin/settings-schema.ts";
import { readKey } from "../admin/settings-store.ts";
import { staleVerdict } from "../admin/stale-policy.ts";
import type { RouteCtx, RouteRow } from "./route-types.ts";
import { clearFlash, readFlash, setFlash, type Flash } from "./flash.ts";
import { renderPage } from "./ui/shell.tsx";
import { formOriginOk, htmlResponse, redirect } from "./ui/security-headers.ts";
import { S } from "./ui/strings.ts";
import { ConnectPage, MachinesPage, PhonesPage, RemovePhoneConfirmPage, UnpairConfirmPage } from "./user-pages.tsx";

type Node = Parameters<typeof renderPage>[0];

/** Renders a page; clears the flash cookie when the request carried one. */
export async function page(ctx: RouteCtx, node: Node, status = 200): Promise<Response> {
  const headers: Record<string, string> = readFlash(ctx.request) ? { "Set-Cookie": clearFlash() } : {};
  return htmlResponse(await renderPage(node), status, headers);
}

export function done(location: string, flash: Flash): Response {
  return redirect(location, { "Set-Cookie": setFlash(flash) });
}

/** POST guard: refuses a form submitted from another origin. */
export function originRefusal(ctx: RouteCtx): Response | null {
  return formOriginOk(ctx.request, ctx.url.origin) ? null : htmlResponse(S.originRefused, 403);
}

export async function orgName(ctx: RouteCtx): Promise<string> {
  return (await readSettings(ctx.deps.db)).org_name;
}

export async function staleIds(ctx: RouteCtx, machines: readonly AdminMachine[]): Promise<Set<string>> {
  const policy = (await readSettings(ctx.deps.db)).stale_machine_policy;
  const now = ctx.deps.now();
  return new Set(machines.filter((m) => staleVerdict(policy, m.last_seen_at, m.paired_at, now) !== "keep").map((m) => m.id));
}

export async function orgUrl(ctx: RouteCtx): Promise<string> {
  return `https://${(await readKey<string>(ctx.deps.db, "control_plane_host")) ?? ctx.url.host}`;
}

/** Placeholder store links until the app ships (D16: no invented domains or listings). */
export const STORE_LINKS = [{ label: "yaran on GitHub (store and F-Droid links arrive with the first app release)", href: "https://github.com/SiavZ/yaran" }];

function base(ctx: RouteCtx, name: string) {
  return { orgName: name, flash: readFlash(ctx.request), isAdmin: ctx.identity!.role === "admin" };
}

const user = { kind: "user" } as const;
const html = "html" as const;

async function ownMachine(ctx: RouteCtx): Promise<AdminMachine | null> {
  const m = await ctx.deps.pairing.getMachine(ctx.params.id!);
  return m && m.owner_email === ctx.identity!.email ? m : null;
}

export const USER_ROUTES: readonly RouteRow[] = [
  { method: "GET", path: "/", auth: user, kind: html, handler: async () => redirect("/console") },
  {
    method: "GET",
    path: "/console",
    auth: user,
    kind: html,
    async handler(ctx) {
      const { items } = await ctx.deps.pairing.listMachines({ owner_user_id: ctx.identity!.user_id, limit: 100 });
      return page(ctx, MachinesPage({ ...base(ctx, await orgName(ctx)), machines: items, staleIds: await staleIds(ctx, items) }));
    },
  },
  {
    method: "GET",
    path: "/console/machines/:id/unpair",
    auth: user,
    kind: html,
    handler: async (ctx) => page(ctx, UnpairConfirmPage({ orgName: await orgName(ctx), machine: await ownMachine(ctx), id: ctx.params.id! })),
  },
  {
    method: "POST",
    path: "/console/machines/:id/unpair",
    auth: user,
    kind: html,
    async handler(ctx) {
      const refused = originRefusal(ctx);
      if (refused) return refused;
      const machine = await ownMachine(ctx);
      if (!machine) return page(ctx, UnpairConfirmPage({ orgName: await orgName(ctx), machine: null, id: ctx.params.id! }), 404);
      await ctx.deps.pairing.unpairMachine(ctx.identity!.user_id, machine.id);
      return done("/console", { kind: "unpaired", target: machine.name });
    },
  },
  {
    method: "GET",
    path: "/console/phones",
    auth: user,
    kind: html,
    async handler(ctx) {
      const { items } = await ctx.deps.pairing.listDevices({ owner_user_id: ctx.identity!.user_id, limit: 100 });
      return page(ctx, PhonesPage({ ...base(ctx, await orgName(ctx)), devices: items }));
    },
  },
  {
    method: "GET",
    path: "/console/phones/:id/remove",
    auth: user,
    kind: html,
    async handler(ctx) {
      const d = await ctx.deps.pairing.getDevice(ctx.params.id!);
      const own = d && d.owner_email === ctx.identity!.email ? d : null;
      const action = `/console/phones/${encodeURIComponent(ctx.params.id!)}/remove`;
      return page(ctx, RemovePhoneConfirmPage({ orgName: await orgName(ctx), device: own, id: ctx.params.id!, action, backHref: "/console/phones", withSignOut: true }));
    },
  },
  {
    method: "POST",
    path: "/console/phones/:id/remove",
    auth: user,
    kind: html,
    async handler(ctx) {
      const refused = originRefusal(ctx);
      if (refused) return refused;
      const d = await ctx.deps.pairing.getDevice(ctx.params.id!);
      if (!d || d.owner_email !== ctx.identity!.email) return redirect("/console/phones/" + encodeURIComponent(ctx.params.id!) + "/remove");
      const signOut = (await ctx.request.formData()).get("sign_out_everywhere") !== null;
      await ctx.deps.pairing.revokeDevice(d.id, { signOutEverywhere: signOut });
      return done("/console/phones", { kind: "phone_removed", target: d.label });
    },
  },
  {
    method: "GET",
    path: "/console/connect",
    auth: user,
    kind: html,
    async handler(ctx) {
      const url = await orgUrl(ctx);
      return page(ctx, ConnectPage({ ...base(ctx, await orgName(ctx)), orgUrl: url, qrSvg: ctx.deps.pairing.phoneQrSvg(url), storeLinks: STORE_LINKS }));
    },
  },
];
