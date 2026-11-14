/**
 * Per-org push orchestration in the shell: register, reconcile on every foreground, turn off,
 * remove, drain endpoint changes queued while the WebView was not running, and sync mutes.
 *
 * Native code holds every key and endpoint and performs every Worker call (D22): registration
 * through `Push.registerDevice`, listing, mutes and removal through Phase 15's
 * `Session.request`. This module only decides when, and maps answers to `OrgRowState`.
 *
 * - Reconcile re-registers the current device when the Worker marked it `gone` or
 *   `auth_failed`, when its VAPID key differs from `Meta.push.vapid_public_key`, when the relay
 *   key id moved, or when the local subscription or endpoint host disagrees; `failing` is only
 *   shown. Every path that meets `device_revoked` forgets the org's local push state.
 * - "Turn off" re-registers with `push: {kind: none}` and never calls W14; removing the org does.
 *
 * <module-headers:begin>
 * Uses:
 * mobile/app/src/push/pushRegistration.ts
 * └── mobile/app/src/push/pushPermission.ts
 * External: @yaran/protocol, @yaran/push
 *
 * Used by:
 * mobile/app/src/push/pushRegistration.ts
 * ├── mobile/app/src/push/pushRegistration.test.ts
 * └── mobile/app/src/push/pushTestKit.ts
 * <module-headers:end>
 */
import type { Device, DevicePage, DevicePatch, ErrorEnvelope, Meta } from "@yaran/protocol";
import { findForbiddenField, type PushMutes, type PushPlugin, type RegisterDeviceResult } from "@yaran/push";
import { assertNever, type OrgRowState } from "./pushPermission.ts";

/** Phase 15's `ApiResult` (D22): every Worker answer, as its native client reports it. */
export type ApiResult =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "api_error"; status: number; error: ErrorEnvelope }
  | { kind: "session_expired" }
  | { kind: "device_revoked" }
  | { kind: "offline" }
  | { kind: "tls_error" }
  | { kind: "refused" }
  | { kind: "protocol_unsupported" };

/** The slice of Phase 15's `Session` plugin push orchestration uses. */
export interface SessionApi {
  meta(options: { orgUrl: string }): Promise<Meta>;
  request(options: { orgId: string; method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; body?: unknown }): Promise<ApiResult>;
}

export interface PushDeps {
  push: PushPlugin;
  session: SessionApi;
}

export interface PushOrg {
  orgId: string;
  orgUrl: string;
  orgName: string;
  /** 02 `InstallId` from `Session.installId`. */
  installId: string;
  label: string;
  locale?: string;
  machines: { id: string; name: string }[];
}

export type ReconcileResult =
  | { kind: "row"; state: OrgRowState; device: Device | null }
  /** The org does not offer push (`push.webpush` missing): no row at all. */
  | { kind: "hidden" }
  /** `403 device_revoked`: this phone was removed; local push state is already gone. */
  | { kind: "revoked" };

const NO_MUTES: PushMutes = { mute_all: false, muted_until: null, muted_machine_ids: [] };

export function mutesOf(device: Device): PushMutes {
  return { mute_all: device.mute_all, muted_until: device.muted_until, muted_machine_ids: device.muted_machine_ids };
}

export function rowFromDevice(device: Device, now: number = Date.now()): OrgRowState {
  if (device.push.kind === "none") return { kind: "turned_off" };
  if (device.push_state === "failing") return { kind: "delivery_failing" };
  if (device.mute_all) return { kind: "muted", until: null };
  if (device.muted_until && Date.parse(device.muted_until) > now) return { kind: "muted", until: device.muted_until };
  return { kind: "active" };
}

/** Words for the native client's non-API failures. */
export function failureReason(kind: Exclude<ApiResult["kind"], "ok" | "api_error" | "device_revoked">): string {
  switch (kind) {
    case "session_expired":
      return "your session for this organization expired; sign in again";
    case "offline":
      return "this phone is offline";
    case "tls_error":
      return "the connection to the organization was not secure";
    case "refused":
      return "the app refused the request";
    case "protocol_unsupported":
      return "this app and the organization speak different protocol versions; update the app";
    default:
      return assertNever(kind);
  }
}

