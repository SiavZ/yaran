/**
 * The user's device registry routes: register (W12), list (W13), revoke (W14) and the
 * label and mutes patch (W31).
 *
 * The phone registers once per org with its install id, device key and push
 * subscription; the consoles list and revoke. Every refusal is a 02 code.
 *
 * - Ownership is part of every query; another user's id is `404`, never `403` (T34).
 * - `Yaran-Install-Id` must equal the body's `install_id` on W12 (`bad_request`).
 * - W14 stops push first, then (with `?sign_out_everywhere=1`) revokes the user's Access
 *   sessions; a failure there still leaves the phone removed and says so.
 *
 * <module-headers:begin>
 * Uses:
 * src/me/devices-route.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/devices/device-params.ts
 * ├── src/devices/devices-repo.ts
 * ├── src/http/responses.ts
 * ├── src/me/cursor.ts
 * ├── src/routes/call.ts
 * └── src/sessions/revoke-sessions.ts
 * External: none
 *
 * Used by:
 * src/me/devices-route.ts
 * └── src/routes/pairing-and-sessions.ts
 * <module-headers:end>
 */
import { utf8Decode, type DevicePage } from "@yaran/protocol";
import { checkPatch, checkRegistration } from "../devices/device-params.ts";
import { listDevices, patchDevice, revokeDevice, toDevice, upsertDevice } from "../devices/devices-repo.ts";
import type { RouteCall, RouteRow } from "../routes/call.ts";
import { HttpError } from "../http/responses.ts";
import { revokeSessions } from "../sessions/revoke-sessions.ts";
import { nextCursor, pageQuery } from "./cursor.ts";

const NO_STORE = { "Cache-Control": "no-store" };

function jsonBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(utf8Decode(body) ?? "");
  } catch {
    throw new HttpError("bad_request", "The request body is not JSON.");
  }
}

const notFound = () => new HttpError("not_found", "No phone with that id is registered to your account.");

async function register({ req, ctx, user, body }: RouteCall): Promise<Response> {
  const [settings, internal] = await Promise.all([ctx.settings.read(), ctx.settings.internal()]);
  const checked = await checkRegistration(jsonBody(body), { controlPlaneHost: internal.controlPlaneHost ?? "", zoneName: internal.zoneName ?? "" }, settings.push);
  const installId = req.headers.get("Yaran-Install-Id");
  if (installId !== checked.reg.install_id) throw new HttpError("bad_request", "The Yaran-Install-Id header must equal install_id.");
  const { row, created } = await upsertDevice(ctx, user!.userId, checked);
  await ctx.audit.record({
    action: created ? "device.registered" : "device.updated",
    actor: { kind: "user", id: user!.userId },
    target: { kind: "device", id: row.id },
    outcome: "ok",
    detail: { platform: row.platform, flavor: row.flavor, push_kind: row.push_kind },
  });
  return Response.json(toDevice(row, installId), { status: created ? 201 : 200, headers: NO_STORE });
}

async function list({ req, ctx, user }: RouteCall): Promise<Response> {
  const { limit, after } = pageQuery(new URL(req.url));
  const rows = await listDevices(ctx, user!.userId, limit, after);
  const current = req.headers.get("Yaran-Install-Id");
  const page: DevicePage = { items: rows.map((r) => toDevice(r, current)), next_cursor: nextCursor(rows, limit) };
  return Response.json(page, { headers: NO_STORE });
}

async function patch({ req, ctx, user, params, body }: RouteCall): Promise<Response> {
  const p = checkPatch(jsonBody(body));
  const row = await patchDevice(ctx, params["id"] ?? "", user!.userId, p);
  if (!row) throw notFound();
  await ctx.audit.record({
    action: "device.updated",
    actor: { kind: "user", id: user!.userId },
    target: { kind: "device", id: row.id },
    outcome: "ok",
    detail: { fields: Object.keys(p).sort() },
  });
  return Response.json(toDevice(row, req.headers.get("Yaran-Install-Id")), { headers: NO_STORE });
}

async function revoke({ req, ctx, user, params }: RouteCall): Promise<Response> {
  const signOutEverywhere = new URL(req.url).searchParams.get("sign_out_everywhere") === "1";
  const actor = { kind: "user" as const, id: user!.userId };
  if (!(await revokeDevice(ctx, params["id"] ?? "", { ownerUserId: user!.userId, actor, signOutEverywhere }))) throw notFound();
  if (signOutEverywhere) await revokeSessions(ctx, { email: user!.email, userId: user!.userId, actor });
  return new Response(null, { status: 204, headers: NO_STORE });
}

const row = (method: RouteRow["method"], path: string, handler: RouteRow["handler"], bodyLimit = 0): RouteRow => ({
  method, path, auth: { kind: "user" }, kind: "json", protocol: "header", handler, rateLimit: "ip", bodyLimit,
});

export const DEVICE_ROUTES: RouteRow[] = [
  row("POST", "/v1/me/devices", register, 16 * 1024),
  row("GET", "/v1/me/devices", list),
  row("PATCH", "/v1/me/devices/:id", patch, 8 * 1024),
  row("DELETE", "/v1/me/devices/:id", revoke),
];