/** W13: the device row for this install (`current: true`), or why it could not be read. */
export async function currentDevice(deps: PushDeps, orgId: string): Promise<Device | null | "revoked" | { failure: string }> {
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const r = await deps.session.request({ orgId, method: "GET", path: `/v1/me/devices${query}` });
    switch (r.kind) {
      case "ok": {
        const body = r.body as DevicePage;
        const mine = body.items.find((d) => d.current);
        if (mine) return mine;
        cursor = body.next_cursor;
        if (!cursor) return null;
        break;
      }
      case "device_revoked":
        return "revoked";
      case "api_error":
        return { failure: r.error.error.code };
      case "session_expired":
      case "offline":
      case "tls_error":
      case "refused":
      case "protocol_unsupported":
        return { failure: failureReason(r.kind) };
      default:
        return assertNever(r);
    }
  }
  return null;
}

async function forget(deps: PushDeps, orgId: string): Promise<ReconcileResult> {
  await deps.push.forgetOrg({ orgId });
  return { kind: "revoked" };
}

/** Maps `Push.registerDevice`'s answer to a row, refusing any result that carries key material. */
async function fromRegistration(deps: PushDeps, orgId: string, r: RegisterDeviceResult): Promise<ReconcileResult> {
  const leaked = findForbiddenField(r);
  if (leaked) return { kind: "row", state: { kind: "registration_failed", reason: `native result carried ${leaked}` }, device: null };
  const row = (state: OrgRowState): ReconcileResult => ({ kind: "row", state, device: null });
  switch (r.outcome) {
    case "ok":
      await deps.push.setLocalMutes({ orgId, mutes: mutesOf(r.device) });
      return { kind: "row", state: rowFromDevice(r.device), device: r.device };
    case "device_revoked":
      return forget(deps, orgId);
    case "api_error":
      return row({ kind: "registration_failed", reason: r.code });
    case "session_expired":
    case "offline":
    case "tls_error":
    case "refused":
    case "protocol_unsupported":
      return row({ kind: "registration_failed", reason: failureReason(r.outcome) });
    case "needs_permission":
      return row({ kind: "needs_permission" });
    case "no_distributor":
      return row({ kind: "no_distributor" });
    case "push_unavailable":
      return row({ kind: "push_unavailable", reason: r.reason });
    case "registration_failed":
      return row({ kind: "registration_failed", reason: r.reason });
    default:
      return assertNever(r);
  }
}

/** Registers (or re-registers) this phone for one org. */
export async function registerOrg(deps: PushDeps, org: PushOrg, meta: Meta, mutes: PushMutes, pushOff = false): Promise<ReconcileResult> {
  const r = await deps.push.registerDevice({
    orgId: org.orgId,
    installId: org.installId,
    label: org.label,
    ...(org.locale ? { locale: org.locale } : {}),
    mutes,
    pushOff,
    vapidPublicKey: meta.push?.vapid_public_key ?? null,
  });
  return fromRegistration(deps, org.orgId, r);
}

/** Every foreground: compares the Worker's record with the native subscription. */
export async function reconcileOrg(deps: PushDeps, org: PushOrg, mutes: MuteSync): Promise<ReconcileResult> {
  let meta: Meta;
  try {
    meta = await deps.session.meta({ orgUrl: org.orgUrl });
  } catch {
    return { kind: "row", state: { kind: "registration_failed", reason: failureReason("offline") }, device: null };
  }
  if (!meta.capabilities?.includes("push.webpush")) return { kind: "hidden" };
  if (!meta.push?.enabled) return { kind: "row", state: { kind: "org_disabled" }, device: null };
  await deps.push.cacheMachineNames({ orgId: org.orgId, orgName: org.orgName, machines: org.machines });

  const listed = await currentDevice(deps, org.orgId);
  if (listed === "revoked") return forget(deps, org.orgId);
  if (listed !== null && "failure" in listed) {
    return { kind: "row", state: { kind: "registration_failed", reason: listed.failure }, device: null };
  }
  const device = listed;
  if (device?.push.kind === "none") return { kind: "row", state: { kind: "turned_off" }, device };
  if ((await deps.push.checkPermission()).notifications !== "granted") {
    return { kind: "row", state: { kind: "needs_permission" }, device };
  }
  const local = await deps.push.localState({ orgId: org.orgId });
  const vapid = meta.push.vapid_public_key;
  const stale =
    device === null ||
    device.push_state === "gone" ||
    device.push_state === "auth_failed" ||
    device.push.vapid_public_key !== vapid ||
    !local.subscribed ||
    local.vapidPublicKey !== vapid ||
    local.relayKeyCurrent === false ||
    (device.push.endpoint_host ?? null) !== local.endpointHost;
  if (stale) return registerOrg(deps, org, meta, device ? mutesOf(device) : NO_MUTES);

  const flushed = await mutes.flush(deps, org.orgId, device);
  if (flushed === "revoked") return forget(deps, org.orgId);
  const current = flushed !== null && typeof flushed === "object" ? flushed : device;
  await deps.push.setLocalMutes({ orgId: org.orgId, mutes: mutesOf(current) });
  return { kind: "row", state: rowFromDevice(current), device: current };
}

/** "Turn off notifications for this org": `{kind: none}` by upsert, keys deleted; the device stays. */
export async function turnOffOrg(deps: PushDeps, org: PushOrg, meta: Meta, device: Device | null): Promise<ReconcileResult> {
  return registerOrg(deps, org, meta, device ? mutesOf(device) : NO_MUTES, true);
}

/** Org removal (Phase 14's flow): W14, then the local push keys. */
export async function removeOrgPush(deps: PushDeps, orgId: string, deviceId: string | null): Promise<ApiResult | null> {
  const r = deviceId ? await deps.session.request({ orgId, method: "DELETE", path: `/v1/me/devices/${encodeURIComponent(deviceId)}` }) : null;
  await deps.push.forgetOrg({ orgId });
  return r;
}

/** Endpoint changes queued natively while the WebView was not running. */
export async function drainPending(deps: PushDeps, orgs: PushOrg[], mutes: MuteSync): Promise<Map<string, ReconcileResult>> {
  const { orgIds } = await deps.push.drainPendingRegistrations();
  const out = new Map<string, ReconcileResult>();
  for (const org of orgs) if (orgIds.includes(org.orgId)) out.set(org.orgId, await reconcileOrg(deps, org, mutes));
  return out;
}

export type MuteOutcome = "saved" | "offline" | "unchanged" | "revoked" | "failed" | "full";

/**
 * W31 mutes with a local mirror: the mirror is applied first so the phone enforces the mute
 * even offline, and an offline patch is retried by the next reconcile.
 * shortcut: the pending patch lives in memory, so a process death before reconnecting drops it
 * and the next reconcile mirrors the Worker again; persist it in 14's store if that bites.
 */
export class MuteSync {
  private pending = new Map<string, DevicePatch>();

  async apply(deps: PushDeps, orgId: string, device: Device, patch: DevicePatch): Promise<MuteOutcome | Device> {
    const { mute_all, muted_until, muted_machine_ids } = { ...mutesOf(device), ...patch };
    await deps.push.setLocalMutes({ orgId, mutes: { mute_all, muted_until, muted_machine_ids } });
    const r = await deps.session.request({ orgId, method: "PATCH", path: `/v1/me/devices/${encodeURIComponent(device.id)}`, body: patch });
    switch (r.kind) {
      case "ok": {
        this.pending.delete(orgId);
        const updated = r.body as Device;
        await deps.push.setLocalMutes({ orgId, mutes: mutesOf(updated) });
        return updated;
      }
      case "offline":
        this.pending.set(orgId, { ...this.pending.get(orgId), ...patch });
        return "offline";
      case "device_revoked":
        this.pending.delete(orgId);
        await deps.push.forgetOrg({ orgId });
        return "revoked";
      case "api_error":
      case "session_expired":
      case "tls_error":
      case "refused":
      case "protocol_unsupported":
        return "failed";
      default:
        return assertNever(r);
    }
  }

  /** Re-sends a patch saved offline; returns the updated device, or null when nothing was pending. */
  async flush(deps: PushDeps, orgId: string, device: Device): Promise<MuteOutcome | Device | null> {
    const patch = this.pending.get(orgId);
    return patch ? this.apply(deps, orgId, device, patch) : null;
  }

  hasPending(orgId: string): boolean {
    return this.pending.has(orgId);
  }
}

/** The "Mute this machine" action. */
export async function muteMachine(deps: PushDeps, sync: MuteSync, orgId: string, device: Device, machineId: string): Promise<MuteOutcome> {
  if (device.muted_machine_ids.includes(machineId)) return "unchanged";
  if (device.muted_machine_ids.length >= 100) return "full";
  const r = await sync.apply(deps, orgId, device, { muted_machine_ids: [...device.muted_machine_ids, machineId] });
  return typeof r === "object" ? "saved" : r;
}
